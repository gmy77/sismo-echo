// test_modis.cpp — portable sanity test for the MODIS (MFVG) reader.
// Runs on any platform:
//   g++ -std=c++17 ../src/modis.cpp test_modis.cpp -o t && ./t sample_MODIS_FVG.mgr
#include "../src/modis.h"
#include <cstdio>
#include <cmath>

static int fails = 0;
static void check(bool ok, const char* msg) {
    std::printf("  [%s] %s\n", ok ? "OK" : "FAIL", msg);
    if (!ok) ++fails;
}

int main(int argc, char** argv) {
    const char* path = argc > 1 ? argv[1] : "sample_MODIS_FVG.mgr";
    std::string err;
    modis::Granule g = modis::parseFile(path, &err);
    std::printf("Granule '%s' from %s (err='%s')\n", g.product.c_str(), path, err.c_str());
    std::printf("  sat=%s  time=%s  bbox lat[%.2f..%.2f] lon[%.2f..%.2f]  bande=%zu\n",
                g.satellite.c_str(), g.timeText().c_str(),
                g.latMin, g.latMax, g.lonMin, g.lonMax, g.bands.size());

    check(!g.bands.empty(), "granulo decodificato");
    check(g.product == "MOD021KM", "prodotto MOD021KM");
    check(g.satellite == "Terra", "satellite Terra");
    check(g.bands.size() == 7, "7 bande");
    check(g.timeText() == "2026-08-21 10:15 UTC", "timestamp header");
    check(g.intersectsFVG(), "footprint interseca il bbox FVG");

    for (auto& b : g.bands) {
        std::printf("    * n.%-2d %-28s %4dm  %dx%d  phys[%.3f..%.3f] %s\n",
                    b.number, b.name.c_str(), b.resolution, b.width, b.height,
                    b.physMin, b.physMax, b.unit.c_str());
        check(b.width > 0 && b.height > 0, "banda ha dimensioni");
    }

    // Mixed resolutions present.
    const modis::Band* b1 = g.bandByNumber(1);
    const modis::Band* b3 = g.bandByNumber(3);
    const modis::Band* b31 = g.bandByNumber(31);
    check(b1 && b1->resolution == 250, "banda 1 a 250 m");
    check(b3 && b3->resolution == 500, "banda 3 a 500 m");
    check(b31 && b31->resolution == 1000, "banda 31 a 1 km");

    // Reflectance stays within a physical range; thermal is in Kelvin.
    if (b1)  check(b1->physMin >= 0 && b1->physMax <= 1.3, "banda 1 riflettanza 0..1.3");
    if (b31) check(b31->physMin > 200 && b31->physMax < 340, "banda 31 in Kelvin (200..340)");

    // Fill/no-data path: the western swath gap must produce invalid pixels.
    if (b1) {
        int invalid = 0;
        for (int y = 0; y < b1->height; ++y)
            for (int x = 0; x < b1->width; ++x)
                if (!b1->valid(x, y)) ++invalid;
        check(invalid > 0, "banda 1 contiene pixel no-data (gap swath)");
    }

    // Geolocation round-trip: pixel -> lon/lat -> pixel is stable.
    if (b1) {
        double lon, lat, px, py;
        g.lonlatOfPixel(*b1, 100, 80, lon, lat);
        check(lon >= g.lonMin && lon <= g.lonMax && lat >= g.latMin && lat <= g.latMax,
              "pixel->lon/lat dentro il footprint");
        bool inside = g.pixelOfLonLat(*b1, lon, lat, px, py);
        check(inside && std::fabs(px - 100) < 1.0 && std::fabs(py - 80) < 1.0,
              "round-trip lon/lat->pixel");
        // Udine (13.2346, 46.0711) maps inside the raster.
        bool ud = g.pixelOfLonLat(*b1, 13.2346, 46.0711, px, py);
        check(ud && px >= 0 && px < b1->width && py >= 0 && py < b1->height,
              "Udine cade dentro il raster");
    }

    // A granule that misses FVG must be reported as non-intersecting.
    {
        modis::Granule off = g;
        off.latMin = 10; off.latMax = 12; off.lonMin = 10; off.lonMax = 12;
        check(!off.intersectsFVG(), "granulo lontano NON interseca FVG");
    }

    std::printf(fails ? "\nRESULT: %d FAIL\n" : "\nRESULT: all tests passed\n", fails);
    return fails ? 1 : 0;
}
