// image.h — portable pixel compositing for MODIS bands.
//
// Produces a top-down 32-bit image (pixel = 0xAARRGGBB, stored little-endian so
// the bytes are B,G,R,A — the layout both GDI+ PixelFormat32bppARGB and Media
// Foundation MFVideoFormat_RGB32 expect). No OS headers, so the normalisation
// and false-colour maths are unit-tested off-Windows.
#pragma once
#include "modis.h"
#include "colormap.h"
#include <cstdint>
#include <vector>

namespace img {

struct Image {
    int w = 0, h = 0;
    std::vector<uint32_t> px; // row 0 = north, size w*h
    bool empty() const { return px.empty(); }
    uint32_t at(int x, int y) const { return px[(size_t)y * w + x]; }
};

// Colour used for fill / no-data pixels.
constexpr uint32_t NODATA = 0xFF20242Cu;

inline uint32_t packARGB(uint8_t r, uint8_t g, uint8_t b) {
    return 0xFF000000u | ((uint32_t)r << 16) | ((uint32_t)g << 8) | b;
}

// Single band rendered through a colour ramp. `gamma` > 1 brightens the low
// (dark) end, which reflectance bands need to be legible.
Image renderSingle(const modis::Granule& g, int bandNumber, cmap::Ramp ramp, double gamma = 1.6);

// Calibrated RGB composite from three band numbers. Reflectance channels are
// mapped through the NASA "Rapid Response" true-colour enhancement in ABSOLUTE
// reflectance units (not per-image min/max), so brightness is consistent and
// images from different dates are directly comparable. Non-reflectance channels
// fall back to a per-band stretch. Natural colour = renderRGB(g, 1, 4, 3);
// the classic false-colour is renderRGB(g, 7, 2, 1).
Image renderRGB(const modis::Granule& g, int rBand, int gBand, int bBand);

// Convenience: natural true colour (MODIS bands 1-4-3), calibrated.
Image renderTrueColor(const modis::Granule& g);

// Per-pixel absolute difference of two equally-sized images (luminance-weighted
// on |Δ| of each channel). Where either input is NODATA the output is NODATA.
// Used to "see the differences" between two cached granules.
Image difference(const Image& a, const Image& b);

// Unsharp mask: subtract a blurred copy to restore the edge contrast that
// resampling and the sensor's point-spread function take away. MODIS imagery
// served above its native ground resolution is interpolated, so it arrives
// soft; this puts the perceived detail back without inventing any.
// `amount` 0 = untouched, ~0.6 = gentle, ~1.5 = strong. NODATA is preserved.
Image sharpen(const Image& src, double amount = 0.9, int radius = 1);

} // namespace img
