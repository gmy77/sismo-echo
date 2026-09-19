// Copyright (c) 2026 Gimmy Pignolo. Tutti i diritti riservati.
// MODIS-FVG Viewer 1.0.2 - vedi LICENSE nella radice del repository.
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

// Fraction of pixels (0..1) that carry an actual observation, i.e. are not
// NODATA. A satellite product with a long revisit time returns a fully
// transparent tile on days it did not fly over, which decodes to all-NODATA:
// this is how the viewer tells "no pass that day" from "a genuinely dark
// scene" and can step back to the last day with real data.
double coverage(const Image& im);

// Sovrappone `over` a `base`: dove `over` ha un'osservazione la usa, altrove
// lascia passare la base. Serve ai prodotti "a punti" come gli incendi, che da
// soli sarebbero quasi tutti trasparenti e illeggibili senza un riferimento.
Image composite(const Image& base, const Image& over);

// Appiattisce le nuvole in un grigio neutro, lasciando intatto il resto.
//
// Una nuvola in true-color e' chiara *e* priva di dominante: terra e mare hanno
// sempre un colore, il vapore no. Riconosciuta cosi', viene resa in grigio
// uniforme - non per nasconderla, ma per il contrario: il terreno ancora
// visibile torna a spiccare, e diventa immediato distinguere dove c'e'
// osservazione da dove il sensore e' cieco. Non inventa nulla di cio' che sta
// sotto: quel dato non esiste.
Image mutedClouds(const Image& src, double strength = 1.0);

// Luminanza media (0..1) dei soli pixel OSSERVATI (non NODATA). Serve a capire
// se un overlay finira' su una scena chiara o scura senza farsi trascinare
// dal grigio del no-data: una tessera mezza vuota non deve sembrare sempre
// "medio grigio" solo perche' meta' dei pixel sono di riempimento.
double meanLuma(const Image& im);

// Una macchia connessa di pixel osservati (non NODATA) su uno strato "a
// punti" come gli incendi: conteggio, centroide e riquadro di inviluppo.
struct Blob { int n = 0; double cx = 0, cy = 0; int x0 = 0, y0 = 0, x1 = 0, y1 = 0; };

// Trova le macchie 8-connesse di `layer` con almeno `minPixels` pixel,
// ordinate dalla piu' grande, fino a `maxBlobs`. Alla base del conteggio
// incendi: senza una soglia minima ogni pixel isolato (rumore) diventerebbe
// un "incendio" a se stante.
std::vector<Blob> clusters(const Image& layer, int minPixels, int maxBlobs);

// Tappa i buchi NODATA di `primary` con i pixel corrispondenti di `secondary`
// (stessa dimensione). Il caso reale: HLS Sentinel-2 e Landsat coprono spesso
// solo una fascia del riquadro, non l'intero FVG; l'altro satellite completa
// il resto. La cucitura fra le due fonti viene marcata (mescolata col vicino
// di provenienza diversa) cosi' il confine si legge invece di sembrare un
// taglio netto o, peggio, un dato inventato. Se `secondary` e' vuota o di
// misura diversa, `primary` torna intatta.
Image fillGaps(const Image& primary, const Image& secondary);

} // namespace img
