// render.h — trasforma un GribField in un'immagine (heatmap + città + badge).
// Header-only: usato dalla CLI (salva BMP) e dalla GUI (blit a schermo).
// Nota: la versione C++ NON disegna le coste (quella è la funzione cartopy
// del programma Python); disegna griglia, città con valori e badge del massimo.
#ifndef METEOGRIB_RENDER_H
#define METEOGRIB_RENDER_H

#include "bmp.h"
#include "grib_reader.h"
#include <cmath>
#include <string>
#include <vector>

namespace mg {

struct City { const char* name; double lat, lon; };

inline const std::vector<City>& cities() {
    static const std::vector<City> C = {
        {"UDINE",46.07,13.23},{"TRIESTE",45.65,13.77},{"PORDENONE",45.96,12.66},
        {"GORIZIA",45.94,13.62},{"TOLMEZZO",46.40,13.02},{"TARVISIO",46.51,13.58},
        {"CIVIDALE",46.09,13.43},{"GRADO",45.68,13.40},{"SACILE",45.95,12.50},
        {"VENEZIA",45.44,12.34},{"KLAGENFURT",46.62,14.31},{"LJUBLJANA",46.06,14.51},
    };
    return C;
}

struct RenderOpts {
    bool showCities = true;
    bool showMax    = true;
    bool showGrid   = true;
    int  width      = 1000;   // larghezza immagine desiderata
};

inline RGB pickColor(Kind k, double t) {
    switch (k) {
        case Kind::Precip:   return cmapBlues(t);
        case Kind::Humidity: return cmapBlues(t);
        default:             return cmapYlOrRd(t);  // cape/vento/temp/generico
    }
}

// valore nel punto di griglia più vicino a (lat,lon)
inline double nearestValue(const GribField& g, double lat, double lon) {
    double best = 1e30; double val = std::nan("");
    for (size_t i = 0; i < g.values.size(); ++i) {
        double d = (g.lats[i]-lat)*(g.lats[i]-lat) + (g.lons[i]-lon)*(g.lons[i]-lon);
        if (d < best) { best = d; val = g.values[i]; }
    }
    return val;
}

// Costruisce l'immagine del campo.  Ritorna un'Image pronta da salvare/blit.
inline Image renderField(const GribField& g, Kind k, const RenderOpts& o) {
    const RGB BG{18,26,38}, INK{230,237,247}, BLACK{0,0,0}, WHITE{255,255,255};

    // area dati (bounding box) — la mappa parte da lat max in alto
    double lon0=g.lons[0], lon1=g.lons[0], lat0=g.lats[0], lat1=g.lats[0];
    for (size_t i=0;i<g.lons.size();++i){
        lon0=std::min(lon0,g.lons[i]); lon1=std::max(lon1,g.lons[i]);
        lat0=std::min(lat0,g.lats[i]); lat1=std::max(lat1,g.lats[i]);
    }
    const int mL=8, mR=96, mT=34, mB=18;
    int plotW = o.width - mL - mR;
    double aspect = (lat1-lat0) / std::max(1e-9,(lon1-lon0));
    int plotH = int(plotW * aspect);
    if (plotH < 200) plotH = 200;
    int W = o.width, H = plotH + mT + mB;
    Image img(W, H, BG);

    auto X = [&](double lon){ return mL + int((lon-lon0)/(lon1-lon0)*(plotW-1)); };
    auto Y = [&](double lat){ return mT + int((lat1-lat)/(lat1-lat0)*(plotH-1)); };

    // celle del campo
    double span = (g.vmax - g.vmin);
    if (span <= 0) span = 1;
    double cellW = double(plotW)/g.ni, cellH = double(plotH)/g.nj;
    for (long j=0;j<g.nj;++j){
        for (long i=0;i<g.ni;++i){
            double v = g.values[size_t(j)*g.ni + i];
            RGB col = std::isnan(v) ? RGB{60,60,60}
                                    : pickColor(k, (v-g.vmin)/span);
            int x0 = mL + int(i*cellW),     x1 = mL + int((i+1)*cellW)-1;
            int y0 = mT + int(j*cellH),     y1 = mT + int((j+1)*cellH)-1;
            img.fillRect(x0,y0,x1,y1,col);
        }
    }
    if (o.showGrid) {
        RGB gl{90,90,90};
        for (long i=0;i<=g.ni;++i){ int x=mL+int(i*cellW); img.line(x,mT,x,mT+plotH-1,gl);}
        for (long j=0;j<=g.nj;++j){ int y=mT+int(j*cellH); img.line(mL,y,mL+plotW-1,y,gl);}
    }
    img.rect(mL, mT, mL+plotW-1, mT+plotH-1, INK);

    // colorbar a destra
    int cbx0 = W - mR + 22, cbx1 = cbx0 + 18, cby0 = mT, cby1 = mT + plotH - 1;
    for (int y=cby0; y<=cby1; ++y){
        double t = double(cby1-y)/(cby1-cby0);
        img.fillRect(cbx0,y,cbx1,y, pickColor(k,t));
    }
    img.rect(cbx0,cby0,cbx1,cby1,INK);
    img.text(cbx0-2, cby0-10, std::to_string((long)g.vmax), INK, 1);
    img.text(cbx0-2, cby1+3,  std::to_string((long)g.vmin), INK, 1);

    const char* unit = displayUnit(k, g.units);

    // città
    if (o.showCities) {
        for (const auto& c : cities()) {
            if (c.lon<lon0||c.lon>lon1||c.lat<lat0||c.lat>lat1) continue;
            int cx=X(c.lon), cy=Y(c.lat);
            img.disk(cx,cy,3,WHITE); img.rect(cx-3,cy-3,cx+3,cy+3,BLACK);
            double v = nearestValue(g, c.lat, c.lon);
            std::string lbl = std::string(c.name);
            if (!std::isnan(v)) lbl += " " + std::to_string((long)std::lround(v));
            img.textOutlined(cx+5, cy-3, lbl, WHITE, BLACK, 1);
        }
    }

    // stella sul massimo + badge grande
    if (o.showMax) {
        size_t im=0; double mx=-1e30;
        for (size_t i=0;i<g.values.size();++i)
            if (!std::isnan(g.values[i]) && g.values[i]>mx){ mx=g.values[i]; im=i; }
        img.star(X(g.lons[im]), Y(g.lats[im]), 9, RGB{255,225,77});
        std::string badge = "MAX " + std::to_string((long)std::lround(mx))
                          + " " + unit;
        int bw = img.textWidth(badge,2) + 12;
        img.fillRect(mL+4, 4, mL+4+bw, 28, RGB{192,57,43});
        img.rect(mL+4, 4, mL+4+bw, 28, WHITE);
        img.text(mL+10, 9, badge, WHITE, 2);
    }

    // titolo (in alto a destra dell'area badge)
    std::string title = g.shortName + "  " + g.levelLabel() + "  +" + g.step + "H";
    img.textOutlined(W - mR - img.textWidth(title,1) - 6, 12, title, INK, BLACK, 1);

    // credito: MeteoGrib e' una creazione di Gimmy Pignolo & Anthropic
    std::string credit = "METEOGRIB - GIMMY PIGNOLO & ANTHROPIC";
    img.text(mL, H - 12, credit, RGB{150,170,200}, 1);
    return img;
}

} // namespace mg
#endif
