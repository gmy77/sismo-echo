// Copyright (c) 2026 Gimmy Pignolo. Tutti i diritti riservati.
// MODIS-FVG Viewer 1.0.3 - vedi LICENSE nella radice del repository.
// image.cpp — portable band compositing. See image.h.
#include "image.h"
#include <cmath>
#include <algorithm>
#include <utility>

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

Image composite(const Image& base, const Image& over) {
    if (base.empty()) return over;
    if (over.empty() || over.w != base.w || over.h != base.h) return base;
    Image im = base;
    for (size_t i = 0; i < im.px.size(); ++i)
        if (over.px[i] != NODATA) im.px[i] = over.px[i];
    return im;
}

Image mutedClouds(const Image& src, double strength) {
    Image im = src;
    if (src.empty() || strength <= 0) return im;
    if (strength > 1) strength = 1;
    for (size_t i = 0; i < im.px.size(); ++i) {
        uint32_t p = src.px[i];
        if (p == NODATA) continue;
        double r = ((p >> 16) & 0xff) / 255.0;
        double g = ((p >> 8) & 0xff) / 255.0;
        double b = (p & 0xff) / 255.0;
        double hi = std::max(r, std::max(g, b)), lo = std::min(r, std::min(g, b));
        double lum = 0.299 * r + 0.587 * g + 0.114 * b;
        double sat = hi - lo;                       // dominante di colore
        // Chiaro e senza dominante = nuvola. Le due soglie sfumano invece di
        // scattare, cosi' il bordo di una nube non diventa un gradino netto.
        double isCloud = std::min(1.0, std::max(0.0, (lum - 0.55) / 0.20))
                       * std::min(1.0, std::max(0.0, (0.16 - sat) / 0.10));
        if (isCloud <= 0) continue;
        double k = isCloud * strength;
        double grey = 0.30 + 0.45 * lum;            // grigio piatto, un po' di texture
        auto mix = [&](double c) {
            double v = c * (1 - k) + grey * k;
            return (uint8_t)std::lround(std::max(0.0, std::min(1.0, v)) * 255);
        };
        im.px[i] = packARGB(mix(r), mix(g), mix(b));
    }
    return im;
}

double coverage(const Image& im) {
    if (im.empty()) return 0.0;
    size_t seen = 0;
    for (uint32_t p : im.px) if (p != NODATA) ++seen;
    return (double)seen / (double)im.px.size();
}

double meanLuma(const Image& im) {
    if (im.empty()) return 0.0;
    double acc = 0.0; size_t n = 0;
    for (uint32_t p : im.px) {
        if (p == NODATA) continue;
        double r = ((p >> 16) & 0xff) / 255.0;
        double g = ((p >> 8) & 0xff) / 255.0;
        double b = (p & 0xff) / 255.0;
        acc += 0.299 * r + 0.587 * g + 0.114 * b;
        ++n;
    }
    return n ? acc / n : 0.0;
}

std::vector<Blob> clusters(const Image& layer, int minPixels, int maxBlobs) {
    std::vector<Blob> out;
    if (layer.empty()) return out;
    const int w = layer.w, h = layer.h;
    std::vector<uint8_t> visited((size_t)w * h, 0);
    std::vector<std::pair<int, int>> stack;

    for (int y0 = 0; y0 < h; ++y0) {
        for (int x0 = 0; x0 < w; ++x0) {
            size_t i0 = (size_t)y0 * w + x0;
            if (visited[i0] || layer.px[i0] == NODATA) continue;

            // Flood fill 8-connesso della macchia che parte da qui.
            Blob b; b.x0 = b.x1 = x0; b.y0 = b.y1 = y0;
            double sx = 0, sy = 0; int n = 0;
            stack.clear(); stack.push_back({ x0, y0 }); visited[i0] = 1;
            while (!stack.empty()) {
                int x = stack.back().first, y = stack.back().second;
                stack.pop_back();
                sx += x; sy += y; ++n;
                if (x < b.x0) b.x0 = x; if (x > b.x1) b.x1 = x;
                if (y < b.y0) b.y0 = y; if (y > b.y1) b.y1 = y;
                for (int dy = -1; dy <= 1; ++dy)
                    for (int dx = -1; dx <= 1; ++dx) {
                        if (!dx && !dy) continue;
                        int nx = x + dx, ny = y + dy;
                        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
                        size_t ni = (size_t)ny * w + nx;
                        if (visited[ni] || layer.px[ni] == NODATA) continue;
                        visited[ni] = 1;
                        stack.push_back({ nx, ny });
                    }
            }
            if (n < minPixels) continue;             // rumore isolato: scartato
            b.n = n; b.cx = sx / n; b.cy = sy / n;
            out.push_back(b);
        }
    }
    std::sort(out.begin(), out.end(), [](const Blob& a, const Blob& c) { return a.n > c.n; });
    if ((int)out.size() > maxBlobs) out.resize(maxBlobs);
    return out;
}

Image fillGaps(const Image& primary, const Image& secondary) {
    if (secondary.empty() || secondary.w != primary.w || secondary.h != primary.h)
        return primary;
    const int w = primary.w, h = primary.h;
    Image out = primary;
    std::vector<uint8_t> fromSecondary((size_t)w * h, 0);
    for (size_t i = 0; i < out.px.size(); ++i)
        if (out.px[i] == NODATA && secondary.px[i] != NODATA) {
            out.px[i] = secondary.px[i];
            fromSecondary[i] = 1;
        }

    // Marca la cucitura fra le due fonti: un pixel adiacente (4-connesso) a
    // uno di provenienza diversa si mescola coi vicini "dall'altra parte",
    // cosi' il confine si legge invece di sembrare un taglio netto o un dato
    // inventato lontano dal bordo vero.
    auto originAt = [&](int x, int y) -> int {        // -1 = fuori mappa o no-data
        if (x < 0 || x >= w || y < 0 || y >= h) return -1;
        size_t i = (size_t)y * w + x;
        if (out.px[i] == NODATA) return -1;
        return fromSecondary[i];
    };
    static const int dx[4] = { -1, 1, 0, 0 }, dy[4] = { 0, 0, -1, 1 };
    Image seamed = out;
    for (int y = 0; y < h; ++y) {
        for (int x = 0; x < w; ++x) {
            size_t i = (size_t)y * w + x;
            if (out.px[i] == NODATA) continue;
            int here = fromSecondary[i];
            uint32_t sumR = 0, sumG = 0, sumB = 0; int nOther = 0;
            for (int k = 0; k < 4; ++k) {
                int o = originAt(x + dx[k], y + dy[k]);
                if (o < 0 || o == here) continue;
                size_t ni = (size_t)(y + dy[k]) * w + (x + dx[k]);
                uint32_t p = out.px[ni];
                sumR += (p >> 16) & 0xff; sumG += (p >> 8) & 0xff; sumB += p & 0xff;
                ++nOther;
            }
            if (!nOther) continue;
            uint32_t p = out.px[i];
            double r = (p >> 16) & 0xff, g = (p >> 8) & 0xff, b = p & 0xff;
            double or_ = (double)sumR / nOther, og = (double)sumG / nOther, ob = (double)sumB / nOther;
            auto blend = [](double a, double c) { return (uint8_t)std::lround((a + c) / 2.0); };
            seamed.px[i] = packARGB(blend(r, or_), blend(g, og), blend(b, ob));
        }
    }
    return seamed;
}

} // namespace img
