// preview_render.cpp — render the sample granule (RGB 7-2-1 + FVG overlays) to
// a PNG, using the very same portable compositing the app uses. Self-contained
// PNG writer (stored DEFLATE blocks), no external libraries.
//
//   g++ -std=c++17 -O2 tools/preview_render.cpp src/modis.cpp src/image.cpp -o preview
//   ./preview test/sample_MODIS_FVG.mgr docs/preview.png
#include "../src/modis.h"
#include "../src/image.h"
#include "../src/fvg_geo_data.h"
#include <cstdio>
#include <cstdint>
#include <vector>
#include <cmath>
#include <string>

// ---------- minimal PNG writer (RGB8, stored deflate) ----------------------
static uint32_t crcTable[256];
static void crcInit() {
    for (uint32_t n = 0; n < 256; ++n) {
        uint32_t c = n;
        for (int k = 0; k < 8; ++k) c = (c & 1) ? 0xEDB88320u ^ (c >> 1) : c >> 1;
        crcTable[n] = c;
    }
}
static uint32_t crc32(const uint8_t* d, size_t n, uint32_t c = 0xFFFFFFFFu) {
    for (size_t i = 0; i < n; ++i) c = crcTable[(c ^ d[i]) & 0xff] ^ (c >> 8);
    return c;
}
static uint32_t adler32(const uint8_t* d, size_t n) {
    uint32_t a = 1, b = 0;
    for (size_t i = 0; i < n; ++i) { a = (a + d[i]) % 65521; b = (b + a) % 65521; }
    return (b << 16) | a;
}
static void be32(std::vector<uint8_t>& v, uint32_t x) {
    v.push_back(x >> 24); v.push_back(x >> 16); v.push_back(x >> 8); v.push_back(x);
}
static void chunk(std::vector<uint8_t>& out, const char* type, const std::vector<uint8_t>& data) {
    be32(out, (uint32_t)data.size());
    size_t start = out.size();
    out.insert(out.end(), type, type + 4);
    out.insert(out.end(), data.begin(), data.end());
    uint32_t c = crc32(&out[start], out.size() - start);
    be32(out, c ^ 0xFFFFFFFFu);
}
static bool writePNG(const char* path, int w, int h, const std::vector<uint8_t>& rgb) {
    crcInit();
    // Raw scanlines with filter byte 0.
    std::vector<uint8_t> raw;
    raw.reserve((size_t)h * (w * 3 + 1));
    for (int y = 0; y < h; ++y) {
        raw.push_back(0);
        raw.insert(raw.end(), &rgb[(size_t)y * w * 3], &rgb[(size_t)y * w * 3] + w * 3);
    }
    // zlib stream: header + stored blocks + adler32.
    std::vector<uint8_t> z;
    z.push_back(0x78); z.push_back(0x01);
    size_t pos = 0;
    while (pos < raw.size()) {
        size_t n = std::min<size_t>(65535, raw.size() - pos);
        z.push_back(pos + n >= raw.size() ? 1 : 0); // BFINAL
        z.push_back(n & 0xff); z.push_back((n >> 8) & 0xff);
        z.push_back(~n & 0xff); z.push_back((~n >> 8) & 0xff);
        z.insert(z.end(), &raw[pos], &raw[pos] + n);
        pos += n;
    }
    uint32_t ad = adler32(raw.data(), raw.size());
    be32(z, ad);

    std::vector<uint8_t> out = { 0x89,'P','N','G',0x0D,0x0A,0x1A,0x0A };
    std::vector<uint8_t> ihdr;
    be32(ihdr, w); be32(ihdr, h);
    ihdr.push_back(8); ihdr.push_back(2); // 8-bit, colour type 2 (RGB)
    ihdr.push_back(0); ihdr.push_back(0); ihdr.push_back(0);
    chunk(out, "IHDR", ihdr);
    chunk(out, "IDAT", z);
    chunk(out, "IEND", {});

    std::FILE* f = std::fopen(path, "wb");
    if (!f) return false;
    std::fwrite(out.data(), 1, out.size(), f);
    std::fclose(f);
    return true;
}

