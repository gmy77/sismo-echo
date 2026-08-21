// test_image.cpp — portable test for the band compositing (image.cpp).
//   g++ -std=c++17 ../src/modis.cpp ../src/image.cpp test_image.cpp -o ti && ./ti sample_MODIS_FVG.mgr
#include "../src/modis.h"
#include "../src/image.h"
#include <cstdio>

static int fails = 0;
static void check(bool ok, const char* msg) {
    std::printf("  [%s] %s\n", ok ? "OK" : "FAIL", msg);
    if (!ok) ++fails;
}

int main(int argc, char** argv) {
    const char* path = argc > 1 ? argv[1] : "sample_MODIS_FVG.mgr";
    std::string err;
    modis::Granule g = modis::parseFile(path, &err);
    check(!g.bands.empty(), "granulo caricato");

    // Single band -> image at the band's native resolution.
    img::Image gray = img::renderSingle(g, 1, cmap::Ramp::Gray);
    check(!gray.empty(), "render banda singola non vuoto");
    check(gray.w == 384 && gray.h == 288, "banda 1 renderizzata 384x288");

    // The no-data stripe must appear as NODATA pixels somewhere.
    bool sawNodata = false;
    for (uint32_t p : gray.px) if (p == img::NODATA) { sawNodata = true; break; }
    check(sawNodata, "pixel no-data presenti nell'immagine");

    // Thermal band on a thermal ramp.
    img::Image th = img::renderSingle(g, 31, cmap::Ramp::Thermal);
    check(!th.empty() && th.w == 96 && th.h == 72, "banda 31 termica 96x72");

    // RGB false colour 7-2-1 uses the largest band (250 m -> 384x288).
    img::Image rgb = img::renderRGB(g, 7, 2, 1);
    check(!rgb.empty(), "composito RGB 7-2-1 non vuoto");
    check(rgb.w == 384 && rgb.h == 288, "RGB usa la risoluzione migliore (250 m)");

    // Every pixel is opaque (alpha = 0xFF), including NODATA.
    bool allOpaque = true;
    for (uint32_t p : rgb.px) if ((p >> 24) != 0xFF) { allOpaque = false; break; }
    check(allOpaque, "tutti i pixel opachi");

    // Natural true colour (1-4-3), calibrated on absolute reflectance.
    img::Image nat = img::renderTrueColor(g);
    check(!nat.empty() && nat.w == 384 && nat.h == 288, "true-color naturale 1-4-3 384x288");

    // Difference of two different images is non-trivial; of an image with
    // itself is all-black (no change) except NODATA.
    img::Image self = img::difference(nat, nat);
    check(!self.empty(), "difference(nat,nat) non vuoto");
    bool allBlackOrNodata = true;
    for (uint32_t p : self.px) if (p != img::NODATA && (p & 0x00FFFFFF) != 0) { allBlackOrNodata = false; break; }
    check(allBlackOrNodata, "differenza di un'immagine con se stessa = nera");
    img::Image diff = img::difference(nat, rgb); // natural vs false-colour -> changes
    bool sawChange = false;
    for (uint32_t p : diff.px) if (p != img::NODATA && (p & 0x00FFFFFF) != 0) { sawChange = true; break; }
    check(sawChange, "differenza tra compositi diversi mostra variazioni");

    // A missing band => empty image, not a crash.
    img::Image none = img::renderSingle(g, 99, cmap::Ramp::Gray);
    check(none.empty(), "banda inesistente -> immagine vuota");

    std::printf(fails ? "\nRESULT: %d FAIL\n" : "\nRESULT: all tests passed\n", fails);
    return fails ? 1 : 0;
}
