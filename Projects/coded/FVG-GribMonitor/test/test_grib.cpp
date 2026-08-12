// test_grib.cpp — portable sanity test for the GRIB2 reader.
// Builds & runs on any platform:  g++ -std=c++17 ../src/grib2.cpp test_grib.cpp -o t && ./t sample_FVG_CAPE.grib2
#include "../src/grib2.h"
#include <cstdio>
#include <cmath>

static int fails = 0;
static void check(bool ok, const char* msg) {
    std::printf("  [%s] %s\n", ok ? "OK" : "FAIL", msg);
    if (!ok) ++fails;
}

int main(int argc, char** argv) {
    const char* path = argc > 1 ? argv[1] : "sample_FVG_CAPE.grib2";
    std::string err;
    auto fields = grib2::parseFile(path, &err);
    std::printf("Parsed %zu fields from %s (err='%s')\n", fields.size(), path, err.c_str());

    check(fields.size() == 5, "5 campi trovati");

    for (auto& f : fields) {
        std::printf("  * %-24s grid %dx%d lat[%.1f..%.1f] lon[%.1f..%.1f]  min=%.2f max=%.2f\n",
                    f.label().c_str(), f.ni, f.nj, f.lat1, f.lat2, f.lon1, f.lon2,
                    f.minValue, f.maxValue);
        check(f.ni == 9 && f.nj == 9, "griglia 9x9");
        check(std::fabs(f.lon1 - 12.0) < 1e-6 && std::fabs(f.lat1 - 45.0) < 1e-6, "origine 12E/45N");
    }

    // Locate CAPE and verify the known extremes from the reference decode.
    const grib2::Field* cape = nullptr;
    for (auto& f : fields) if (f.shortName() == "CAPE") cape = &f;
    check(cape != nullptr, "campo CAPE presente");
    if (cape) {
        check(std::fabs(cape->maxValue - 1147.0) < 1.0, "CAPE max ~1147 J/kg");
        check(cape->minValue >= 0.0, "CAPE min >= 0");
        // Bilinear at an interior point must lie within the data range.
        double v = grib2::sampleBilinear(*cape, 13.0, 46.0);
        check(!std::isnan(v) && v >= cape->minValue - 1 && v <= cape->maxValue + 1,
              "sample bilineare dentro il range");
    }

    std::printf(fails ? "\nRESULT: %d FAIL\n" : "\nRESULT: all tests passed\n", fails);
    return fails ? 1 : 0;
}
