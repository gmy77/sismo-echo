// modis.h — Portable reader for the MODIS-FVG simplified granule format.
//
// Real MODIS L1B/L2 products (MOD021KM, MOD09, MOD11 …) ship as HDF-EOS / HDF4
// files that in practice need GDAL (+ the HDF-EOS swath library) to decode.
// This project is deliberately dependency-free (Win32 + GDI+ only), so instead
// of a hand-rolled HDF4 parser it reads a *documented, self-contained* granule
// container ("MFVG") that faithfully mimics the parts of a MODIS granule the
// viewer cares about:
//
//   * multiple spectral bands at mixed native resolutions (250 m / 500 m / 1 km)
//   * per-band scaled-integer storage (physical = scale * (DN - offset)),
//     exactly like MODIS radiance_scales / reflectance_scales / add_offset
//   * a fill/no-data DN, so "holes" in the swath are represented, not crashed on
//   * acquisition date/time and a geographic bounding box in the header
//   * a regular lat/lon geolocation grid over that bbox (the real product is a
//     curved swath; a regular grid is the honest simplification for FVG-sized
//     crops and keeps geolocation exact for the sample)
//
// The format is produced by tools/make_sample.cpp and validated by
// test/test_modis.cpp. Because there are no OS headers here, the decoding —
// the correctness-critical part — is unit-tested off-Windows.
//
// See docs/MFVG-FORMAT.md for the byte-level layout.
#pragma once
#include <cstdint>
#include <string>
#include <vector>
#include <cmath>

namespace modis {

// Friuli Venezia Giulia bounding box (as required by the spec). A granule is
// only useful to this viewer if its footprint intersects this rectangle.
constexpr double FVG_LAT_MIN = 45.5, FVG_LAT_MAX = 46.7;
constexpr double FVG_LON_MIN = 12.3, FVG_LON_MAX = 13.9;

enum class Kind : uint8_t { Reflectance = 0, Radiance = 1, Temperature = 2, Unknown = 3 };

// One spectral band (subdataset) of the granule.
struct Band {
    int         number     = 0;    // MODIS band number 1..36 (0 = derived/unknown)
    std::string name;              // e.g. "Band 1 (620-670 nm)"
    int         resolution = 1000; // native ground resolution in metres
    Kind        kind       = Kind::Unknown;
    std::string unit;              // "reflectance", "W/m2/um/sr", "K"

    // Scaled-integer storage, MODIS-style: physical = scale * (DN - offset).
    double   scale  = 1.0;
    double   offset = 0.0;
    uint16_t fill   = 65535;       // DN meaning "no data"

    int width  = 0;                // pixels along lon (x)
    int height = 0;                // pixels along lat (y), row 0 = northernmost

    std::vector<uint16_t> dn;      // width*height raw digital numbers

    double physMin = 0, physMax = 0; // physical range over valid pixels

    // Physical value at pixel (x,y); NaN if fill/out of range.
    double at(int x, int y) const;
    // Display value in [0,1] using the band's own physical range; NaN if fill.
    double normalized(int x, int y) const;
    bool   valid(int x, int y) const;
};

struct Granule {
    std::string satellite;   // "Terra" or "Aqua"
    std::string product;     // "MOD021KM", "MYD021KM", "MOD09", "MOD11"

    // Acquisition time (UTC), from the granule header.
    int year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0;

    // Geographic footprint of the (already FVG-cropped) granule, degrees.
    double latMin = 0, latMax = 0, lonMin = 0, lonMax = 0;

    std::vector<Band> bands;
    std::string path;        // source file, for logging/UI

    // "2026-08-21 10:15 UTC"
    std::string timeText() const;
    // Sortable key "20260821T1015" for ordering a sequence by acquisition.
    std::string sortKey() const;

    // Pixel <-> geography on the regular lat/lon grid. Bands of different
    // resolutions share the same footprint, so these take the band.
    void   lonlatOfPixel(const Band& b, double px, double py, double& lon, double& lat) const;
    bool   pixelOfLonLat(const Band& b, double lon, double lat, double& px, double& py) const;

    // Does the footprint intersect the FVG bbox at all? Many MODIS orbits miss
    // Italy on a given day — the caller must warn instead of crashing.
    bool   intersectsFVG() const;

    const Band* bandByNumber(int n) const;
};

// Parse a granule from memory / file. On malformed input returns an empty
// Granule (bands.empty()) and sets *err.
Granule parse(const uint8_t* data, size_t len, std::string* err = nullptr);
Granule parseFile(const std::string& path, std::string* err = nullptr);

} // namespace modis