// ---------- draw helpers on an RGB8 canvas ---------------------------------
struct Canvas {
    int w, h; std::vector<uint8_t> px;
    Canvas(int W, int H) : w(W), h(H), px((size_t)W * H * 3, 0) {}
    void set(int x, int y, uint8_t r, uint8_t g, uint8_t b) {
        if (x < 0 || y < 0 || x >= w || y >= h) return;
        size_t i = ((size_t)y * w + x) * 3; px[i] = r; px[i+1] = g; px[i+2] = b;
    }
    void line(int x0, int y0, int x1, int y1, uint8_t r, uint8_t g, uint8_t b) {
        int dx = std::abs(x1-x0), sx = x0<x1?1:-1;
        int dy = -std::abs(y1-y0), sy = y0<y1?1:-1, e = dx+dy;
        for (;;) { set(x0,y0,r,g,b); if (x0==x1 && y0==y1) break;
            int e2 = 2*e; if (e2>=dy){e+=dy;x0+=sx;} if (e2<=dx){e+=dx;y0+=sy;} }
    }
    void dot(int x, int y, int rad, uint8_t r, uint8_t g, uint8_t b) {
        for (int j=-rad;j<=rad;++j) for (int i=-rad;i<=rad;++i)
            if (i*i+j*j<=rad*rad) set(x+i,y+j,r,g,b);
    }
};

int main(int argc, char** argv) {
    const char* in  = argc > 1 ? argv[1] : "test/sample_MODIS_FVG.mgr";
    const char* out = argc > 2 ? argv[2] : "docs/preview.png";
    std::string err;
    modis::Granule g = modis::parseFile(in, &err);
    if (g.bands.empty()) { std::fprintf(stderr, "load failed: %s\n", err.c_str()); return 1; }

    img::Image im = img::renderTrueColor(g);  // natural true colour 1-4-3, calibrated
    if (im.empty()) { std::fprintf(stderr, "render failed\n"); return 1; }

    const int UP = 2;
    Canvas cv(im.w * UP, im.h * UP);
    for (int y = 0; y < im.h; ++y)
        for (int x = 0; x < im.w; ++x) {
            uint32_t p = im.at(x, y);
            uint8_t r = (p >> 16) & 0xff, gg = (p >> 8) & 0xff, b = p & 0xff;
            for (int j = 0; j < UP; ++j) for (int i = 0; i < UP; ++i)
                cv.set(x*UP+i, y*UP+j, r, gg, b);
        }

    auto toPix = [&](float lon, float lat, int& X, int& Y) {
        double fx = (lon - g.lonMin) / (g.lonMax - g.lonMin);
        double fy = (g.latMax - lat) / (g.latMax - g.latMin);
        X = (int)(fx * cv.w); Y = (int)(fy * cv.h);
    };
    auto poly = [&](const GeoPt* p, int n, uint8_t r, uint8_t gg, uint8_t b) {
        for (int i = 1; i < n; ++i) {
            int x0,y0,x1,y1; toPix(p[i-1].lon,p[i-1].lat,x0,y0); toPix(p[i].lon,p[i].lat,x1,y1);
            cv.line(x0,y0,x1,y1,r,gg,b);
        }
    };
    // Province borders (faint) then region outline (bright), then cities.
    poly(FVG_PROV_UD, FVG_PROV_UD_N, 180,180,190);
    poly(FVG_PROV_GO, FVG_PROV_GO_N, 180,180,190);
    poly(FVG_PROV_TS, FVG_PROV_TS_N, 180,180,190);
    poly(FVG_PROV_PN, FVG_PROV_PN_N, 180,180,190);
    poly(FVG_REGION,  FVG_REGION_N,  255,255,255);
    for (int i = 0; i < FVG_CITIES_N; ++i) {
        int X,Y; toPix(FVG_CITIES[i].lon, FVG_CITIES[i].lat, X, Y);
        cv.dot(X, Y, 5, 20,20,20); cv.dot(X, Y, 3, 255,210,60);
    }

    if (!writePNG(out, cv.w, cv.h, cv.px)) { std::fprintf(stderr, "write failed\n"); return 1; }
    std::printf("wrote %s (%dx%d)\n", out, cv.w, cv.h);
    return 0;
}
