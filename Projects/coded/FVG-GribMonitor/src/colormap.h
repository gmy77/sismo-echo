// colormap.h — value -> RGB colour ramps, portable (no Windows headers).
// The ramps are defined as a few control colours and linearly interpolated,
// which is what makes neighbouring values blend smoothly ("scemare via il
// colore") instead of snapping between red / yellow / green.
#pragma once
#include <cstdint>
#include <vector>
#include <algorithm>
#include <cmath>

namespace cmap {

struct RGB { uint8_t r, g, b; };

struct Stop { double t; RGB c; }; // t in [0,1]

// A named palette plus the data range it maps.
struct Palette {
    const char* name;
    std::vector<Stop> stops;
    bool diverging; // centred on 0 (for wind components)
};

inline RGB lerp(RGB a, RGB b, double t) {
    auto L = [&](uint8_t x, uint8_t y) { return (uint8_t)std::lround(x + (y - x) * t); };
    return { L(a.r, b.r), L(a.g, b.g), L(a.b, b.b) };
}

// Evaluate a stop list at t in [0,1].
inline RGB eval(const std::vector<Stop>& s, double t) {
    t = std::clamp(t, 0.0, 1.0);
    for (size_t i = 1; i < s.size(); ++i) {
        if (t <= s[i].t) {
            double span = s[i].t - s[i - 1].t;
            double u = span > 1e-9 ? (t - s[i - 1].t) / span : 0.0;
            return lerp(s[i - 1].c, s[i].c, u);
        }
    }
    return s.back().c;
}

// --- Built-in palettes -----------------------------------------------------

// CAPE / instability: calm green -> yellow -> orange -> red -> violet.
inline Palette cape() {
    return { "CAPE (instabilita)", {
        {0.00, {  1, 40,  90}},   // deep blue (near zero, stable)
        {0.12, { 20,120, 110}},
        {0.28, { 80,175,  80}},   // green
        {0.48, {235,225,  70}},   // yellow
        {0.66, {245,150,  40}},   // orange
        {0.82, {220,  55,  45}},  // red
        {1.00, {150,  25, 120}},  // violet (extreme)
    }, false };
}

// Wind speed magnitude: white -> blue -> green -> yellow -> red.
inline Palette windSpeed() {
    return { "Vento (velocita)", {
        {0.00, {245,248,255}},
        {0.20, { 90,160,220}},
        {0.45, { 70,190,120}},
        {0.70, {240,220, 80}},
        {1.00, {210, 50, 40}},
    }, false };
}

// Temperature: blue (cold) -> cyan -> green -> yellow -> orange -> red (hot).
inline Palette thermal() {
    return { "Temperatura", {
        {0.00, { 40,  50, 150}},
        {0.20, { 40, 140, 200}},
        {0.40, { 70, 190, 130}},
        {0.58, {235, 225,  90}},
        {0.78, {240, 150,  50}},
        {1.00, {200,  40,  40}},
    }, false };
}

// Relative humidity: dry tan -> green -> blue (wet).
inline Palette humidity() {
    return { "Umidita", {
        {0.00, {200, 170, 120}},
        {0.45, {150, 200, 120}},
        {0.75, { 70, 170, 190}},
        {1.00, { 30,  80, 190}},
    }, false };
}

// Diverging palette for signed components (U or V): blue - white - red.
inline Palette diverging() {
    return { "Componente (segno)", {
        {0.00, { 40, 70,180}},
        {0.50, {245,245,245}},
        {1.00, {200, 45, 40}},
    }, true };
}

// Map a value to colour given the palette and data range.
// For diverging palettes the range is made symmetric around 0.
inline RGB colorFor(const Palette& p, double value, double vmin, double vmax) {
    double t;
    if (p.diverging) {
        double m = std::max(std::fabs(vmin), std::fabs(vmax));
        if (m < 1e-9) m = 1;
        t = 0.5 + 0.5 * std::clamp(value / m, -1.0, 1.0);
    } else {
        double span = vmax - vmin;
        t = span > 1e-9 ? (value - vmin) / span : 0.0;
    }
    return eval(p.stops, t);
}

} // namespace cmap
