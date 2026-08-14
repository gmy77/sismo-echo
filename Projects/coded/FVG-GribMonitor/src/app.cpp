// app.cpp — FVG GRIB Monitor. Win32 + GDI+ desktop application.
//
// Layout:  [ control panel | map canvas ]
//   * The control panel is the "form" with all reading options.
//   * The canvas draws a faint FVG basemap (region + province borders + cities)
//     and, on top, the selected GRIB field as a smoothly interpolated, semi-
//     transparent colour overlay — so colours blend instead of forming hard
//     squares, and the map underneath stays visible.
//
// Everything the field rendering needs is portable and lives in grib2/colormap;
// only the GUI, file dialog and networking are Windows-specific.

#ifndef UNICODE
#define UNICODE
#endif
// windows.h defines min()/max() macros that break std::min/std::max (used here
// and in colormap.h). NOMINMAX disables them; gdiplus.h in turn references
// min/max unqualified, so we pull them in from std before including it.
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <windowsx.h>
#include <commctrl.h>
#include <commdlg.h>
#include <shlobj.h>
#include <algorithm>
#include <cmath>
#include <functional>
using std::min;
using std::max;
#include <gdiplus.h>
#include <string>
#include <vector>

#include "grib2.h"
#include "colormap.h"
#include "net.h"
#include "fvg_geo_data.h"

#pragma comment(lib, "gdiplus.lib")
#pragma comment(lib, "comctl32.lib")
#pragma comment(lib, "comdlg32.lib")

using namespace Gdiplus;

// ----------------------------- app constants ------------------------------
static const wchar_t* APP_TITLE = L"FVG GRIB Monitor";
static const char*    APP_VERSION = "1.0.0";   // used for update comparison
static const int PANEL_W = 250;

// Control IDs
enum {
    IDC_COMBO = 1001, IDC_OPEN, IDC_DOWNLOAD, IDC_UPDATE,
    IDC_CITIES, IDC_BORDERS, IDC_ARROWS, IDC_SMOOTH, IDC_CLIP, IDC_DIFF,
    IDC_ALPHA, IDC_STATUS, IDC_INFO
};

// ----------------------------- settings -----------------------------------
struct Settings {
    std::wstring gribUrl =
        L"";  // set in config.ini — the "download latest GRIB" source
    std::string updateOwner = "gmy77";
    std::string updateRepo  = "sismo-echo";
};

static std::wstring exeDir() {
    wchar_t buf[MAX_PATH]; GetModuleFileNameW(nullptr, buf, MAX_PATH);
    std::wstring s(buf); size_t p = s.find_last_of(L"\\/");
    return p == std::wstring::npos ? L"." : s.substr(0, p);
}
static std::string trim(const std::string& s) {
    size_t a = s.find_first_not_of(" \t\r\n");
    size_t b = s.find_last_not_of(" \t\r\n");
    return a == std::string::npos ? "" : s.substr(a, b - a + 1);
}
static std::wstring toW(const std::string& s) {
    int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), nullptr, 0);
    std::wstring w(n, 0); MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), &w[0], n);
    return w;
}
static void loadSettings(Settings& s) {
    std::wstring path = exeDir() + L"\\config.ini";
    FILE* fp = _wfopen(path.c_str(), L"rb");
    if (!fp) return;
    char line[1024];
    while (fgets(line, sizeof(line), fp)) {
        std::string l = trim(line);
        if (l.empty() || l[0] == '#' || l[0] == ';' || l[0] == '[') continue;
        size_t eq = l.find('=');
        if (eq == std::string::npos) continue;
        std::string k = trim(l.substr(0, eq)), v = trim(l.substr(eq + 1));
        if (k == "grib_url")      s.gribUrl = toW(v);
        else if (k == "update_owner") s.updateOwner = v;
        else if (k == "update_repo")  s.updateRepo = v;
    }
    fclose(fp);
}

// ----------------------------- view model ---------------------------------
// A "view" is one selectable reading. Scalar views colour a single field;
// wind views colour the U/V speed magnitude and can draw direction arrows.
struct View {
    std::wstring label;
    cmap::Palette palette;
    const grib2::Field* scalar = nullptr;      // for scalar views
    const grib2::Field* u = nullptr;           // for wind views
    const grib2::Field* v = nullptr;
    bool isWind = false;
    double vmin = 0, vmax = 1;
    double dispOffset = 0;  // added to values only for display (e.g. K -> degC)
    std::wstring unit;
};

// One day's worth of data: the fields parsed from a single GRIB2 file, plus
// the views built from them. Views hold pointers into `fields`, so a Snapshot
// must not have its `fields` vector resized/reassigned after rebuildViewsFor.
struct Snapshot {
    std::wstring dateKey;   // "2026-08-14", from the field's own reference time
    std::wstring refTime;   // "2026-08-14 06:00"
    std::wstring loadedName;
    std::vector<grib2::Field> fields;
    std::vector<View> views;
};

static const size_t HISTORY_DAYS = 4;

struct App {
    Settings settings;
    std::vector<Snapshot> history;  // newest first, up to HISTORY_DAYS entries
    int current = 0;                 // selected view index, shared across days
    int zoomedIdx = -1;              // >=0: showing this one day full-size instead of the grid
    // options
    bool showCities = true, showBorders = true, showArrows = true;
    bool smooth = true, clipFVG = false, showDiff = false;
    int alpha = 200;               // 0..255 overlay opacity
    HWND hwnd = nullptr, combo = nullptr, status = nullptr, info = nullptr;
    ULONG_PTR gdip = 0;
};
static App g;

// Build the list of selectable views from one snapshot's loaded fields.
static void rebuildViewsFor(Snapshot& snap) {
    snap.views.clear();
    // Scalar fields (CAPE, and each U/V component individually).
    for (auto& f : snap.fields) {
        View vw;
        std::string sn = f.shortName();
        vw.scalar = &f;
        vw.vmin = f.minValue; vw.vmax = f.maxValue;
        vw.unit = toW(f.unit());
        if (sn == "T") { vw.dispOffset = -273.15; vw.unit = L"\u00B0C"; }
        if (sn == "U" || sn == "V")
            vw.palette = cmap::diverging();
        else if (sn == "CAPE" || sn == "CIN")
            vw.palette = cmap::cape();
        else
            vw.palette = cmap::windSpeed();
        vw.label = toW(f.label());
        snap.views.push_back(vw);
    }
    // Wind (speed + arrows) for every level that has both U and V.
    for (size_t i = 0; i < snap.fields.size(); ++i) {
        if (snap.fields[i].shortName() != "U") continue;
        for (size_t j = 0; j < snap.fields.size(); ++j) {
            if (snap.fields[j].shortName() != "V") continue;
            if (snap.fields[i].levelType == snap.fields[j].levelType &&
                snap.fields[i].levelValue == snap.fields[j].levelValue &&
                snap.fields[i].ni == snap.fields[j].ni && snap.fields[i].nj == snap.fields[j].nj) {
                View vw; vw.isWind = true;
                vw.u = &snap.fields[i]; vw.v = &snap.fields[j];
                vw.palette = cmap::windSpeed(); vw.unit = L"m/s";
                double mx = 0;
                for (size_t k = 0; k < vw.u->values.size(); ++k) {
                    double uu = vw.u->values[k], vvv = vw.v->values[k];
                    if (!std::isnan(uu) && !std::isnan(vvv)) mx = std::max(mx, std::hypot(uu, vvv));
                }
                vw.vmin = 0; vw.vmax = mx > 0 ? mx : 1;
                vw.label = L"Vento @ " + toW(snap.fields[i].levelText()) + L" (vel.+dir.)";
                snap.views.push_back(vw);
            }
        }
    }
}

