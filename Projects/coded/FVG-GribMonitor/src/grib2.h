// grib2.h — Minimal, portable GRIB2 reader tailored to the FVG extracts.
// No external dependencies, no Windows headers: builds on any C++17 compiler,
// so the correctness-critical decoding can be unit-tested off-Windows.
//
// Supported subset (enough for the FVG_CAPE-style files):
//   - Section 3, grid template 0  (regular lat/lon)
//   - Section 4, product template 0 / 8
//   - Section 5, data template 0   (grid-point, simple packing)
//   - Optional Section 6 bitmap (indicator 255 = no bitmap)
#pragma once
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>
#include <cmath>

namespace grib2 {

struct Field {
    // Identification
    int centre = 0;
    int year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0;

    // Product (what the field is)
    int paramCategory = -1;
    int paramNumber   = -1;
    int levelType     = -1;   // 100 = isobaric(Pa), 103 = height AGL(m), 1 = surface
    long levelValue   = 0;

    // Grid (regular lat/lon, template 0)
    int ni = 0, nj = 0;       // points along X (lon) and Y (lat)
    double lat1 = 0, lon1 = 0, lat2 = 0, lon2 = 0; // degrees
    double di = 0, dj = 0;    // increments, degrees
    uint8_t scanMode = 0;     // GRIB2 scanning mode flags

    // Decoded values, one per grid point, in NATURAL order:
    // index = row*ni + col, with row 0 = southernmost, col 0 = westernmost.
    std::vector<double> values;
    bool hasBitmap = false;   // true => some points may be "missing"
    std::vector<uint8_t> present; // 1 = valid, 0 = missing (only if hasBitmap)

    double minValue = 0, maxValue = 0; // over valid points

    // Human-readable identity, e.g. "CAPE", "Vento U @ 500 hPa".
    std::string label() const;
    std::string shortName() const;    // "CAPE", "U", "V"
    std::string levelText() const;    // "superficie", "500 hPa", "10 m"
    std::string unit() const;         // "J/kg", "m/s", ...
    // Value at grid (col,row); returns NaN if missing.
    double at(int col, int row) const;
};

// Parse an in-memory GRIB2 buffer. Returns all decoded fields. On malformed
// input, returns whatever was decoded up to the error and sets *err.
std::vector<Field> parse(const uint8_t* data, size_t len, std::string* err = nullptr);
std::vector<Field> parseFile(const std::string& path, std::string* err = nullptr);

// Bilinear sample of a field at arbitrary (lon,lat) in degrees. Returns NaN
// outside the grid or if surrounded by missing points. This is what produces
// the smooth, "faded" colouring instead of hard grid squares.
double sampleBilinear(const Field& f, double lon, double lat);

} // namespace grib2
