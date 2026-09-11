// grib_reader.cpp — implementazione basata sull'API C di ecCodes.
#include "grib_reader.h"

#include <eccodes.h>
#include <cctype>
#include <cstdio>
#include <cmath>
#include <cstring>
#include <limits>

namespace mg {

// ---- helper per leggere chiavi in modo sicuro ---------------------------
static std::string getStr(codes_handle* h, const char* key, const char* def="") {
    if (!codes_is_defined(h, key)) return def;
    char buf[512]; size_t len = sizeof(buf);
    if (codes_get_string(h, key, buf, &len) == 0) return std::string(buf);
    return def;
}
static long getLong(codes_handle* h, const char* key, long def=0) {
    if (!codes_is_defined(h, key)) return def;
    long v = def;
    if (codes_get_long(h, key, &v) == 0) return v;
    return def;
}
static double getDbl(codes_handle* h, const char* key, double def=0) {
    if (!codes_is_defined(h, key)) return def;
    double v = def;
    if (codes_get_double(h, key, &v) == 0) return v;
    return def;
}

std::string GribField::levelLabel() const {
    std::string tl = typeOfLevel;
    for (auto& c : tl) c = char(tolower(c));
    if (tl.find("isobaric") != std::string::npos)
        return std::to_string(level) + " hPa";
    if (tl.find("heightaboveground") != std::string::npos)
        return std::to_string(level) + " m dal suolo";
    if (tl.find("meansea") != std::string::npos) return "livello del mare";
    if (tl.find("surface") != std::string::npos) return "superficie";
    if (level) return (typeOfLevel.empty()? "lev " : typeOfLevel + " ")
                      + std::to_string(level);
    return typeOfLevel.empty() ? "superficie" : typeOfLevel;
}

std::string GribField::inventoryLine() const {
    std::string d;
    if (dataDate.empty()) {
        d = "?";                       // GRIB senza metadati temporali
    } else {
        char b[40];
        std::snprintf(b, sizeof(b), "%.20s%02ld", dataDate.c_str(), dataTime/100);
        d = b;
    }
    return std::to_string(number) + ":GRIB" + std::to_string(edition)
         + ":d=" + d + ":" + shortName + ":" + levelLabel() + ":step " + step;
}

Kind classify(const GribField& f) {
    long D=f.discipline, C=f.category, N=f.paramNumber;
    if (D==0 && C==0 && N==0) return Kind::Temperature;
    if (D==0 && C==3 && (N==0||N==1)) return Kind::Pressure;
    if (D==0 && C==3 && N==5) return Kind::Pressure;         // geopotenziale ~ contorni
    if (D==0 && C==1 && (N==8||N==52)) return Kind::Precip;
    if (D==0 && C==1 && N==1) return Kind::Humidity;
    if (D==0 && C==2 && N==2) return Kind::WindU;
    if (D==0 && C==2 && N==3) return Kind::WindV;
    if (D==0 && C==7 && (N==6||N==7)) return Kind::Cape;
    std::string sn = f.shortName;
    for (auto& c : sn) c = char(tolower(c));
    if (sn=="2t"||sn=="t"||sn=="tmp"||sn=="skt") return Kind::Temperature;
    if (sn=="prmsl"||sn=="msl"||sn=="pres"||sn=="sp") return Kind::Pressure;
    if (sn=="tp"||sn=="apcp"||sn=="acpcp") return Kind::Precip;
    if (sn=="10u"||sn=="u"||sn=="ugrd") return Kind::WindU;
    if (sn=="10v"||sn=="v"||sn=="vgrd") return Kind::WindV;
    if (sn=="cape"||sn=="cin"||sn=="mlcape"||sn=="mucape") return Kind::Cape;
    if (sn=="r"||sn=="rh"||sn=="2r") return Kind::Humidity;
    return Kind::Generic;
}

const char* displayUnit(Kind k, const std::string& fallback) {
    // Solo per le grandezze che il renderer converte davvero (temperatura
    // K->°C, pressione Pa->hPa) restituiamo l'unità convertita; per le altre
    // usiamo l'unità originale del GRIB, per non mostrare numeri con unità
    // sbagliate.
    switch (k) {
        case Kind::Temperature: return "C";
        case Kind::Pressure:    return "hPa";
        case Kind::Cape:        return "J/kg";
        case Kind::WindU: case Kind::WindV: return "m/s";
        default: return fallback.c_str();   // precip, umidità, generico
    }
}

bool readGrib(const std::string& path, std::vector<GribField>& out, std::string& err) {
    FILE* f = std::fopen(path.c_str(), "rb");
    if (!f) { err = "Impossibile aprire il file: " + path; return false; }

    int e = 0; int n = 0;
    codes_handle* h = nullptr;
    while ((h = codes_handle_new_from_file(nullptr, f, PRODUCT_GRIB, &e)) != nullptr) {
        ++n;
        GribField g;
        g.number = n;
        g.shortName = getStr(h, "shortName", "unknown");
        g.name = getStr(h, "name", g.shortName.c_str());
        g.units = getStr(h, "units", "");
        g.edition = getLong(h, "editionNumber", 2);
        g.discipline = getLong(h, "discipline", 0);
        g.category = getLong(h, "parameterCategory", -1);
        g.paramNumber = getLong(h, "parameterNumber", -1);
        g.level = getLong(h, "level", 0);
        g.typeOfLevel = getStr(h, "typeOfLevel", getStr(h,"levtype","").c_str());
        g.dataDate = getStr(h, "dataDate", "");
        g.dataTime = getLong(h, "dataTime", 0);
        g.step = getStr(h, "stepRange", getStr(h,"step","0").c_str());
        g.gridType = getStr(h, "gridType", "");
        g.ni = getLong(h, "Ni", 0);
        g.nj = getLong(h, "Nj", 0);

        size_t nv = 0;
        if (codes_get_size(h, "values", &nv) == 0 && nv > 0) {
            std::vector<double> v(nv), la(nv), lo(nv);
            size_t a=nv,b=nv,c=nv;
            bool okv = codes_get_double_array(h,"values",v.data(),&a)==0;
            bool okla= codes_get_double_array(h,"latitudes",la.data(),&b)==0;
            bool oklo= codes_get_double_array(h,"longitudes",lo.data(),&c)==0;
            double miss = getDbl(h,"missingValue", 9999.0);
            if (okv) {
                double mn= std::numeric_limits<double>::infinity();
                double mx=-std::numeric_limits<double>::infinity();
                double sum=0; long cnt=0;
                for (size_t i=0;i<nv;++i) {
                    if (v[i]==miss) { v[i]=std::nan(""); continue; }
                    mn=std::min(mn,v[i]); mx=std::max(mx,v[i]);
                    sum+=v[i]; ++cnt;
                }
                g.values=std::move(v);
                if (okla) g.lats=std::move(la);
                if (oklo) g.lons=std::move(lo);
                g.vmin=cnt?mn:0; g.vmax=cnt?mx:0; g.vmean=cnt?sum/cnt:0;
                g.regular = (g.ni>0 && g.nj>0 &&
                             size_t(g.ni)*size_t(g.nj)==nv &&
                             okla && oklo);
            }
        }
        out.push_back(std::move(g));
        codes_handle_delete(h);
    }
    std::fclose(f);
    if (n == 0) { err = "Nessun messaggio GRIB nel file."; return false; }
    return true;
}

} // namespace mg