// Sample the scalar value a view shows at (lon,lat). For wind views this is
// the speed magnitude sqrt(u^2+v^2).
static double sampleView(const View& vw, double lon, double lat, bool bilinear) {
    auto samp = [&](const grib2::Field& f) {
        if (bilinear) return grib2::sampleBilinear(f, lon, lat);
        // nearest grid point
        int c = (int)std::lround((lon - std::min(f.lon1, f.lon2)) / f.di);
        int r = (int)std::lround((lat - std::min(f.lat1, f.lat2)) / f.dj);
        return f.at(c, r);
    };
    if (vw.isWind) {
        double uu = samp(*vw.u), vv = samp(*vw.v);
        if (std::isnan(uu) || std::isnan(vv)) return std::nan("");
        return std::hypot(uu, vv);
    }
    return samp(*vw.scalar);
}

// Min/max of (today - yesterday) sampled at today's own grid points, ignoring
// missing points. Used to pick a symmetric colour range for "diff" mode.
static void diffRangeForView(const View& today, const View& yesterday, double& outMin, double& outMax) {
    const grib2::Field* grid = today.scalar ? today.scalar : today.u;
    outMin = -1; outMax = 1;
    if (!grid) return;
    bool have = false;
    for (int r = 0; r < grid->nj; ++r) {
        for (int c = 0; c < grid->ni; ++c) {
            double lon = std::min(grid->lon1, grid->lon2) + c * grid->di;
            double lat = std::min(grid->lat1, grid->lat2) + r * grid->dj;
            double a = sampleView(today, lon, lat, false);
            double b = sampleView(yesterday, lon, lat, false);
            if (std::isnan(a) || std::isnan(b)) continue;
            double d = a - b;
            if (!have) { outMin = outMax = d; have = true; }
            else { outMin = std::min(outMin, d); outMax = std::max(outMax, d); }
        }
    }
}

// ----------------------------- projection ---------------------------------
struct Proj {
    double lonMin, lonMax, latMin, latMax, cosLat, scale, ox, oy;
    void setup(int x0, int y0, int w, int h) {
        lonMin = GRIB_LON1; lonMax = GRIB_LON2; latMin = GRIB_LAT1; latMax = GRIB_LAT2;
        cosLat = std::cos((latMin + latMax) * 0.5 * 3.14159265 / 180.0);
        double wp = (lonMax - lonMin) * cosLat, hp = (latMax - latMin);
        double s1 = w / wp, s2 = h / hp;
        scale = std::min(s1, s2);
        ox = x0 + (w - wp * scale) * 0.5;
        oy = y0 + (h - hp * scale) * 0.5;
    }
    PointF toPixel(double lon, double lat) const {
        return PointF((REAL)(ox + (lon - lonMin) * cosLat * scale),
                      (REAL)(oy + (latMax - lat) * scale));
    }
    void toGeo(double px, double py, double& lon, double& lat) const {
        lon = lonMin + (px - ox) / (cosLat * scale);
        lat = latMax - (py - oy) / scale;
    }
};

// Point in polygon (ray casting) on a GeoPt ring, in lon/lat space.
static bool inRegion(const GeoPt* ring, int n, double lon, double lat) {
    bool in = false;
    for (int i = 0, j = n - 1; i < n; j = i++) {
        if (((ring[i].lat > lat) != (ring[j].lat > lat)) &&
            (lon < (ring[j].lon - ring[i].lon) * (lat - ring[i].lat) /
                       (ring[j].lat - ring[i].lat) + ring[i].lon))
            in = !in;
    }
    return in;
}

// ----------------------------- rendering ----------------------------------
static void drawPolyline(Graphics& gfx, const Proj& pr, const GeoPt* pts, int n,
                         const Pen& pen) {
    if (n < 2) return;
    std::vector<PointF> ps(n);
    for (int i = 0; i < n; ++i) ps[i] = pr.toPixel(pts[i].lon, pts[i].lat);
    gfx.DrawLines(&pen, ps.data(), n);
}

// Shared layout constants for the 2x2 history grid, used by both painting
// and mouse hit-testing so they always agree on cell boundaries.
static const int LEGEND_H = 46;
static const int GRID_COLS = 2, GRID_ROWS = 2;

static int gridHeightFor(int h) {
    int gh = h - LEGEND_H;
    return gh < 40 ? h : gh; // avoid a degenerate layout on tiny windows
}

// Rectangle of grid cell `idx` (0..3, row-major, newest first) within the
// canvas area starting at (x0,y0) with size (w,h).
static RECT gridCellRect(int x0, int y0, int w, int h, int idx) {
    int gridH = gridHeightFor(h);
    int cw = w / GRID_COLS, ch = gridH / GRID_ROWS;
    int col = idx % GRID_COLS, row = idx / GRID_COLS;
    RECT cell{ x0 + col * cw, y0 + row * ch,
               (col == GRID_COLS - 1) ? x0 + w : x0 + (col + 1) * cw,
               (row == GRID_ROWS - 1) ? y0 + gridH : y0 + (row + 1) * ch };
    return cell;
}

// Resolve which view index in `snap` (the dayIdx-th loaded day) corresponds
// to the combo's current selection, matched by LABEL rather than raw index —
// different days can have a different field count/order (e.g. an older
// extract without temperature/humidity), so the same array index can point
// at a different variable on a different day.
static int resolveViewIndex(size_t dayIdx, const Snapshot& snap) {
    if (dayIdx == 0) return g.current;
    if (g.history.empty() || g.current < 0 || g.current >= (int)g.history[0].views.size()) return -1;
    const std::wstring& label = g.history[0].views[g.current].label;
    for (size_t i = 0; i < snap.views.size(); ++i)
        if (snap.views[i].label == label) return (int)i;
    return -1;
}

static void paintPlaceholder(Graphics& gfx, RECT cell, const wchar_t* text) {
    SolidBrush bg(Color(255, 246, 248, 250));
    gfx.FillRectangle(&bg, cell.left, cell.top, cell.right - cell.left, cell.bottom - cell.top);
    FontFamily ff(L"Segoe UI"); Font font(&ff, 12, FontStyleRegular, UnitPixel);
    SolidBrush txt(Color(180, 90, 90, 100));
    RectF box; gfx.MeasureString(text, -1, &font, PointF(0, 0), &box);
    REAL cx = cell.left + ((cell.right - cell.left) - box.Width) / 2;
    REAL cy = cell.top + ((cell.bottom - cell.top) - box.Height) / 2;
    gfx.DrawString(text, -1, &font, PointF(cx, cy), &txt);
    Pen frame(Color(255, 210, 212, 218), 1.0f);
    gfx.DrawRectangle(&frame, cell.left, cell.top, cell.right - cell.left - 1, cell.bottom - cell.top - 1);
}

