// image.cpp — portable band compositing. See image.h.
#include "image.h"
#include <cmath>
#include <algorithm>

namespace img {

static inline double gammaCorrect(double t, double gamma) {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return std::pow(t, 1.0 / gamma);
}

// Nearest-neighbour sample of a band's normalized value at target fraction
// (fx,fy) in [0,1). Returns NaN on fill/no-data.
static double sampleNorm(const modis::Band& b, double fx, double fy) {
    int x = (int)(fx * b.width);
    int y = (int)(fy * b.height);
    if (x >= b.width)  x = b.width - 1;
    if (y >= b.height) y = b.height - 1;
    return b.normalized(x, y);
}

// Pick the target raster size: the largest band involved, so we keep the best
// available resolution and let coarser bands upsample.
static void targetSize(std::initializer_list<const modis::Band*> bands, int& tw, int& th) {
    tw = th = 0;
    for (auto* b : bands) if (b) { tw = std::max(tw, b->width); th = std::max(th, b->height); }
}

Image renderSingle(const modis::Granule& g, int bandNumber, cmap::Ramp ramp, double gamma) {
    Image im;
    const modis::Band* b = g.bandByNumber(bandNumber);
    if (!b) return im;
    targetSize({ b }, im.w, im.h);
    if (im.w == 0 || im.h == 0) return im;
    im.px.resize((size_t)im.w * im.h);
    for (int y = 0; y < im.h; ++y) {
        double fy = (y + 0.5) / im.h;
        for (int x = 0; x < im.w; ++x) {
            double fx = (x + 0.5) / im.w;
            double t = sampleNorm(*b, fx, fy);
            if (std::isnan(t)) { im.px[(size_t)y * im.w + x] = NODATA; continue; }
            cmap::RGB c = cmap::apply(ramp, gammaCorrect(t, gamma));
            im.px[(size_t)y * im.w + x] = packARGB(c.r, c.g, c.b);
        }
    }
    return im;
}

// NASA MODIS "Rapid Response" true-colour enhancement, expressed on absolute
// reflectance in [0,1]. Brightens the dark land end and rolls bright cloud/snow
// toward white, giving a natural, well-calibrated look. Piecewise linear on
// published-style control points.
static double enhance(double refl) {
    static const double x[] = { 0.000, 0.010, 0.040, 0.100, 0.180, 0.300, 0.500, 1.000 };
    static const double y[] = { 0.000, 0.120, 0.290, 0.460, 0.680, 0.860, 0.960, 1.000 };
    if (refl <= 0) return 0;
    if (refl >= 1) return 1;
    for (int i = 1; i < 8; ++i)
        if (refl <= x[i]) {
            double u = (refl - x[i - 1]) / (x[i] - x[i - 1]);
            return y[i - 1] + u * (y[i] - y[i - 1]);
        }
    return 1;
}

// Sample one channel in ABSOLUTE calibrated units: reflectance -> enhance();
// other kinds fall back to a per-band normalized stretch. NaN on fill.
static double sampleChannel(const modis::Band& b, double fx, double fy) {
    int x = (int)(fx * b.width);  if (x >= b.width)  x = b.width - 1;
    int y = (int)(fy * b.height); if (y >= b.height) y = b.height - 1;
    if (!b.valid(x, y)) return std::numeric_limits<double>::quiet_NaN();
    if (b.kind == modis::Kind::Reflectance) {
        double r = b.at(x, y);
        if (r < 0) r = 0; if (r > 1) r = 1;
        return enhance(r);
    }
    return b.normalized(x, y);
}

Image renderRGB(const modis::Granule& g, int rBand, int gBand, int bBand) {
    Image im;
    const modis::Band* R = g.bandByNumber(rBand);
    const modis::Band* G = g.bandByNumber(gBand);
    const modis::Band* B = g.bandByNumber(bBand);
    if (!R || !G || !B) return im;
    targetSize({ R, G, B }, im.w, im.h);
    if (im.w == 0 || im.h == 0) return im;
    im.px.resize((size_t)im.w * im.h);
    for (int y = 0; y < im.h; ++y) {
        double fy = (y + 0.5) / im.h;
        for (int x = 0; x < im.w; ++x) {
            double fx = (x + 0.5) / im.w;
            double tr = sampleChannel(*R, fx, fy);
            double tg = sampleChannel(*G, fx, fy);
            double tb = sampleChannel(*B, fx, fy);
            if (std::isnan(tr) || std::isnan(tg) || std::isnan(tb)) {
                im.px[(size_t)y * im.w + x] = NODATA; continue;
            }
            auto ch = [&](double t) { return (uint8_t)std::lround((t < 0 ? 0 : t > 1 ? 1 : t) * 255); };
            im.px[(size_t)y * im.w + x] = packARGB(ch(tr), ch(tg), ch(tb));
        }
    }
    return im;
}

Image renderTrueColor(const modis::Granule& g) { return renderRGB(g, 1, 4, 3); }

Image difference(const Image& a, const Image& b) {
    Image im;
    if (a.empty() || b.empty() || a.w != b.w || a.h != b.h) return im;
    im.w = a.w; im.h = a.h; im.px.resize((size_t)im.w * im.h);
    for (size_t i = 0; i < im.px.size(); ++i) {
        uint32_t pa = a.px[i], pb = b.px[i];
        if (pa == NODATA || pb == NODATA) { im.px[i] = NODATA; continue; }
        int dr = std::abs((int)((pa >> 16) & 0xff) - (int)((pb >> 16) & 0xff));
        int dg = std::abs((int)((pa >> 8) & 0xff) - (int)((pb >> 8) & 0xff));
        int db = std::abs((int)(pa & 0xff) - (int)(pb & 0xff));
        // Amplify small differences so they read; keep the hue of the change.
        auto amp = [](int d) { int v = (int)std::lround(std::min(1.0, d / 255.0 * 2.4) * 255); return (uint8_t)v; };
        im.px[i] = packARGB(amp(dr), amp(dg), amp(db));
    }
    return im;
}

Image sharpen(const Image& src, double amount, int radius) {
    Image im = src;
    if (src.empty() || amount <= 0.0 || radius < 1) return im;

    // Box blur, separable, skipping NODATA so swath gaps don't bleed inwards.
    const int w = src.w, h = src.h;
    std::vector<float> br((size_t)w * h * 3, 0.f);
    std::vector<float> tmp((size_t)w * h * 3, 0.f);
    auto chan = [](uint32_t p, int c) { return (float)((p >> (16 - 8 * c)) & 0xff); };

    for (int y = 0; y < h; ++y) {                       // horizontal pass
        for (int x = 0; x < w; ++x) {
            float acc[3] = {0, 0, 0}; int n = 0;
            for (int d = -radius; d <= radius; ++d) {
                int sx = x + d; if (sx < 0 || sx >= w) continue;
                uint32_t p = src.px[(size_t)y * w + sx];
                if (p == NODATA) continue;
                for (int c = 0; c < 3; ++c) acc[c] += chan(p, c);
                ++n;
            }
            size_t o = ((size_t)y * w + x) * 3;
            for (int c = 0; c < 3; ++c) tmp[o + c] = n ? acc[c] / n : 0.f;
        }
    }
    for (int y = 0; y < h; ++y) {                       // vertical pass
        for (int x = 0; x < w; ++x) {
            float acc[3] = {0, 0, 0}; int n = 0;
            for (int d = -radius; d <= radius; ++d) {
                int sy = y + d; if (sy < 0 || sy >= h) continue;
                if (src.px[(size_t)sy * w + x] == NODATA) continue;
                size_t o = ((size_t)sy * w + x) * 3;
                for (int c = 0; c < 3; ++c) acc[c] += tmp[o + c];
                ++n;
            }
            size_t o = ((size_t)y * w + x) * 3;
            for (int c = 0; c < 3; ++c) br[o + c] = n ? acc[c] / n : 0.f;
        }
    }

    for (size_t i = 0; i < im.px.size(); ++i) {
        uint32_t p = src.px[i];
        if (p == NODATA) continue;
        uint8_t out[3];
        for (int c = 0; c < 3; ++c) {
            double v = chan(p, c) + amount * (chan(p, c) - br[i * 3 + c]);
            out[c] = (uint8_t)std::lround(std::max(0.0, std::min(255.0, v)));
        }
        im.px[i] = packARGB(out[0], out[1], out[2]);
    }
    return im;
}

} // namespace img
