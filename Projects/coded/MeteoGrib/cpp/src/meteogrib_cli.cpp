// meteogrib_cli.cpp — front-end a riga di comando del porting C++.
// Comandi: info | plot | export | auto     (immagini in formato BMP)
//
// Nota: la versione Python resta quella completa (coste cartopy, carte
// derivate). Questo eseguibile C++ legge il GRIB con ecCodes e produce
// inventario, heatmap BMP con città e valori, ed export CSV — senza
// dipendenze grafiche esterne, quindi compila e gira nativo su Windows.
#include "grib_reader.h"
#include "render.h"

#include <cstdio>
#include <cmath>
#include <string>
#include <vector>

#ifdef _WIN32
  #include <direct.h>
  static void makeDir(const std::string& d) { _mkdir(d.c_str()); }
#else
  #include <sys/stat.h>
  static void makeDir(const std::string& d) { mkdir(d.c_str(), 0755); }
#endif

using namespace mg;

static void usage() {
    std::printf(
        "MeteoGrib (C++)  -  lettore GRIB con heatmap BMP\n"
        "Creazione di Gimmy Pignolo & Anthropic - progetto SISMO ECHO.\n"
        "Uso:\n"
        "  meteogrib info    FILE\n"
        "  meteogrib plot    FILE --index N [--out X.bmp] [--no-cities] [--no-max]\n"
        "                                    [--no-smooth] [--grid]\n"
        "  meteogrib export  FILE --index N [--out X.csv]\n"
        "  meteogrib auto    FILE [--outdir DIR]\n");
}

static std::string argVal(int argc, char** argv, const std::string& key, const std::string& def="") {
    for (int i=0;i<argc-1;++i) if (key==argv[i]) return argv[i+1];
    return def;
}
static bool hasFlag(int argc, char** argv, const std::string& key) {
    for (int i=0;i<argc;++i) if (key==argv[i]) return true;
    return false;
}

static int findIndex(const std::vector<GribField>& fs, int idx) {
    for (size_t i=0;i<fs.size();++i) if (fs[i].number==idx) return int(i);
    return -1;
}

static bool exportCsv(const GribField& g, const std::string& out) {
    FILE* f = std::fopen(out.c_str(), "wb");
    if (!f) return false;
    std::fprintf(f, "# %s [%s] %s step %s\n",
                 g.name.c_str(), g.units.c_str(), g.levelLabel().c_str(), g.step.c_str());
    std::fprintf(f, "lat,lon,valore\n");
    for (size_t i=0;i<g.values.size();++i)
        std::fprintf(f, "%.4f,%.4f,%.6g\n", g.lats[i], g.lons[i], g.values[i]);
    std::fclose(f);
    return true;
}

int main(int argc, char** argv) {
    if (argc < 3) { usage(); return 1; }
    std::string cmd = argv[1], file = argv[2];

    std::vector<GribField> fs; std::string err;
    if (!readGrib(file, fs, err)) { std::printf("Errore: %s\n", err.c_str()); return 2; }

    if (cmd == "info") {
        for (const auto& g : fs) {
            std::printf("%s\n", g.inventoryLine().c_str());
            std::printf("     %s [%s]  %s %ldx%ld  min=%.4g media=%.4g max=%.4g\n",
                        g.name.c_str(), g.units.c_str(), g.gridType.c_str(),
                        g.ni, g.nj, g.vmin, g.vmean, g.vmax);
        }
        std::printf("\n%zu messaggi.\n", fs.size());
        return 0;
    }

    if (cmd == "plot") {
        int idx = std::atoi(argVal(argc,argv,"--index","1").c_str());
        int pos = findIndex(fs, idx);
        if (pos < 0) { std::printf("Indice non trovato. Usa 'info'.\n"); return 3; }
        const GribField& g = fs[pos];
        if (!g.regular) { std::printf("Campo non su griglia regolare: niente mappa.\n"); return 3; }
        RenderOpts o;
        o.showCities = !hasFlag(argc,argv,"--no-cities");
        o.showMax    = !hasFlag(argc,argv,"--no-max");
        o.smooth     = !hasFlag(argc,argv,"--no-smooth");
        o.showGrid   =  hasFlag(argc,argv,"--grid");
        Image img = renderField(g, classify(g), o);
        std::string out = argVal(argc,argv,"--out",
                                 "campo_" + std::to_string(idx) + "_" + g.shortName + ".bmp");
        if (!img.saveBMP(out)) { std::printf("Scrittura BMP fallita.\n"); return 4; }
        std::printf("Mappa salvata: %s\n", out.c_str());
        return 0;
    }

    if (cmd == "export") {
        int idx = std::atoi(argVal(argc,argv,"--index","1").c_str());
        int pos = findIndex(fs, idx);
        if (pos < 0) { std::printf("Indice non trovato. Usa 'info'.\n"); return 3; }
        const GribField& g = fs[pos];
        std::string out = argVal(argc,argv,"--out",
                                 "campo_" + std::to_string(idx) + "_" + g.shortName + ".csv");
        if (!exportCsv(g, out)) { std::printf("Scrittura CSV fallita.\n"); return 4; }
        std::printf("Esportati %zu punti in: %s\n", g.values.size(), out.c_str());
        return 0;
    }

    if (cmd == "auto") {
        std::string dir = argVal(argc,argv,"--outdir","meteogrib_out");
        makeDir(dir);
        int made = 0;
        for (const auto& g : fs) {
            if (!g.regular) continue;
            RenderOpts o;
            Image img = renderField(g, classify(g), o);
            char name[512];
            std::snprintf(name,sizeof(name), "%s/%02d_%s.bmp",
                          dir.c_str(), g.number, g.shortName.c_str());
            if (img.saveBMP(name)) { std::printf("  OK %s\n", name); ++made; }
        }
        std::printf("\nFatto. %d mappe BMP in '%s/'.\n", made, dir.c_str());
        return 0;
    }

    usage();
    return 1;
}
