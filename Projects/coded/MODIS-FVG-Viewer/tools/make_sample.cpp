// make_sample.cpp — generate the bundled MFVG test granule.
//
// Produces a synthetic-but-plausible MODIS MOD021KM-style granule cropped to
// the Friuli Venezia Giulia bbox, with several bands at mixed resolutions
// (250 m / 500 m / 1 km), MODIS-style scaled-integer storage, a fill/no-data
// stripe and a cloud band — enough to exercise band selection, RGB false
// colour, the thermal palette and the "missing data" path in the viewer.
//
// Build & run (any platform):
//   g++ -std=c++17 -O2 tools/make_sample.cpp -o make_sample
//   ./make_sample test/sample_MODIS_FVG.mgr
//
// The output is committed to the repo so building the app never requires
// running this generator; it exists to document the format and let anyone
// regenerate the sample. Byte layout: see docs/MFVG-FORMAT.md.
#include <cstdio>
#include <cstdint>
#include <cstring>
#include <cmath>
#include <string>
#include <vector>

// ---- little-endian writer (mirrors modis.cpp's reader) -------------------
struct Writer {
    std::vector<uint8_t> b;
    void u8(uint8_t v)  { b.push_back(v); }
    void u16(uint16_t v){ b.push_back(v & 0xff); b.push_back((v >> 8) & 0xff); }
    void i16(int16_t v) { u16((uint16_t)v); }
    void u32(uint32_t v){ for (int i = 0; i < 4; ++i) b.push_back((v >> (8*i)) & 0xff); }
    void i32(int32_t v) { u32((uint32_t)v); }
    void f64(double d)  { uint64_t v; std::memcpy(&v, &d, 8); for (int i = 0; i < 8; ++i) b.push_back((v >> (8*i)) & 0xff); }
    void str(const std::string& s) { u8((uint8_t)s.size()); for (char c : s) b.push_back((uint8_t)c); }
    void raw16(const std::vector<uint16_t>& v) { for (uint16_t x : v) u16(x); }
};

// FVG bbox (the crop footprint of this granule).
static const double LATMIN = 45.5, LATMAX = 46.7, LONMIN = 12.3, LONMAX = 13.9;

// Cloud drift (degrees), set per frame so a generated sequence animates.
static double g_cloudShift = 0.0;

// Smooth pseudo-terrain texture, deterministic.
static double tex(double lon, double lat, double f, double ph) {
    return 0.5 + 0.5 * std::sin(lon * f + ph) * std::cos(lat * f * 1.3 + ph * 0.7);
}

// Land-cover classification from geography, returns per-band reflectance and
// a surface temperature (K). Bands: red(1), nir(2), blue(3), green(4),
// swir6(6), swir7(7).
struct Sample { double red, nir, blue, green, swir6, swir7, tempK; bool fill; };

static Sample scene(double lon, double lat) {
    Sample s{};
    s.fill = false;

    // A no-data stripe near the western edge — simulates a swath gap.
    if (lon > 12.55 && lon < 12.62) { s.fill = true; return s; }

    // Diagonal cloud band across the centre-north (drifts per frame).
    double cloud = lat - (46.05 + g_cloudShift) - 0.7 * (lon - 13.1);
    bool isCloud = std::fabs(cloud) < 0.06 + 0.03 * tex(lon, lat, 40, 1.0);

    // Adriatic sea: SE lowland below a coastline that rises to the NE.
    double coast = 45.66 + 0.10 * (lon - 13.2);
    bool isSea = lat < coast && lon > 13.2;
    // Lagoon / Grado area to the SW of Trieste.
    if (lat < 45.72 && lon > 13.0 && lon < 13.45) isSea = true;

    // Elevation proxy: rises to the north (Alps/Prealps), plus ridges.
    double elev = (lat - 45.9) * 1.6 + 0.4 * tex(lon, lat, 9, 0.3);
    if (elev < 0) elev = 0;

    double n = tex(lon, lat, 22, 2.1); // fine texture 0..1

    if (isCloud) {
        s.red = 0.78 + 0.1 * n; s.nir = 0.80 + 0.08 * n;
        s.blue = 0.82; s.green = 0.80;
        s.swir6 = 0.42; s.swir7 = 0.38;
        s.tempK = 249 + 6 * n;
        return s;
    }
    if (isSea) {
        s.red = 0.028 + 0.01 * n; s.nir = 0.018;
        s.blue = 0.055; s.green = 0.040;
        s.swir6 = 0.010; s.swir7 = 0.008;
        s.tempK = 300.5 + 1.2 * n;
        return s;
    }
    if (elev > 0.55) { // high mountains: rock + patchy snow
        double snow = (elev - 0.55) * 1.5 + 0.3 * n;
        if (snow > 1) snow = 1;
        s.red   = 0.12 + 0.55 * snow;
        s.nir   = 0.16 + 0.40 * snow;
        s.blue  = 0.14 + 0.62 * snow;
        s.green = 0.13 + 0.58 * snow;
        s.swir6 = 0.28 * (1 - snow) + 0.04 * snow; // snow is dark in SWIR
        s.swir7 = 0.24 * (1 - snow) + 0.03 * snow;
        s.tempK = 288 - 18 * elev - 4 * snow + 2 * n;
        return s;
    }
    if (elev > 0.20) { // forested hills / Prealps
        s.red = 0.040 + 0.02 * n; s.nir = 0.30 + 0.06 * n;
        s.blue = 0.035; s.green = 0.060 + 0.02 * n;
        s.swir6 = 0.16; s.swir7 = 0.10;
        s.tempK = 298 - 8 * elev + 3 * n;
        return s;
    }
    // Plain: agriculture/vegetation with scattered urban (Udine/Pordenone).
    double urban = (tex(lon, lat, 60, 4.0) > 0.82) ? 1.0 : 0.0;
    s.red   = urban ? 0.15 : 0.055 + 0.03 * n;
    s.nir   = urban ? 0.20 : 0.34 + 0.08 * n;
    s.blue  = urban ? 0.12 : 0.030;
    s.green = urban ? 0.14 : 0.070 + 0.02 * n;
    s.swir6 = urban ? 0.26 : 0.19;
    s.swir7 = urban ? 0.22 : 0.12;
    s.tempK = (urban ? 308 : 305) + 2 * n;
    return s;
}