// Paint one day's map (basemap + overlay + borders + arrows + cities + date
// label) into `cell`, using a colour range shared across the whole grid so
// the four days are directly comparable at a glance.
// If `diffAgainst` is non-null, the overlay colours (today - diffAgainst)
// instead of the raw value, using `paletteOverride` (a diverging palette)
// instead of the variable's own palette.
static void paintSnapshotCell(Graphics& gfx, RECT cell, const Snapshot& snap, int viewIdx,
                              double vmin, double vmax,
                              const View* diffAgainst = nullptr,
                              const cmap::Palette* paletteOverride = nullptr) {
    int x0 = cell.left, y0 = cell.top;
    int w = cell.right - cell.left, h = cell.bottom - cell.top;
    if (w <= 0 || h <= 0) return;
    if (viewIdx < 0 || viewIdx >= (int)snap.views.size()) {
        paintPlaceholder(gfx, cell, L"Variabile non disponibile");
        return;
    }
    const View& vw = snap.views[viewIdx];
    const cmap::Palette& pal = paletteOverride ? *paletteOverride : vw.palette;

    SolidBrush bg(Color(255, 246, 248, 250));
    gfx.FillRectangle(&bg, x0, y0, w, h);

    Proj pr; pr.setup(x0, y0, w, h);

    // Faint FVG land fill so the region reads even before data loads.
    {
        std::vector<PointF> ps(FVG_REGION_N);
        for (int i = 0; i < FVG_REGION_N; ++i) ps[i] = pr.toPixel(FVG_REGION[i].lon, FVG_REGION[i].lat);
        SolidBrush land(Color(255, 236, 240, 234));
        gfx.FillPolygon(&land, ps.data(), FVG_REGION_N);
    }

    // Colour overlay for the selected field, using the grid-wide vmin/vmax.
    {
        Bitmap overlay(w, h, PixelFormat32bppARGB);
        BitmapData bd;
        Rect lockR(0, 0, w, h);
        if (overlay.LockBits(&lockR, ImageLockModeWrite, PixelFormat32bppARGB, &bd) == Ok) {
            for (int py = 0; py < h; ++py) {
                uint32_t* row = (uint32_t*)((uint8_t*)bd.Scan0 + py * bd.Stride);
                for (int px = 0; px < w; ++px) {
                    double lon, lat;
                    pr.toGeo(x0 + px + 0.5, y0 + py + 0.5, lon, lat);
                    if (lon < pr.lonMin || lon > pr.lonMax || lat < pr.latMin || lat > pr.latMax) {
                        row[px] = 0; continue;
                    }
                    if (g.clipFVG && !inRegion(FVG_REGION, FVG_REGION_N, lon, lat)) {
                        row[px] = 0; continue;
                    }
                    double val;
                    if (diffAgainst) {
                        double a = sampleView(vw, lon, lat, g.smooth);
                        double b = sampleView(*diffAgainst, lon, lat, g.smooth);
                        val = (std::isnan(a) || std::isnan(b)) ? std::nan("") : (a - b);
                    } else {
                        val = sampleView(vw, lon, lat, g.smooth);
                    }
                    if (std::isnan(val)) { row[px] = 0; continue; }
                    cmap::RGB c = cmap::colorFor(pal, val, vmin, vmax);
                    row[px] = ((uint32_t)g.alpha << 24) | (c.r << 16) | (c.g << 8) | c.b;
                }
            }
            overlay.UnlockBits(&bd);
            gfx.DrawImage(&overlay, x0, y0);
        }
    }

    // Borders on top, thin and semi-transparent so colour dominates.
    if (g.showBorders) {
        Pen prov(Color(150, 90, 90, 100), 1.0f);
        prov.SetDashStyle(DashStyleDash);
        drawPolyline(gfx, pr, FVG_PROV_UD, FVG_PROV_UD_N, prov);
        drawPolyline(gfx, pr, FVG_PROV_GO, FVG_PROV_GO_N, prov);
        drawPolyline(gfx, pr, FVG_PROV_TS, FVG_PROV_TS_N, prov);
        drawPolyline(gfx, pr, FVG_PROV_PN, FVG_PROV_PN_N, prov);
        Pen region(Color(220, 40, 40, 55), 1.8f);
        drawPolyline(gfx, pr, FVG_REGION, FVG_REGION_N, region);
    }

    // Wind arrows. On a wind view use its own U/V; on any other field (CAPE, a
    // single component) overlay this day's surface (10 m) wind.
    if (g.showArrows) {
        const grib2::Field *fu = nullptr, *fv = nullptr;
        if (vw.isWind) { fu = vw.u; fv = vw.v; }
        else {
            for (auto& a : snap.fields) {
                if (a.shortName() != "U") continue;
                for (auto& b : snap.fields) {
                    if (b.shortName() != "V") continue;
                    if (a.levelType == b.levelType && a.levelValue == b.levelValue)
                        if (!fu || a.levelType == 103) { fu = &a; fv = &b; } // prefer 10 m
                }
            }
        }
        if (fu && fv) {
            Pen halo(Color(200, 255, 255, 255), 2.6f); // white outline for contrast
            Pen ap(Color(235, 15, 15, 25), 1.3f);
            for (int r = 0; r < fu->nj; ++r) {
                for (int c = 0; c < fu->ni; ++c) {
                    double uu = fu->at(c, r), vv = fv->at(c, r);
                    if (std::isnan(uu) || std::isnan(vv)) continue;
                    double lon = std::min(fu->lon1, fu->lon2) + c * fu->di;
                    double lat = std::min(fu->lat1, fu->lat2) + r * fu->dj;
                    if (g.clipFVG && !inRegion(FVG_REGION, FVG_REGION_N, lon, lat)) continue;
                    PointF base = pr.toPixel(lon, lat);
                    double spd = std::hypot(uu, vv);
                    double L = std::min(18.0, 5.0 + spd * 2.2);
                    // meteo convention: arrow points TO where the wind blows (u east, v north).
                    double dx = (spd > 1e-6 ? uu / spd : 0) * L;
                    double dy = -(spd > 1e-6 ? vv / spd : 0) * L; // screen y is down
                    PointF tip((REAL)(base.X + dx), (REAL)(base.Y + dy));
                    double ang = std::atan2(dy, dx);
                    PointF h1((REAL)(tip.X + 5 * std::cos(ang + 2.6)), (REAL)(tip.Y + 5 * std::sin(ang + 2.6)));
                    PointF h2((REAL)(tip.X + 5 * std::cos(ang - 2.6)), (REAL)(tip.Y + 5 * std::sin(ang - 2.6)));
                    gfx.DrawLine(&halo, base, tip);
                    gfx.DrawLine(&halo, tip, h1); gfx.DrawLine(&halo, tip, h2);
                    gfx.DrawLine(&ap, base, tip);
                    gfx.DrawLine(&ap, tip, h1); gfx.DrawLine(&ap, tip, h2);
                }
            }
        }
    }

    // Cities.
    if (g.showCities) {
        FontFamily ff(L"Segoe UI");
        Font font(&ff, 9, FontStyleBold, UnitPixel);
        SolidBrush dot(Color(255, 25, 25, 35));
        SolidBrush halo(Color(235, 255, 255, 255));
        SolidBrush txt(Color(255, 20, 20, 30));
        for (int i = 0; i < FVG_CITIES_N; ++i) {
            PointF p = pr.toPixel(FVG_CITIES[i].lon, FVG_CITIES[i].lat);
            gfx.FillEllipse(&dot, p.X - 2.0f, p.Y - 2.0f, 4.0f, 4.0f);
            std::wstring nm = toW(FVG_CITIES[i].name);
            gfx.DrawString(nm.c_str(), -1, &font, PointF(p.X + 5, p.Y - 6), &halo);
            gfx.DrawString(nm.c_str(), -1, &font, PointF(p.X + 5, p.Y - 6), &txt);
        }
    }

    // Date/time label, top-left of the cell, with a halo backing.
    {
        FontFamily ff(L"Segoe UI"); Font font(&ff, 12, FontStyleBold, UnitPixel);
        SolidBrush halo(Color(220, 255, 255, 255));
        SolidBrush txt(Color(255, 20, 20, 30));
        std::wstring lbl = snap.refTime.empty() ? snap.dateKey : snap.refTime + L" UTC";
        if (diffAgainst) lbl += L" (\u0394 vs giorno prima)";
        for (int dx = -1; dx <= 1; ++dx) for (int dy = -1; dy <= 1; ++dy)
            gfx.DrawString(lbl.c_str(), -1, &font, PointF((REAL)(x0 + 6 + dx), (REAL)(y0 + 4 + dy)), &halo);
        gfx.DrawString(lbl.c_str(), -1, &font, PointF((REAL)(x0 + 6), (REAL)(y0 + 4)), &txt);
    }

    Pen frame(Color(255, 210, 212, 218), 1.0f);
    gfx.DrawRectangle(&frame, x0, y0, w - 1, h - 1);
}

