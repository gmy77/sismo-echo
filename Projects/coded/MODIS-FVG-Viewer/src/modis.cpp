// modis.cpp — decoder for the MFVG simplified granule container.
// Portable C++17, no OS headers. See modis.h and docs/MFVG-FORMAT.md.
#include "modis.h"
#include <cstdio>
#include <cstring>
#include <algorithm>
#include <limits>

namespace modis {

// ---- little-endian byte reader -------------------------------------------
namespace {
struct Reader {
    const uint8_t* p;
    const uint8_t* end;
    bool ok = true;

    Reader(const uint8_t* d, size_t n) : p(d), end(d + n) {}

    bool need(size_t n) { if ((size_t)(end - p) < n) { ok = false; return false; } return true; }

    uint8_t  u8()  { if (!need(1)) return 0; return *p++; }
    uint16_t u16() { if (!need(2)) return 0; uint16_t v = p[0] | (p[1] << 8); p += 2; return v; }
    int16_t  i16() { return (int16_t)u16(); }
    uint32_t u32() { if (!need(4)) return 0; uint32_t v = (uint32_t)p[0] | (p[1] << 8) | (p[2] << 16) | ((uint32_t)p[3] << 24); p += 4; return v; }
    int32_t  i32() { return (int32_t)u32(); }
    double   f64() {
        if (!need(8)) return 0.0;
        uint64_t v = 0;
        for (int i = 0; i < 8; ++i) v |= (uint64_t)p[i] << (8 * i);
        p += 8;
        double d; std::memcpy(&d, &v, 8); return d;
    }
    std::string str() { // uint8 length prefix
        uint8_t n = u8();
        if (!need(n)) return {};
        std::string s((const char*)p, n); p += n; return s;
    }
};
} // namespace

// ---- Band ----------------------------------------------------------------
bool Band::valid(int x, int y) const {
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
    return dn[(size_t)y * width + x] != fill;
}
double Band::at(int x, int y) const {
    if (!valid(x, y)) return std::numeric_limits<double>::quiet_NaN();
    return scale * ((double)dn[(size_t)y * width + x] - offset);
}
double Band::normalized(int x, int y) const {
    double v = at(x, y);
    if (std::isnan(v)) return v;
    double span = physMax - physMin;
    if (span < 1e-12) return 0.0;
    double t = (v - physMin) / span;
    return t < 0 ? 0 : (t > 1 ? 1 : t);
}

// ---- Granule -------------------------------------------------------------
std::string Granule::timeText() const {
    char b[40];
    std::snprintf(b, sizeof b, "%04d-%02d-%02d %02d:%02d UTC", year, month, day, hour, minute);
    return b;
}
std::string Granule::sortKey() const {
    char b[24];
    std::snprintf(b, sizeof b, "%04d%02d%02dT%02d%02d%02d", year, month, day, hour, minute, second);
    return b;
}
const Band* Granule::bandByNumber(int n) const {
    for (auto& b : bands) if (b.number == n) return &b;
    return nullptr;
}

// Row 0 is the northernmost line, col 0 the westernmost — the natural raster
// order. Pixel centres map to the middle of each cell.
void Granule::lonlatOfPixel(const Band& b, double px, double py, double& lon, double& lat) const {
    double fx = b.width  > 0 ? (px + 0.5) / b.width  : 0.5;
    double fy = b.height > 0 ? (py + 0.5) / b.height : 0.5;
    lon = lonMin + fx * (lonMax - lonMin);
    lat = latMax - fy * (latMax - latMin); // y grows southward
}
bool Granule::pixelOfLonLat(const Band& b, double lon, double lat, double& px, double& py) const {
    if (lonMax - lonMin < 1e-12 || latMax - latMin < 1e-12) return false;
    double fx = (lon - lonMin) / (lonMax - lonMin);
    double fy = (latMax - lat) / (latMax - latMin);
    px = fx * b.width  - 0.5;
    py = fy * b.height - 0.5;
    return lon >= lonMin && lon <= lonMax && lat >= latMin && lat <= latMax;
}

bool Granule::intersectsFVG() const {
    return !(lonMax < FVG_LON_MIN || lonMin > FVG_LON_MAX ||
             latMax < FVG_LAT_MIN || latMin > FVG_LAT_MAX);
}

// ---- parse ---------------------------------------------------------------
static void fail(std::string* err, const char* m) { if (err) *err = m; }

Granule parse(const uint8_t* data, size_t len, std::string* err) {
    Granule g;
    if (err) err->clear();
    Reader r(data, len);

    // Magic "MFVG" + version + reserved.
    if (!r.need(6) || std::memcmp(r.p, "MFVG", 4) != 0) { fail(err, "firma MFVG non valida"); return {}; }
    r.p += 4;
    uint8_t ver = r.u8(); r.u8();
    if (ver != 1) { fail(err, "versione MFVG non supportata"); return {}; }

    uint8_t sat  = r.u8();
    uint8_t prod = r.u8();
    g.satellite  = (sat == 1) ? "Aqua" : "Terra";
    static const char* PRODS[] = { "MOD021KM", "MYD021KM", "MOD09", "MOD11" };
    g.product    = (prod < 4) ? PRODS[prod] : "MODIS";

    g.year   = r.i16();
    g.month  = r.u8();
    g.day    = r.u8();
    g.hour   = r.u8();
    g.minute = r.u8();
    g.second = r.u8();
    r.u8(); // pad

    g.latMin = r.f64();
    g.latMax = r.f64();
    g.lonMin = r.f64();
    g.lonMax = r.f64();

    uint16_t nBands = r.u16();
    r.u16(); // pad
    if (!r.ok) { fail(err, "header troncato"); return {}; }
    if (nBands == 0 || nBands > 64) { fail(err, "numero bande implausibile"); return {}; }

    g.bands.reserve(nBands);
    for (uint16_t bi = 0; bi < nBands; ++bi) {
        Band b;
        b.number     = r.i16();
        b.name       = r.str();
        b.resolution = r.i32();
        b.kind       = (Kind)r.u8();
        b.unit       = r.str();
        b.scale      = r.f64();
        b.offset     = r.f64();
        b.fill       = r.u16();
        b.width      = r.i32();
        b.height     = r.i32();
        if (!r.ok) { fail(err, "record banda troncato"); return {}; }
        if (b.width <= 0 || b.height <= 0 || (long long)b.width * b.height > 200LL * 1000 * 1000) {
            fail(err, "dimensioni banda implausibili"); return {};
        }
        size_t n = (size_t)b.width * b.height;
        if (!r.need(n * 2)) { fail(err, "dati banda troncati"); return {}; }
        b.dn.resize(n);
        for (size_t i = 0; i < n; ++i) b.dn[i] = r.u16();

        // Physical range over valid pixels.
        double lo = std::numeric_limits<double>::infinity();
        double hi = -std::numeric_limits<double>::infinity();
        for (size_t i = 0; i < n; ++i) {
            if (b.dn[i] == b.fill) continue;
            double v = b.scale * ((double)b.dn[i] - b.offset);
            lo = std::min(lo, v); hi = std::max(hi, v);
        }
        if (lo > hi) { lo = hi = 0; } // all-fill band
        b.physMin = lo; b.physMax = hi;
        g.bands.push_back(std::move(b));
    }

    if (g.bands.empty()) { fail(err, "nessuna banda decodificata"); return {}; }
    return g;
}

Granule parseFile(const std::string& path, std::string* err) {
    std::FILE* f = std::fopen(path.c_str(), "rb");
    if (!f) { fail(err, "impossibile aprire il file"); return {}; }
    std::fseek(f, 0, SEEK_END);
    long sz = std::ftell(f);
    std::fseek(f, 0, SEEK_SET);
    if (sz <= 0) { std::fclose(f); fail(err, "file vuoto"); return {}; }
    std::vector<uint8_t> buf((size_t)sz);
    size_t got = std::fread(buf.data(), 1, (size_t)sz, f);
    std::fclose(f);
    if (got != (size_t)sz) { fail(err, "lettura file incompleta"); return {}; }
    Granule g = parse(buf.data(), buf.size(), err);
    g.path = path;
    return g;
}

} // namespace modis
