// colormap.h — value -> RGB ramps for single-band MODIS display. Portable.
// Reflectance bands read best as grayscale; the thermal (LST) band reads best
// on a temperature ramp. Ramps are control colours interpolated linearly so
// neighbouring values blend smoothly.
#pragma once
#include <cstdint>
#include <vector>
#include <algorithm>
#include <cmath>

namespace cmap {

struct RGB { uint8_t r, g, b; };
struct Stop { double t; RGB c; };

enum class Ramp { Gray, Thermal, Ndvi };

inline RGB lerp(RGB a, RGB b, double t) {
    auto L = [&](uint8_t x, uint8_t y) { return (uint8_t)std::lround(x + (y - x) * t); };
    return { L(a.r, b.r), L(a.g, b.g), L(a.b, b.b) };
}

inline RGB eval(const std::vector<Stop>& s, double t) {
    t = std::clamp(t, 0.0, 1.0);
    for (size_t i = 1; i < s.size(); ++i)
        if (t <= s[i].t) {
            double span = s[i].t - s[i - 1].t;
            double u = span > 1e-9 ? (t - s[i - 1].t) / span : 0.0;
            return lerp(s[i - 1].c, s[i].c, u);
        }
    return s.back().c;
}

inline const std::vector<Stop>& thermalStops() {
    static const std::vector<Stop> s = {
        {0.00, { 40,  50, 150}},  // cold: blue
        {0.20, { 40, 140, 200}},
        {0.40, { 70, 190, 130}},
        {0.58, {235, 225,  90}},
        {0.78, {240, 150,  50}},
        {1.00, {200,  40,  40}},  // hot: red
    };
    return s;
}

// Simple green-scale ("vegetation") ramp, handy on NIR-heavy bands.
inline const std::vector<Stop>& ndviStops() {
    static const std::vector<Stop> s = {
        {0.00, {120,  90,  60}},  // bare soil / brown
        {0.35, {180, 170, 110}},
        {0.60, {110, 175,  70}},
        {1.00, { 20, 110,  30}},  // dense vegetation
    };
    return s;
}

// Map a normalized value t in [0,1] to an RGB triple for the chosen ramp.
inline RGB apply(Ramp r, double t) {
    switch (r) {
        case Ramp::Thermal: return eval(thermalStops(), t);
        case Ramp::Ndvi:    return eval(ndviStops(), t);
        case Ramp::Gray:
        default: { uint8_t v = (uint8_t)std::lround(std::clamp(t, 0.0, 1.0) * 255); return { v, v, v }; }
    }
}

} // namespace cmap