// Draw a horizontal colour-bar legend with min/max labels at (x0, ly).
static void drawLegendStrip(Graphics& gfx, int x0, int ly, const cmap::Palette& palette,
                            double vmin, double vmax, const std::wstring& unit, double dispOffset) {
    int lx = x0 + 14, lw = 160, lh = 14;
    for (int i = 0; i < lw; ++i) {
        double t = (double)i / (lw - 1);
        double val = vmin + t * (vmax - vmin);
        cmap::RGB c = cmap::colorFor(palette, val, vmin, vmax);
        Pen p(Color(255, c.r, c.g, c.b));
        gfx.DrawLine(&p, (REAL)(lx + i), (REAL)ly, (REAL)(lx + i), (REAL)(ly + lh));
    }
    Pen frame(Color(255, 60, 60, 70)); gfx.DrawRectangle(&frame, lx, ly, lw, lh);
    FontFamily ff(L"Segoe UI"); Font font(&ff, 11, FontStyleRegular, UnitPixel);
    SolidBrush txt(Color(255, 20, 20, 30));
    wchar_t buf[64];
    swprintf(buf, 64, L"%.0f", vmin + dispOffset);
    gfx.DrawString(buf, -1, &font, PointF((REAL)lx, (REAL)(ly + lh + 2)), &txt);
    swprintf(buf, 64, L"%.0f %s", vmax + dispOffset, unit.c_str());
    RectF box; gfx.MeasureString(buf, -1, &font, PointF(0, 0), &box);
    gfx.DrawString(buf, -1, &font, PointF((REAL)(lx + lw - box.Width), (REAL)(ly + lh + 2)), &txt);
}