// Reflectance -> DN with MODIS-like scaling (scale 5e-5, offset 0).
static const double REFL_SCALE = 5.0e-5;
static const double TEMP_SCALE = 0.02;
static const uint16_t FILL = 65535;

static uint16_t reflDN(double r) {
    if (r < 0) r = 0; if (r > 1.3) r = 1.3;
    double dn = r / REFL_SCALE;
    if (dn > 64000) dn = 64000;
    return (uint16_t)(dn + 0.5);
}
static uint16_t tempDN(double k) {
    double dn = k / TEMP_SCALE; // ~250..310 K -> 12500..15500
    if (dn < 0) dn = 0; if (dn > 64000) dn = 64000;
    return (uint16_t)(dn + 0.5);
}

// Selector picks which channel of the scene a band represents.
enum Chan { RED, NIR, BLUE, GREEN, SWIR6, SWIR7, TEMP };

static std::vector<uint16_t> render(int w, int h, Chan ch) {
    std::vector<uint16_t> out((size_t)w * h);
    for (int y = 0; y < h; ++y) {
        double lat = LATMAX - (y + 0.5) / h * (LATMAX - LATMIN);
        for (int x = 0; x < w; ++x) {
            double lon = LONMIN + (x + 0.5) / w * (LONMAX - LONMIN);
            Sample s = scene(lon, lat);
            uint16_t dn;
            if (s.fill) dn = FILL;
            else switch (ch) {
                case RED:   dn = reflDN(s.red);   break;
                case NIR:   dn = reflDN(s.nir);   break;
                case BLUE:  dn = reflDN(s.blue);  break;
                case GREEN: dn = reflDN(s.green); break;
                case SWIR6: dn = reflDN(s.swir6); break;
                case SWIR7: dn = reflDN(s.swir7); break;
                case TEMP:  dn = tempDN(s.tempK); break;
                default:    dn = FILL;
            }
            out[(size_t)y * w + x] = dn;
        }
    }
    return out;
}

struct BandSpec { int number; const char* name; int res; uint8_t kind; const char* unit;
                  double scale; int w, h; Chan ch; };

int main(int argc, char** argv) {
    const char* out = argc > 1 ? argv[1] : "sample_MODIS_FVG.mgr";
    // Optional: HHMM acquisition time and cloud drift (deg) to build a sequence.
    int hhmm = argc > 2 ? std::atoi(argv[2]) : 1015;
    if (argc > 3) g_cloudShift = std::atof(argv[3]);
    int hour = hhmm / 100, minute = hhmm % 100;

    // Mixed native resolutions, MODIS band identities.
    const BandSpec specs[] = {
        { 1, "Band 1 (620-670 nm, rosso)",   250, 0, "reflectance", REFL_SCALE, 384, 288, RED   },
        { 2, "Band 2 (841-876 nm, NIR)",     250, 0, "reflectance", REFL_SCALE, 384, 288, NIR   },
        { 3, "Band 3 (459-479 nm, blu)",     500, 0, "reflectance", REFL_SCALE, 192, 144, BLUE  },
        { 4, "Band 4 (545-565 nm, verde)",   500, 0, "reflectance", REFL_SCALE, 192, 144, GREEN },
        { 6, "Band 6 (1628-1652 nm, SWIR)",  500, 0, "reflectance", REFL_SCALE, 192, 144, SWIR6 },
        { 7, "Band 7 (2105-2155 nm, SWIR)",  500, 0, "reflectance", REFL_SCALE, 192, 144, SWIR7 },
        {31, "Band 31 (11 um, LST)",        1000, 2, "K",           TEMP_SCALE,  96,  72, TEMP  },
    };
    const int nB = (int)(sizeof specs / sizeof specs[0]);

    Writer w;
    w.b.push_back('M'); w.b.push_back('F'); w.b.push_back('V'); w.b.push_back('G');
    w.u8(1);   // version
    w.u8(0);   // reserved
    w.u8(0);   // satellite: 0 = Terra (MOD*)
    w.u8(0);   // product:   0 = MOD021KM
    w.i16(2026);
    w.u8(8); w.u8(21);      // 2026-08-21
    w.u8((uint8_t)hour); w.u8((uint8_t)minute); w.u8(0); // HH:MM:00 UTC
    w.u8(0);               // pad
    w.f64(LATMIN); w.f64(LATMAX); w.f64(LONMIN); w.f64(LONMAX);
    w.u16((uint16_t)nB);
    w.u16(0);              // pad

    for (const auto& s : specs) {
        w.i16((int16_t)s.number);
        w.str(s.name);
        w.i32(s.res);
        w.u8(s.kind);
        w.str(s.unit);
        w.f64(s.scale);
        w.f64(0.0);        // offset
        w.u16(FILL);
        w.i32(s.w);
        w.i32(s.h);
        w.raw16(render(s.w, s.h, s.ch));
    }

    std::FILE* f = std::fopen(out, "wb");
    if (!f) { std::fprintf(stderr, "cannot write %s\n", out); return 1; }
    std::fwrite(w.b.data(), 1, w.b.size(), f);
    std::fclose(f);
    std::printf("wrote %s (%zu bytes, %d bands)\n", out, w.b.size(), nB);
    return 0;
}
