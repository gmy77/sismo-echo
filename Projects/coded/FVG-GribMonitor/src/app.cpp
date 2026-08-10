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
#include <windows.h>
#include <commctrl.h>
#include <commdlg.h>
#include <shlobj.h>
#include <gdiplus.h>
#include <string>
#include <vector>
#include <cmath>
#include <algorithm>

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
    IDC_CITIES, IDC_BORDERS, IDC_ARROWS, IDC_SMOOTH, IDC_CLIP,
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
    std::wstring unit;
};

struct App {
    Settings settings;
    std::vector<grib2::Field> fields;
    std::vector<View> views;
    int current = 0;
    // options
    bool showCities = true, showBorders = true, showArrows = true;
    bool smooth = true, clipFVG = false;
    int alpha = 200;               // 0..255 overlay opacity
    std::wstring loadedName = L"(nessun file)";
    std::wstring refTime;
    HWND hwnd = nullptr, combo = nullptr, status = nullptr, info = nullptr;
    ULONG_PTR gdip = 0;
};
static App g;

// Build the list of selectable views from the loaded fields.
static void rebuildViews() {
    g.views.clear();
    // Scalar fields (CAPE, and each U/V component individually).
    for (auto& f : g.fields) {
        View vw;
        std::string sn = f.shortName();
        vw.scalar = &f;
        vw.vmin = f.minValue; vw.vmax = f.maxValue;
        vw.unit = toW(f.unit());
        if (sn == "U" || sn == "V")
            vw.palette = cmap::diverging();
        else if (sn == "CAPE" || sn == "CIN")
            vw.palette = cmap::cape();
        else
            vw.palette = cmap::windSpeed();
        vw.label = toW(f.label());
        g.views.push_back(vw);
    }
    // Wind (speed + arrows) for every level that has both U and V.
    for (size_t i = 0; i < g.fields.size(); ++i) {
        if (g.fields[i].shortName() != "U") continue;
        for (size_t j = 0; j < g.fields.size(); ++j) {
            if (g.fields[j].shortName() != "V") continue;
            if (g.fields[i].levelType == g.fields[j].levelType &&
                g.fields[i].levelValue == g.fields[j].levelValue &&
                g.fields[i].ni == g.fields[j].ni && g.fields[i].nj == g.fields[j].nj) {
                View vw; vw.isWind = true;
                vw.u = &g.fields[i]; vw.v = &g.fields[j];
                vw.palette = cmap::windSpeed(); vw.unit = L"m/s";
                double mx = 0;
                for (size_t k = 0; k < vw.u->values.size(); ++k) {
                    double uu = vw.u->values[k], vvv = vw.v->values[k];
                    if (!std::isnan(uu) && !std::isnan(vvv)) mx = std::max(mx, std::hypot(uu, vvv));
                }
                vw.vmin = 0; vw.vmax = mx > 0 ? mx : 1;
                vw.label = L"Vento @ " + toW(g.fields[i].levelText()) + L" (vel.+dir.)";
                g.views.push_back(vw);
            }
        }
    }
    if (g.current >= (int)g.views.size()) g.current = 0;
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

    Proj pr; pr.setup(x0, y0, w, h);

    // Faint FVG land fill so the region reads even before data loads.
    {
        std::vector<PointF> ps(FVG_REGION_N);
        for (int i = 0; i < FVG_REGION_N; ++i) ps[i] = pr.toPixel(FVG_REGION[i].lon, FVG_REGION[i].lat);
        SolidBrush land(Color(255, 236, 240, 234));
        gfx.FillPolygon(&land, ps.data(), FVG_REGION_N);
    }

    // Colour overlay for the current field.
    if (!g.views.empty()) {
        const View& vw = g.views[g.current];
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
                    double val = sampleView(vw, lon, lat, g.smooth);
                    if (std::isnan(val)) { row[px] = 0; continue; }
                    cmap::RGB c = cmap::colorFor(vw.palette, val, vw.vmin, vw.vmax);
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

    // Wind arrows (only for wind views).
    if (g.showArrows && !g.views.empty() && g.views[g.current].isWind) {
        const View& vw = g.views[g.current];
        Pen ap(Color(210, 20, 20, 30), 1.4f);
        for (int r = 0; r < vw.u->nj; ++r) {
            for (int c = 0; c < vw.u->ni; ++c) {
                double uu = vw.u->at(c, r), vv = vw.v->at(c, r);
                if (std::isnan(uu) || std::isnan(vv)) continue;
                double lon = std::min(vw.u->lon1, vw.u->lon2) + c * vw.u->di;
                double lat = std::min(vw.u->lat1, vw.u->lat2) + r * vw.u->dj;
                if (g.clipFVG && !inRegion(FVG_REGION, FVG_REGION_N, lon, lat)) continue;
                PointF base = pr.toPixel(lon, lat);
                double spd = std::hypot(uu, vv);
                double L = std::min(22.0, 6.0 + spd * 3.0);
                // meteo convention: arrow points TO where wind blows (u east, v north).
                double dx = (spd > 1e-6 ? uu / spd : 0) * L;
                double dy = -(spd > 1e-6 ? vv / spd : 0) * L; // screen y down
                PointF tip((REAL)(base.X + dx), (REAL)(base.Y + dy));
                gfx.DrawLine(&ap, base, tip);
                // arrowhead
                double ang = std::atan2(dy, dx);
                double a1 = ang + 2.6, a2 = ang - 2.6;
                gfx.DrawLine(&ap, tip, PointF((REAL)(tip.X + 6 * std::cos(a1)), (REAL)(tip.Y + 6 * std::sin(a1))));
                gfx.DrawLine(&ap, tip, PointF((REAL)(tip.X + 6 * std::cos(a2)), (REAL)(tip.Y + 6 * std::sin(a2))));
            }
        }
    }

    // Cities.
    if (g.showCities) {
        FontFamily ff(L"Segoe UI");
        Font font(&ff, 11, FontStyleBold, UnitPixel);
        SolidBrush dot(Color(255, 25, 25, 35));
        SolidBrush halo(Color(235, 255, 255, 255));
        SolidBrush txt(Color(255, 20, 20, 30));
        for (int i = 0; i < FVG_CITIES_N; ++i) {
            PointF p = pr.toPixel(FVG_CITIES[i].lon, FVG_CITIES[i].lat);
            gfx.FillEllipse(&dot, p.X - 2.5f, p.Y - 2.5f, 5.0f, 5.0f);
            std::wstring nm = toW(FVG_CITIES[i].name);
            // halo behind text for readability over colours
            for (int dx = -1; dx <= 1; ++dx) for (int dy = -1; dy <= 1; ++dy)
                gfx.DrawString(nm.c_str(), -1, &font, PointF(p.X + 6 + dx, p.Y - 7 + dy), &halo);
            gfx.DrawString(nm.c_str(), -1, &font, PointF(p.X + 6, p.Y - 7), &txt);
        }
    }

    // Legend / colour bar.
    if (!g.views.empty()) {
        const View& vw = g.views[g.current];
        int lx = x0 + 14, ly = y0 + h - 150, lw = 22, lh = 120;
        for (int i = 0; i < lh; ++i) {
            double t = 1.0 - (double)i / (lh - 1);
            double val = vw.vmin + t * (vw.vmax - vw.vmin);
            cmap::RGB c = cmap::colorFor(vw.palette, val, vw.vmin, vw.vmax);
            SolidBrush b(Color(255, c.r, c.g, c.b));
            gfx.FillRectangle(&b, lx, ly + i, lw, 1);
        }
        Pen frame(Color(255, 60, 60, 70)); gfx.DrawRectangle(&frame, lx, ly, lw, lh);
        FontFamily ff(L"Segoe UI"); Font font(&ff, 11, FontStyleRegular, UnitPixel);
        SolidBrush txt(Color(255, 20, 20, 30));
        wchar_t buf[64];
        swprintf(buf, 64, L"%.0f", vw.vmax); gfx.DrawString(buf, -1, &font, PointF((REAL)(lx + lw + 5), (REAL)ly - 2), &txt);
        swprintf(buf, 64, L"%.0f", vw.vmin); gfx.DrawString(buf, -1, &font, PointF((REAL)(lx + lw + 5), (REAL)(ly + lh - 12)), &txt);
        gfx.DrawString(vw.unit.c_str(), -1, &font, PointF((REAL)lx, (REAL)(ly - 18)), &txt);
    }
}

// ----------------------------- info text ----------------------------------
static void updateInfo() {
    std::wstring s = L"File: " + g.loadedName + L"\r\n";
    if (!g.refTime.empty()) s += L"Emissione: " + g.refTime + L" UTC\r\n";
    s += L"Campi: " + std::to_wstring((int)g.fields.size());
    if (g.info) SetWindowTextW(g.info, s.c_str());
}
static void setStatus(const std::wstring& s) { if (g.status) SetWindowTextW(g.status, s.c_str()); }

// ----------------------------- loading ------------------------------------
static void loadFile(const std::wstring& path) {
    std::string err;
    // read bytes
    FILE* fp = _wfopen(path.c_str(), L"rb");
    if (!fp) { setStatus(L"Impossibile aprire il file."); return; }
    fseek(fp, 0, SEEK_END); long n = ftell(fp); fseek(fp, 0, SEEK_SET);
    std::vector<uint8_t> buf(n > 0 ? n : 0);
    if (n > 0) { if (fread(buf.data(), 1, n, fp) != (size_t)n) { fclose(fp); setStatus(L"Lettura fallita."); return; } }
    fclose(fp);

    auto fields = grib2::parse(buf.data(), buf.size(), &err);
    if (fields.empty()) { setStatus(L"Nessun campo GRIB2 valido nel file."); return; }
    g.fields = std::move(fields);
    rebuildViews();

    size_t sl = path.find_last_of(L"\\/");
    g.loadedName = sl == std::wstring::npos ? path : path.substr(sl + 1);
    wchar_t rb[64];
    swprintf(rb, 64, L"%04d-%02d-%02d %02d:%02d", g.fields[0].year, g.fields[0].month,
             g.fields[0].day, g.fields[0].hour, g.fields[0].minute);
    g.refTime = rb;

    // Repopulate combo.
    SendMessageW(g.combo, CB_RESETCONTENT, 0, 0);
    for (auto& v : g.views) SendMessageW(g.combo, CB_ADDSTRING, 0, (LPARAM)v.label.c_str());
    SendMessageW(g.combo, CB_SETCURSEL, g.current, 0);
    updateInfo();
    setStatus(L"Caricati " + std::to_wstring((int)g.views.size()) + L" tipi di lettura.");
    InvalidateRect(g.hwnd, nullptr, FALSE);
}

// ----------------------------- actions ------------------------------------
static void actionOpen() {
    wchar_t file[MAX_PATH] = L"";
    OPENFILENAMEW ofn; ZeroMemory(&ofn, sizeof(ofn));
    ofn.lStructSize = sizeof(ofn); ofn.hwndOwner = g.hwnd;
    ofn.lpstrFilter = L"File GRIB (*.grib2;*.grb2;*.grib;*.grb)\0*.grib2;*.grb2;*.grib;*.grb\0Tutti i file\0*.*\0";
    ofn.lpstrFile = file; ofn.nMaxFile = MAX_PATH;
    ofn.Flags = OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST;
    if (GetOpenFileNameW(&ofn)) loadFile(file);
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
    if (ok) { setStatus(L"Scaricato. Carico..."); loadFile(dest); }
    else    { setStatus(L"Download fallito: " + toW(err)); }
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
        mkCheck(hwnd, L"Ritaglia sul FVG",      IDC_CLIP,    x, y, g.clipFVG);     y += 30;

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

        g.info = mkLabel(hwnd, L"", x, y, PANEL_W - 30, 60, IDC_INFO); y += 66;
        g.status = mkLabel(hwnd, L"Pronto.", x, y, PANEL_W - 30, 40, IDC_STATUS);
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

    // Auto-load a sample sitting next to the exe, if present.
    {
        std::wstring sample = exeDir() + L"\\sample_FVG_CAPE.grib2";
        if (GetFileAttributesW(sample.c_str()) != INVALID_FILE_ATTRIBUTES) loadFile(sample);
        else { std::wstring latest = exeDir() + L"\\latest.grib2";
               if (GetFileAttributesW(latest.c_str()) != INVALID_FILE_ATTRIBUTES) loadFile(latest); }
    }

    ShowWindow(g.hwnd, nShow);
    UpdateWindow(g.hwnd);

    // Optional CLI argument: a file path to open.
    if (cmdLine && cmdLine[0]) {
        std::wstring arg(cmdLine);
        if (!arg.empty() && arg.front() == L'"') arg = arg.substr(1, arg.find_last_of(L'"') - 1);
        if (GetFileAttributesW(arg.c_str()) != INVALID_FILE_ATTRIBUTES) loadFile(arg);
    }

    MSG msg;
    while (GetMessageW(&msg, nullptr, 0, 0)) {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }
    GdiplusShutdown(g.gdip);
    return 0;
}