static void paintMap(HDC hdc, RECT rc) {
    Graphics gfx(hdc);
    gfx.SetSmoothingMode(SmoothingModeAntiAlias);
    gfx.SetInterpolationMode(InterpolationModeBilinear);

    int x0 = PANEL_W, y0 = 0;
    int w = rc.right - PANEL_W, h = rc.bottom;
    if (w <= 0 || h <= 0) return;

    // Background.
    SolidBrush bg(Color(255, 246, 248, 250));
    gfx.FillRectangle(&bg, x0, y0, w, h);

    int gridH = gridHeightFor(h);
    bool zoomed = g.zoomedIdx >= 0 && (size_t)g.zoomedIdx < g.history.size();

    if (zoomed) {
        // Single enlarged day, optionally coloured by its diff vs the next-
        // older loaded day, filling the whole grid area.
        size_t di = (size_t)g.zoomedIdx;
        const Snapshot& snap = g.history[di];
        int vi = resolveViewIndex(di, snap);
        const View* diffAgainst = nullptr;
        if (g.showDiff && di + 1 < g.history.size()) {
            int pvi = resolveViewIndex(di + 1, g.history[di + 1]);
            if (vi >= 0 && vi < (int)snap.views.size() && pvi >= 0 && pvi < (int)g.history[di + 1].views.size())
                diffAgainst = &g.history[di + 1].views[pvi];
        }
        RECT full{ x0, y0, x0 + w, y0 + gridH };
        double vmin = 0, vmax = 1; std::wstring unit; cmap::Palette palette = cmap::cape(); double dispOffset = 0;
        if (vi >= 0 && vi < (int)snap.views.size()) {
            const View& vw = snap.views[vi];
            if (diffAgainst) {
                diffRangeForView(vw, *diffAgainst, vmin, vmax);
                double m = std::max(std::fabs(vmin), std::fabs(vmax)); vmin = -m; vmax = m;
                palette = cmap::diverging(); unit = vw.unit; dispOffset = 0;
            } else {
                vmin = vw.vmin; vmax = vw.vmax; palette = vw.palette; unit = vw.unit; dispOffset = vw.dispOffset;
            }
            paintSnapshotCell(gfx, full, snap, vi, vmin, vmax, diffAgainst, diffAgainst ? &palette : nullptr);
        } else {
            paintPlaceholder(gfx, full, L"Variabile non disponibile");
        }
        drawLegendStrip(gfx, x0, y0 + gridH + 8, palette, vmin, vmax, unit, dispOffset);

        FontFamily ff(L"Segoe UI"); Font font(&ff, 11, FontStyleRegular, UnitPixel);
        SolidBrush hintBg(Color(210, 255, 255, 255)); SolidBrush hintTxt(Color(255, 60, 60, 70));
        const wchar_t* hint = L"Clic per tornare alla griglia";
        RectF box; gfx.MeasureString(hint, -1, &font, PointF(0, 0), &box);
        gfx.FillRectangle(&hintBg, (REAL)(x0 + w - box.Width - 16), (REAL)(y0 + 6), box.Width + 10, box.Height + 6);
        gfx.DrawString(hint, -1, &font, PointF((REAL)(x0 + w - box.Width - 11), (REAL)(y0 + 9)), &hintTxt);
    } else {
        // Resolve, per loaded day, which of its OWN views is the selected
        // variable (by label — see resolveViewIndex).
        std::vector<int> cellViewIdx(g.history.size(), -1);
        for (size_t i = 0; i < g.history.size(); ++i) cellViewIdx[i] = resolveViewIndex(i, g.history[i]);

        // In diff mode, each cell (but the oldest loaded) colours by its
        // delta vs the next-older day, using one shared symmetric range.
        std::vector<const View*> cellDiffAgainst(g.history.size(), nullptr);
        if (g.showDiff) {
            for (size_t i = 0; i + 1 < g.history.size(); ++i) {
                int vi = cellViewIdx[i], pvi = resolveViewIndex(i + 1, g.history[i + 1]);
                if (vi >= 0 && vi < (int)g.history[i].views.size() &&
                    pvi >= 0 && pvi < (int)g.history[i + 1].views.size())
                    cellDiffAgainst[i] = &g.history[i + 1].views[pvi];
            }
        }

        double vmin = 0, vmax = 1; bool haveRange = false;
        cmap::Palette palette = cmap::cape(); std::wstring unit; double dispOffset = 0;
        if (g.showDiff) {
            double maxAbs = 0; bool have = false;
            for (size_t i = 0; i < g.history.size(); ++i) {
                if (!cellDiffAgainst[i]) continue;
                const View& vw = g.history[i].views[cellViewIdx[i]];
                double dmin, dmax; diffRangeForView(vw, *cellDiffAgainst[i], dmin, dmax);
                maxAbs = std::max({ maxAbs, std::fabs(dmin), std::fabs(dmax) });
                if (!have) { unit = vw.unit; have = true; }
            }
            if (maxAbs < 1e-9) maxAbs = 1;
            vmin = -maxAbs; vmax = maxAbs; palette = cmap::diverging(); dispOffset = 0;
            haveRange = have;
        } else {
            for (size_t i = 0; i < g.history.size(); ++i) {
                int vi = cellViewIdx[i];
                if (vi < 0 || vi >= (int)g.history[i].views.size()) continue;
                const View& vw = g.history[i].views[vi];
                if (!haveRange) { vmin = vw.vmin; vmax = vw.vmax; palette = vw.palette; unit = vw.unit; dispOffset = vw.dispOffset; haveRange = true; }
                else { vmin = std::min(vmin, vw.vmin); vmax = std::max(vmax, vw.vmax); }
            }
        }

        for (int i = 0; i < GRID_COLS * GRID_ROWS; ++i) {
            RECT cell = gridCellRect(x0, y0, w, h, i);
            if ((size_t)i < g.history.size())
                paintSnapshotCell(gfx, cell, g.history[i], cellViewIdx[i], vmin, vmax,
                                  cellDiffAgainst[i], g.showDiff ? &palette : nullptr);
            else
                paintPlaceholder(gfx, cell, L"Nessun dato");
        }

        if (haveRange) drawLegendStrip(gfx, x0, y0 + gridH + 8, palette, vmin, vmax, unit, dispOffset);
    }

    // Discreet copyright watermark (bottom-right of the map).
    {
        FontFamily ff(L"Segoe UI"); Font font(&ff, 10, FontStyleRegular, UnitPixel);
        SolidBrush wm(Color(150, 40, 40, 55));
        const wchar_t* credit = L"\x00A9 2026 Gimmy (gmy77) \x2014 sviluppato con Claude (Anthropic)";
        RectF box; gfx.MeasureString(credit, -1, &font, PointF(0, 0), &box);
        gfx.DrawString(credit, -1, &font,
                       PointF((REAL)(x0 + w - box.Width - 10), (REAL)(y0 + h - box.Height - 4)), &wm);
    }
}

// ----------------------------- info text ----------------------------------
static void updateInfo() {
    std::wstring s;
    if (g.history.empty()) {
        s = L"File: (nessun dato)";
    } else {
        const Snapshot& top = g.history[0];
        s = L"File: " + top.loadedName + L"\r\n";
        if (!top.refTime.empty()) s += L"Emissione: " + top.refTime + L" UTC\r\n";
        s += L"Campi: " + std::to_wstring((int)top.fields.size()) + L"\r\n";
        s += L"Storico: " + std::to_wstring((int)g.history.size()) + L"/" + std::to_wstring((int)HISTORY_DAYS) + L" giorni";
    }
    if (g.info) SetWindowTextW(g.info, s.c_str());
}
static void setStatus(const std::wstring& s) { if (g.status) SetWindowTextW(g.status, s.c_str()); }

// ----------------------------- loading ------------------------------------
static bool readFileBytes(const std::wstring& path, std::vector<uint8_t>& buf, std::wstring& errMsg) {
    FILE* fp = _wfopen(path.c_str(), L"rb");
    if (!fp) { errMsg = L"Impossibile aprire il file."; return false; }
    fseek(fp, 0, SEEK_END); long n = ftell(fp); fseek(fp, 0, SEEK_SET);
    buf.assign(n > 0 ? (size_t)n : 0, 0);
    if (n > 0 && fread(buf.data(), 1, (size_t)n, fp) != (size_t)n) {
        fclose(fp); errMsg = L"Lettura fallita."; return false;
    }
    fclose(fp);
    return true;
}

// Parse a GRIB2 file on disk into a fully-built Snapshot (fields + views +
// date key taken from the file's own reference time, not the system clock).
static bool parseSnapshot(const std::wstring& path, Snapshot& snap, std::wstring& errMsg) {
    std::vector<uint8_t> buf;
    if (!readFileBytes(path, buf, errMsg)) return false;
    std::string err;
    auto fields = grib2::parse(buf.data(), buf.size(), &err);
    if (fields.empty()) { errMsg = L"Nessun campo GRIB2 valido nel file."; return false; }
    snap.fields = std::move(fields);
    rebuildViewsFor(snap);
    size_t sl = path.find_last_of(L"\\/");
    snap.loadedName = sl == std::wstring::npos ? path : path.substr(sl + 1);
    wchar_t db[16], rb[64];
    swprintf(db, 16, L"%04d-%02d-%02d", snap.fields[0].year, snap.fields[0].month, snap.fields[0].day);
    snap.dateKey = db;
    swprintf(rb, 64, L"%04d-%02d-%02d %02d:%02d", snap.fields[0].year, snap.fields[0].month,
             snap.fields[0].day, snap.fields[0].hour, snap.fields[0].minute);
    snap.refTime = rb;
    return true;
}

static std::wstring historyDir() { return exeDir() + L"\\history"; }
static void ensureHistoryDir() { CreateDirectoryW(historyDir().c_str(), nullptr); }

// "FVG_YYYY-MM-DD.grib2" file names in the history folder, newest day first
// (plain lexical sort works because the date is fixed-width and zero-padded).
static std::vector<std::wstring> listHistoryFilesDesc() {
    std::vector<std::wstring> out;
    WIN32_FIND_DATAW fd;
    HANDLE h = FindFirstFileW((historyDir() + L"\\FVG_*.grib2").c_str(), &fd);
    if (h != INVALID_HANDLE_VALUE) {
        do { out.push_back(fd.cFileName); } while (FindNextFileW(h, &fd));
        FindClose(h);
    }
    std::sort(out.begin(), out.end(), std::greater<std::wstring>());
    return out;
}

