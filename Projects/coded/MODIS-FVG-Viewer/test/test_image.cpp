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

    // Unsharp mask: same geometry, amount 0 is a no-op, NODATA survives, and a
    // real amount raises local contrast rather than just shifting brightness.
    img::Image sh = img::sharpen(nat, 0.9, 1);
    check(sh.w == nat.w && sh.h == nat.h, "sharpen conserva le dimensioni");
    img::Image noop = img::sharpen(nat, 0.0, 1);
    check(noop.px == nat.px, "sharpen(amount=0) non altera l'immagine");
    bool nodataKept = true;
    for (size_t i = 0; i < nat.px.size(); ++i)
        if ((nat.px[i] == img::NODATA) != (sh.px[i] == img::NODATA)) { nodataKept = false; break; }
    check(nodataKept, "sharpen preserva esattamente i pixel no-data");
    auto spread = [](const img::Image& im) {           // mean |neighbour delta|
        double acc = 0; size_t n = 0;
        for (int y = 0; y < im.h; ++y)
            for (int x = 1; x < im.w; ++x) {
                uint32_t a = im.at(x - 1, y), b = im.at(x, y);
                if (a == img::NODATA || b == img::NODATA) continue;
                acc += std::abs((int)(a & 0xff) - (int)(b & 0xff)); ++n;
            }
        return n ? acc / n : 0.0;
    };
    check(spread(sh) > spread(nat), "sharpen aumenta il contrasto di bordo");

    // coverage(): distingue "il satellite non e' passato" (tessera tutta
    // trasparente -> tutta NODATA) da una scena reale ma scura.
    img::Image empty; empty.w = 8; empty.h = 8;
    empty.px.assign(64, img::NODATA);
    check(img::coverage(empty) == 0.0, "coverage di un'immagine tutta no-data = 0");
    img::Image dark; dark.w = 8; dark.h = 8;
    dark.px.assign(64, img::packARGB(0, 0, 0));
    check(img::coverage(dark) == 1.0, "coverage di una scena nera ma reale = 1");
    dark.px[0] = img::NODATA; dark.px[1] = img::NODATA;
    check(std::abs(img::coverage(dark) - 62.0 / 64.0) < 1e-9, "coverage parziale corretta");
    check(img::coverage(img::Image{}) == 0.0, "coverage di un'immagine vuota = 0");
    check(img::coverage(nat) > 0.5, "il granulo di esempio ha copertura reale");

    // meanLuma(): serve a capire se gli overlay finiranno su una scena chiara.
    // Deve guardare solo i pixel osservati, altrimenti il grigio del no-data
    // trascinerebbe la media e una tessera mezza vuota sembrerebbe sempre media.
    img::Image white; white.w = 4; white.h = 4;
    white.px.assign(16, img::packARGB(255, 255, 255));
    check(std::abs(img::meanLuma(white) - 1.0) < 1e-9, "meanLuma di un'immagine bianca = 1");
    white.px[0] = img::NODATA; white.px[1] = img::NODATA;
    check(std::abs(img::meanLuma(white) - 1.0) < 1e-9, "meanLuma ignora i pixel no-data");
    check(img::meanLuma(dark) < 0.01, "meanLuma di una scena nera ~ 0");
    check(img::meanLuma(empty) == 0.0, "meanLuma senza pixel osservati = 0");

    // clusters(): due macchie separate su uno strato altrimenti trasparente.
    // Il conteggio degli incendi vive o muore qui.
    img::Image layer; layer.w = 10; layer.h = 10;
    layer.px.assign(100, img::NODATA);
    auto set = [&](int x, int y) { layer.px[(size_t)y * 10 + x] = img::packARGB(255, 60, 0); };
    set(1, 1); set(2, 1); set(1, 2);          // macchia A, 3 pixel
    set(8, 8); set(7, 7);                     // macchia B, 2 pixel in diagonale
    set(5, 0);                                // pixel isolato, sotto la soglia
    std::vector<img::Blob> bl = img::clusters(layer, 2, 64);
    check(bl.size() == 2, "clusters trova due macchie e scarta il pixel isolato");
    check(bl[0].n == 3 && bl[1].n == 2, "clusters ordina dalla macchia piu' grande");
    check(std::abs(bl[0].cx - 4.0 / 3.0) < 1e-9 && std::abs(bl[0].cy - 4.0 / 3.0) < 1e-9,
          "centroide della macchia corretto");
    check(bl[1].x0 == 7 && bl[1].x1 == 8, "la diagonale resta una macchia sola (8-connesso)");
    check(img::clusters(layer, 1, 1).size() == 1, "clusters rispetta il tetto massimo");
    check(img::clusters(empty, 1, 64).empty(), "clusters su strato vuoto non trova niente");

    // fillGaps(): il caso HLS Sentinel-2 + Landsat. primary copre solo meta'
    // immagine (l'altra meta' e' NODATA, come una fascia di ripresa stretta
    // che non arriva a coprire tutto il FVG); secondary copre tutto.
    img::Image primary; primary.w = 6; primary.h = 4;
    primary.px.assign(24, img::NODATA);
    for (int y = 0; y < 4; ++y) for (int x = 0; x < 3; ++x) primary.px[y * 6 + x] = img::packARGB(10, 20, 30);
    img::Image secondary; secondary.w = 6; secondary.h = 4;
    secondary.px.assign(24, img::packARGB(200, 210, 220));
    img::Image filled = img::fillGaps(primary, secondary);
    check(filled.w == 6 && filled.h == 4, "fillGaps conserva le dimensioni");
    bool anyNodataLeft = false;
    for (uint32_t p : filled.px) if (p == img::NODATA) { anyNodataLeft = true; break; }
    check(!anyNodataLeft, "fillGaps tappa tutti i buchi quando secondary li copre");
    check(filled.px[0 * 6 + 0] == primary.px[0], "un pixel lontano dal confine, gia' osservato, resta intatto");
    // Il confine (colonna 2 = ultima di primary, colonna 3 = prima riempita)
    // deve essere tinto, quindi diverso sia dal primary puro sia dal secondary puro.
    uint32_t edgeFromPrimary = filled.px[1 * 6 + 2], edgeFromSecondary = filled.px[1 * 6 + 3];
    check(edgeFromPrimary != img::packARGB(10, 20, 30), "il lato primary del confine e' marcato, non il colore grezzo");
    check(edgeFromSecondary != img::packARGB(200, 210, 220), "il lato secondary del confine e' marcato, non il colore grezzo");
    check(filled.px[3 * 6 + 5] == img::packARGB(200, 210, 220), "lontano dal confine, il riempimento resta il colore puro di secondary");
    img::Image untouched = img::fillGaps(primary, img::Image{});
    check(untouched.px == primary.px, "secondary vuota -> primary intatta");
    img::Image wrongSize; wrongSize.w = 3; wrongSize.h = 4; wrongSize.px.assign(12, img::packARGB(1, 2, 3));
    check(img::fillGaps(primary, wrongSize).px == primary.px, "secondary di misura diversa -> primary intatta");

    std::printf(fails ? "\nRESULT: %d FAIL\n" : "\nRESULT: all tests passed\n", fails);
    return fails ? 1 : 0;
}