// Keep only the HISTORY_DAYS most recent daily files on disk.
static void pruneHistory() {
    auto files = listHistoryFilesDesc();
    for (size_t i = HISTORY_DAYS; i < files.size(); ++i)
        DeleteFileW((historyDir() + L"\\" + files[i]).c_str());
}

// Repopulate the combo box from the most recent snapshot's variable list and
// keep the current selection if it's still valid (default to CAPE otherwise).
static void populateComboAndDefaults() {
    SendMessageW(g.combo, CB_RESETCONTENT, 0, 0);
    if (g.history.empty()) { updateInfo(); return; }
    const Snapshot& top = g.history[0];
    if (g.current < 0 || g.current >= (int)top.views.size()) {
        g.current = 0;
        for (size_t i = 0; i < top.views.size(); ++i)
            if (top.views[i].scalar && top.views[i].scalar->shortName() == "CAPE") { g.current = (int)i; break; }
    }
    for (auto& v : top.views) SendMessageW(g.combo, CB_ADDSTRING, 0, (LPARAM)v.label.c_str());
    SendMessageW(g.combo, CB_SETCURSEL, g.current, 0);
    updateInfo();
}

// Load up to HISTORY_DAYS most recent daily snapshots from the history
// folder into the grid. Used at startup and after every successful download.
static void historyLoadAll() {
    g.history.clear();
    g.zoomedIdx = -1;
    auto files = listHistoryFilesDesc();
    for (size_t i = 0; i < files.size() && i < HISTORY_DAYS; ++i) {
        Snapshot snap; std::wstring err;
        if (parseSnapshot(historyDir() + L"\\" + files[i], snap, err))
            g.history.push_back(std::move(snap));
    }
    populateComboAndDefaults();
    if (g.hwnd) InvalidateRect(g.hwnd, nullptr, FALSE);
}

// Copy a downloaded/opened GRIB file into the history folder, keyed by the
// date embedded in the file itself, overwriting today's slot if already
// present, then reload the whole grid from disk.
static bool ingestIntoHistory(const std::wstring& srcPath, std::wstring& statusMsg) {
    Snapshot probe;
    if (!parseSnapshot(srcPath, probe, statusMsg)) return false;
    ensureHistoryDir();
    std::wstring dest = historyDir() + L"\\FVG_" + probe.dateKey + L".grib2";
    if (!CopyFileW(srcPath.c_str(), dest.c_str(), FALSE)) {
        statusMsg = L"Impossibile salvare nello storico."; return false;
    }
    pruneHistory();
    historyLoadAll();
    statusMsg = L"Storico aggiornato: " + std::to_wstring((int)g.history.size()) + L"/" +
                std::to_wstring((int)HISTORY_DAYS) + L" giorni.";
    return true;
}

// Show a single arbitrary file (e.g. a sample, or "Apri file...") as a
// one-off preview in the grid's first cell, WITHOUT touching the persisted
// daily history on disk.
static void openPreview(const std::wstring& path) {
    Snapshot snap; std::wstring err;
    if (!parseSnapshot(path, snap, err)) { setStatus(err); return; }
    g.history.clear();
    g.zoomedIdx = -1;
    g.history.push_back(std::move(snap));
    populateComboAndDefaults();
    setStatus(L"Caricati " + std::to_wstring((int)g.history[0].views.size()) +
              L" tipi di lettura (anteprima singola, non salvata nello storico).");
    if (g.hwnd) InvalidateRect(g.hwnd, nullptr, FALSE);
}

// ----------------------------- actions ------------------------------------
static void actionOpen() {
    wchar_t file[MAX_PATH] = L"";
    OPENFILENAMEW ofn; ZeroMemory(&ofn, sizeof(ofn));
    ofn.lStructSize = sizeof(ofn); ofn.hwndOwner = g.hwnd;
    ofn.lpstrFilter = L"File GRIB (*.grib2;*.grb2;*.grib;*.grb)\0*.grib2;*.grb2;*.grib;*.grb\0Tutti i file\0*.*\0";
    ofn.lpstrFile = file; ofn.nMaxFile = MAX_PATH;
    ofn.Flags = OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST;
    if (GetOpenFileNameW(&ofn)) openPreview(file);
}

static void actionDownload() {
    if (g.settings.gribUrl.empty()) {
        MessageBoxW(g.hwnd,
            L"Nessun URL configurato.\n\nApri config.ini (accanto all'eseguibile) e "
            L"imposta:\n    grib_url = https://.../FVG_CAPE.grib2",
            L"Sorgente GRIB non configurata", MB_ICONINFORMATION);
        return;
    }
    setStatus(L"Download in corso...");
    HCURSOR old = SetCursor(LoadCursor(nullptr, IDC_WAIT));
    std::wstring dest = exeDir() + L"\\latest.grib2";
    std::string err;
    bool ok = net::downloadToFile(g.settings.gribUrl, dest, err);
    SetCursor(old);
    if (!ok) { setStatus(L"Download fallito: " + toW(err)); return; }
    std::wstring msg;
    if (ingestIntoHistory(dest, msg)) setStatus(msg);
    else setStatus(L"Download riuscito ma non elaborabile: " + msg);
}

static void actionCheckUpdate() {
    setStatus(L"Controllo aggiornamenti...");
    HCURSOR old = SetCursor(LoadCursor(nullptr, IDC_WAIT));
    net::Release rel; std::string err;
    bool ok = net::latestRelease(g.settings.updateOwner, g.settings.updateRepo, rel, err);
    SetCursor(old);
    if (!ok) { setStatus(L"Controllo fallito: " + toW(err)); return; }
    int cmp = net::compareVersions(rel.tag, APP_VERSION);
    if (cmp > 0) {
        std::wstring msg = L"Nuova versione disponibile: " + toW(rel.tag) +
                           L"\n(attuale " + toW(APP_VERSION) + L")\n\nAprire la pagina di download?";
        if (MessageBoxW(g.hwnd, msg.c_str(), L"Aggiornamento", MB_YESNO | MB_ICONINFORMATION) == IDYES) {
            std::wstring url = rel.assetUrl.empty() ? toW(rel.htmlUrl) : toW(rel.assetUrl);
            ShellExecuteW(nullptr, L"open", url.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
        }
        setStatus(L"Aggiornamento " + toW(rel.tag) + L" disponibile.");
    } else {
        setStatus(L"Sei gia' all'ultima versione (" + toW(APP_VERSION) + L").");
    }
}

// ----------------------------- window -------------------------------------
static HWND mkButton(HWND parent, const wchar_t* text, int id, int x, int y, int w, int h) {
    return CreateWindowExW(0, L"BUTTON", text, WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON,
                           x, y, w, h, parent, (HMENU)(INT_PTR)id, nullptr, nullptr);
}
static HWND mkCheck(HWND parent, const wchar_t* text, int id, int x, int y, bool on) {
    HWND h = CreateWindowExW(0, L"BUTTON", text, WS_CHILD | WS_VISIBLE | BS_AUTOCHECKBOX,
                             x, y, PANEL_W - 30, 22, parent, (HMENU)(INT_PTR)id, nullptr, nullptr);
    SendMessageW(h, BM_SETCHECK, on ? BST_CHECKED : BST_UNCHECKED, 0);
    return h;
}
static HWND mkLabel(HWND parent, const wchar_t* text, int x, int y, int w, int h, int id = -1) {
    return CreateWindowExW(0, L"STATIC", text, WS_CHILD | WS_VISIBLE,
                           x, y, w, h, parent, (HMENU)(INT_PTR)id, nullptr, nullptr);
}

static LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
    case WM_CREATE: {
        int x = 15, y = 12;
        mkLabel(hwnd, L"Tipo di lettura:", x, y, PANEL_W - 30, 18); y += 20;
        g.combo = CreateWindowExW(0, L"COMBOBOX", nullptr,
            WS_CHILD | WS_VISIBLE | CBS_DROPDOWNLIST | WS_VSCROLL,
            x, y, PANEL_W - 30, 200, hwnd, (HMENU)(INT_PTR)IDC_COMBO, nullptr, nullptr);
        y += 34;
        mkCheck(hwnd, L"Mostra citta'",        IDC_CITIES,  x, y, g.showCities);  y += 24;
        mkCheck(hwnd, L"Mostra confini",        IDC_BORDERS, x, y, g.showBorders); y += 24;
        mkCheck(hwnd, L"Frecce vento",          IDC_ARROWS,  x, y, g.showArrows);  y += 24;
        mkCheck(hwnd, L"Sfumatura morbida",     IDC_SMOOTH,  x, y, g.smooth);      y += 24;
        mkCheck(hwnd, L"Ritaglia sul FVG",      IDC_CLIP,    x, y, g.clipFVG);     y += 24;
        mkCheck(hwnd, L"Confronta con ieri",    IDC_DIFF,    x, y, g.showDiff);  y += 30;

        mkLabel(hwnd, L"Opacita' colori:", x, y, PANEL_W - 30, 18); y += 20;
        HWND slider = CreateWindowExW(0, TRACKBAR_CLASSW, nullptr,
            WS_CHILD | WS_VISIBLE | TBS_HORZ, x, y, PANEL_W - 30, 28,
            hwnd, (HMENU)(INT_PTR)IDC_ALPHA, nullptr, nullptr);
        SendMessageW(slider, TBM_SETRANGE, TRUE, MAKELONG(60, 255));
        SendMessageW(slider, TBM_SETPOS, TRUE, g.alpha);
        y += 40;

        mkButton(hwnd, L"Apri file GRIB...",       IDC_OPEN,     x, y, PANEL_W - 30, 30); y += 36;
        mkButton(hwnd, L"Scarica ultimo GRIB",     IDC_DOWNLOAD, x, y, PANEL_W - 30, 30); y += 36;
        mkButton(hwnd, L"Controlla aggiornamenti", IDC_UPDATE,   x, y, PANEL_W - 30, 30); y += 42;

        g.info = mkLabel(hwnd, L"", x, y, PANEL_W - 30, 78, IDC_INFO); y += 84;
        g.status = mkLabel(hwnd, L"Pronto.", x, y, PANEL_W - 30, 52, IDC_STATUS); y += 58;
        mkLabel(hwnd, L"\x00A9 2026 Gimmy (gmy77)\r\nFVG GRIB Monitor v1.0.0\r\nSviluppato con Claude (Anthropic)",
                x, y, PANEL_W - 30, 50, -1);
        updateInfo();
        return 0;
    }
    case WM_COMMAND: {
        int id = LOWORD(wp), code = HIWORD(wp);
        switch (id) {
        case IDC_COMBO:
            if (code == CBN_SELCHANGE) {
                g.current = (int)SendMessageW(g.combo, CB_GETCURSEL, 0, 0);
                InvalidateRect(hwnd, nullptr, FALSE);
            }
            break;
        case IDC_OPEN:     actionOpen(); break;
        case IDC_DOWNLOAD: actionDownload(); break;
        case IDC_UPDATE:   actionCheckUpdate(); break;
        case IDC_CITIES:  g.showCities  = SendMessageW((HWND)lp, BM_GETCHECK, 0, 0) == BST_CHECKED; InvalidateRect(hwnd, nullptr, FALSE); break;
        case IDC_BORDERS: g.showBorders = SendMessageW((HWND)lp, BM_GETCHECK, 0, 0) == BST_CHECKED; InvalidateRect(hwnd, nullptr, FALSE); break;
        case IDC_ARROWS:  g.showArrows  = SendMessageW((HWND)lp, BM_GETCHECK, 0, 0) == BST_CHECKED; InvalidateRect(hwnd, nullptr, FALSE); break;
        case IDC_SMOOTH:  g.smooth      = SendMessageW((HWND)lp, BM_GETCHECK, 0, 0) == BST_CHECKED; InvalidateRect(hwnd, nullptr, FALSE); break;
        case IDC_CLIP:    g.clipFVG     = SendMessageW((HWND)lp, BM_GETCHECK, 0, 0) == BST_CHECKED; InvalidateRect(hwnd, nullptr, FALSE); break;
        case IDC_DIFF:    g.showDiff    = SendMessageW((HWND)lp, BM_GETCHECK, 0, 0) == BST_CHECKED; InvalidateRect(hwnd, nullptr, FALSE); break;
        }
        return 0;
    }
    case WM_HSCROLL: {
        if (GetDlgCtrlID((HWND)lp) == IDC_ALPHA) {
            g.alpha = (int)SendMessageW((HWND)lp, TBM_GETPOS, 0, 0);
            InvalidateRect(hwnd, nullptr, FALSE);
        }
        return 0;
    }
    case WM_MOUSEMOVE: {
        // Read out the value under the cursor (of whichever grid cell — or
        // the single zoomed-in day — the cursor is over) into the status line.
        int mx = GET_X_LPARAM(lp), my = GET_Y_LPARAM(lp);
        if (mx >= PANEL_W && !g.history.empty()) {
            RECT rc; GetClientRect(hwnd, &rc);
            int x0 = PANEL_W, y0 = 0, w = rc.right - PANEL_W, h = rc.bottom;
            int gridH = gridHeightFor(h);
            bool zoomed = g.zoomedIdx >= 0 && (size_t)g.zoomedIdx < g.history.size();
            if (my < y0 + gridH) {
                int idx;
                RECT cell;
                if (zoomed) { idx = g.zoomedIdx; cell = RECT{ x0, y0, x0 + w, y0 + gridH }; }
                else {
                    int cw = w / GRID_COLS, ch = gridH / GRID_ROWS;
                    int col = std::min(GRID_COLS - 1, (mx - x0) / std::max(1, cw));
                    int row = std::min(GRID_ROWS - 1, my / std::max(1, ch));
                    idx = row * GRID_COLS + col;
                    cell = gridCellRect(x0, y0, w, h, idx);
                }
                if ((size_t)idx < g.history.size()) {
                    const Snapshot& snap = g.history[idx];
                    int vi = resolveViewIndex((size_t)idx, snap);
                    Proj pr; pr.setup(cell.left, cell.top, cell.right - cell.left, cell.bottom - cell.top);
                    double lon, lat; pr.toGeo(mx, my, lon, lat);
                    if (vi >= 0 && vi < (int)snap.views.size() &&
                        lon >= pr.lonMin && lon <= pr.lonMax && lat >= pr.latMin && lat <= pr.latMax) {
                        const View& vw = snap.views[vi];
                        double v = sampleView(vw, lon, lat, g.smooth);
                        wchar_t b[192];
                        if (!std::isnan(v))
                            swprintf(b, 192, L"%s\r\n%.3f N  %.3f E\r\n%.1f %s",
                                     snap.dateKey.c_str(), lat, lon, v + vw.dispOffset, vw.unit.c_str());
                        else
                            swprintf(b, 192, L"%s\r\n%.3f N  %.3f E", snap.dateKey.c_str(), lat, lon);
                        setStatus(b);
                    }
                }
            }
        }
        return 0;
    }
    case WM_LBUTTONDOWN: {
        // Click a grid cell to zoom into that day full-size; click the
        // zoomed map to go back to the 2x2 grid.
        int mx = GET_X_LPARAM(lp), my = GET_Y_LPARAM(lp);
        if (mx >= PANEL_W && !g.history.empty()) {
            RECT rc; GetClientRect(hwnd, &rc);
            int x0 = PANEL_W, y0 = 0, w = rc.right - PANEL_W, h = rc.bottom;
            int gridH = gridHeightFor(h);
            if (my < y0 + gridH) {
                if (g.zoomedIdx >= 0) {
                    g.zoomedIdx = -1;
                } else {
                    int cw = w / GRID_COLS, ch = gridH / GRID_ROWS;
                    int col = std::min(GRID_COLS - 1, (mx - x0) / std::max(1, cw));
                    int row = std::min(GRID_ROWS - 1, my / std::max(1, ch));
                    int idx = row * GRID_COLS + col;
                    if ((size_t)idx < g.history.size()) g.zoomedIdx = idx;
                }
                InvalidateRect(hwnd, nullptr, FALSE);
            }
        }
        return 0;
    }
    case WM_ERASEBKGND:
        return 1; // avoid flicker; we paint everything
    case WM_PAINT: {
        PAINTSTRUCT ps; HDC hdc = BeginPaint(hwnd, &ps);
        RECT rc; GetClientRect(hwnd, &rc);
        // Panel background.
        HBRUSH pb = CreateSolidBrush(RGB(238, 240, 244));
        RECT pr = { 0, 0, PANEL_W, rc.bottom };
        FillRect(hdc, &pr, pb); DeleteObject(pb);
        // Double-buffer the map to avoid flicker.
        int mw = rc.right - PANEL_W, mh = rc.bottom;
        if (mw > 0 && mh > 0) {
            HDC mem = CreateCompatibleDC(hdc);
            HBITMAP bmp = CreateCompatibleBitmap(hdc, rc.right, rc.bottom);
            HBITMAP old = (HBITMAP)SelectObject(mem, bmp);
            paintMap(mem, rc);
            BitBlt(hdc, PANEL_W, 0, mw, mh, mem, PANEL_W, 0, SRCCOPY);
            SelectObject(mem, old); DeleteObject(bmp); DeleteDC(mem);
        }
        EndPaint(hwnd, &ps);
        return 0;
    }
    case WM_SIZE:
        InvalidateRect(hwnd, nullptr, FALSE);
        return 0;
    case WM_DESTROY:
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProcW(hwnd, msg, wp, lp);
}

int WINAPI wWinMain(HINSTANCE hInst, HINSTANCE, PWSTR cmdLine, int nShow) {
    loadSettings(g.settings);

    // Headless mode for Task Scheduler: download today's GRIB, update the
    // history folder on disk, then exit without ever showing a window — no
    // GDI+/UI touched, so it's safe to run in the background daily.
    {
        std::wstring cmdArg = cmdLine ? cmdLine : L"";
        if (!cmdArg.empty() && cmdArg.front() == L'"') cmdArg = cmdArg.substr(1, cmdArg.find_last_of(L'"') - 1);
        if (cmdArg == L"--download-silent") {
            if (g.settings.gribUrl.empty()) return 1;
            ensureHistoryDir();
            std::wstring dest = exeDir() + L"\\latest.grib2";
            std::string neterr;
            if (!net::downloadToFile(g.settings.gribUrl, dest, neterr)) return 1;
            Snapshot probe; std::wstring perr;
            if (!parseSnapshot(dest, probe, perr)) return 1;
            std::wstring histDest = historyDir() + L"\\FVG_" + probe.dateKey + L".grib2";
            if (!CopyFileW(dest.c_str(), histDest.c_str(), FALSE)) return 1;
            pruneHistory();
            return 0;
        }
    }

    GdiplusStartupInput gi;
    GdiplusStartup(&g.gdip, &gi, nullptr);
    INITCOMMONCONTROLSEX ic{ sizeof(ic), ICC_BAR_CLASSES | ICC_STANDARD_CLASSES };
    InitCommonControlsEx(&ic);

    WNDCLASSW wc{}; wc.lpfnWndProc = WndProc; wc.hInstance = hInst;
    wc.lpszClassName = L"FVGGribMonitorWnd";
    wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
    wc.hbrBackground = (HBRUSH)(COLOR_WINDOW + 1);
    wc.hIcon = LoadIcon(nullptr, IDI_APPLICATION);
    RegisterClassW(&wc);

    g.hwnd = CreateWindowExW(0, wc.lpszClassName, APP_TITLE,
        WS_OVERLAPPEDWINDOW, CW_USEDEFAULT, CW_USEDEFAULT, 1050, 720,
        nullptr, nullptr, hInst, nullptr);

    // Load the daily history grid (up to HISTORY_DAYS most recent days).
    ensureHistoryDir();
    historyLoadAll();
    if (g.history.empty()) {
        // First run / no history yet: seed it from whatever sample or
        // previously-downloaded file sits next to the exe.
        std::wstring seed = exeDir() + L"\\sample_FVG_CAPE.grib2";
        if (GetFileAttributesW(seed.c_str()) == INVALID_FILE_ATTRIBUTES)
            seed = exeDir() + L"\\latest.grib2";
        if (GetFileAttributesW(seed.c_str()) != INVALID_FILE_ATTRIBUTES) {
            std::wstring msg;
            ingestIntoHistory(seed, msg);
        }
    }

    ShowWindow(g.hwnd, nShow);
    UpdateWindow(g.hwnd);

    // Optional CLI argument: a file path to preview.
    if (cmdLine && cmdLine[0]) {
        std::wstring arg(cmdLine);
        if (!arg.empty() && arg.front() == L'"') arg = arg.substr(1, arg.find_last_of(L'"') - 1);
        if (GetFileAttributesW(arg.c_str()) != INVALID_FILE_ATTRIBUTES) openPreview(arg);
    }

    MSG msg;
    while (GetMessageW(&msg, nullptr, 0, 0)) {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }
    GdiplusShutdown(g.gdip);
    return 0;
}
