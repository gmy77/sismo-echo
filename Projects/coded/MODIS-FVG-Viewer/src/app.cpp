// Copyright (c) 2026 Gimmy Pignolo. Tutti i diritti riservati.
// MODIS-FVG Viewer 1.0.0 - vedi LICENSE nella radice del repository.
// app.cpp — MODIS FVG Viewer. Win32 + GDI+ desktop dashboard.
//
// Layout:  [ control panel | image canvas ]  +  [ filmstrip ]  +  [ status bar ]
//   * Left panel: file source + NASA GIBS real-imagery downloader, band/channel
//     selection, RGB false-colour composer, overlays, timelapse.
//   * Canvas (>= 70% width): the active granule; pan with left-drag, zoom on the
//     cursor with the wheel, FVG borders + city overlays on top.
//   * Filmstrip: thumbnails of every granule in the in-memory sequence, ordered
//     by acquisition time; click to jump.
//   * Status bar: cursor lat/lon (+ pixel value), product/satellite, granule
//     time, zoom level.
//
// Two kinds of granule feed the same viewer:
//   - LOCAL  : a decoded .mgr granule (portable modis/image code) with real
//              per-band values, mixed resolutions and RGB compositing.
//   - REMOTE : a real MODIS image fetched from NASA GIBS (gibs.cpp), already
//              georeferenced to the FVG box — shown as-is.
//
// All decoding/compositing is portable and unit-tested off-Windows; only the
// GUI, file dialog, GIBS download and MP4 encoding are Windows-specific.

#ifndef UNICODE
#define UNICODE
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <windowsx.h>
#include <commctrl.h>
#include <commdlg.h>
#include <dwmapi.h>
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>
using std::min;
using std::max;
#include <gdiplus.h>

#include "modis.h"
#include "image.h"
#include "colormap.h"
#include "fvg_geo_data.h"
#include "mf_encoder.h"
#include "gibs.h"

#pragma comment(lib, "gdiplus.lib")
#pragma comment(lib, "comctl32.lib")
#pragma comment(lib, "comdlg32.lib")
#pragma comment(lib, "dwmapi.lib")

using namespace Gdiplus;

#ifndef DWMWA_USE_IMMERSIVE_DARK_MODE
#define DWMWA_USE_IMMERSIVE_DARK_MODE 20
#endif
#ifndef DWMWA_SYSTEMBACKDROP_TYPE
#define DWMWA_SYSTEMBACKDROP_TYPE 38
#endif
#ifndef DWMSBT_MAINWINDOW
#define DWMSBT_MAINWINDOW 2   // Mica
#endif

// ----------------------------- constants ----------------------------------
static const wchar_t* APP_VERSION = L"1.0.0";
static const wchar_t* APP_TITLE   = L"MODIS FVG Viewer 1.0.0";
static const wchar_t* APP_CREDIT_1 = L"MODIS-FVG  \u00b7  v1.0.0";
static const wchar_t* APP_CREDIT_2 = L"Anthropic  \u00b7  PIGNOLO GIMMY";
static const wchar_t* APP_CREDIT_3 = L"\u00a9 2026 Gimmy Pignolo \u00b7 Tutti i diritti riservati";
static const int PANEL_W  = 304;
static const int FILM_H   = 116;
static const int STATUS_H = 28;

enum {
    IDC_OPEN = 1001, IDC_SAT, IDC_PRODUCT, IDC_DATE, IDC_FETCH, IDC_LATEST, IDC_WORKER,
    IDC_BANDLIST, IDC_RGB, IDC_RCOMBO, IDC_GCOMBO, IDC_BCOMBO,
    IDC_CITIES, IDC_BORDERS, IDC_DIFF, IDC_RESET, IDC_FPS, IDC_MOVIE,
    IDC_STRIP, IDC_SHARP, IDC_SAVEPNG, IDC_RAWLAYER
};

// ----------------------------- theme --------------------------------------
struct Theme {
    Color panel, card, canvas, canvasEdge, text, subtext, accent, border, filmBg, cell, cellSel, chip;
};
static bool isLightTheme() {
    HKEY k; DWORD v = 1, sz = sizeof v;
    if (RegOpenKeyExW(HKEY_CURRENT_USER,
            L"Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize",
            0, KEY_READ, &k) == ERROR_SUCCESS) {
        RegQueryValueExW(k, L"AppsUseLightTheme", nullptr, nullptr, (LPBYTE)&v, &sz);
        RegCloseKey(k);
    }
    return v != 0;
}
static Theme makeTheme(bool light) {
    Theme t;
    if (light) {
        t.panel   = Color(255, 238, 242, 246);
        t.card    = Color(255, 248, 250, 252);
        t.canvas  = Color(255, 224, 229, 234);
        t.canvasEdge = Color(255, 200, 206, 214);
        t.text    = Color(255,  22,  26,  32);
        t.subtext = Color(255, 104, 112, 122);
        t.accent  = Color(255,  16, 132, 176);
        t.border  = Color(255, 210, 216, 222);
        t.filmBg  = Color(255, 230, 234, 240);
        t.cell    = Color(255, 214, 220, 228);
        t.cellSel = Color(255,  16, 132, 176);
        t.chip    = Color(210, 255, 255, 255);
    } else {
        t.panel   = Color(255,  22,  25,  30);
        t.card    = Color(255,  31,  36,  44);
        t.canvas  = Color(255,  13,  15,  19);
        t.canvasEdge = Color(255,  46,  52,  62);
        t.text    = Color(255, 233, 238, 244);
        t.subtext = Color(255, 148, 156, 166);
        t.accent  = Color(255,  56, 206, 226);
        t.border  = Color(255,  46,  52,  62);
        t.filmBg  = Color(255,  18,  21,  26);
        t.cell    = Color(255,  38,  44,  53);
        t.cellSel = Color(255,  56, 206, 226);
        t.chip    = Color(150,   0,   0,   0);
    }
    return t;
}

// ----------------------------- app state ----------------------------------
struct GranuleView {
    bool remote = false;

    // LOCAL granule (per-band values).
    modis::Granule g;

    // REMOTE image (already-rendered RGB from GIBS) + its metadata.
    img::Image  rimg;
    std::string rSat, rProduct, rTimeText, rSortKey;
    double rLatMin = 0, rLatMax = 0, rLonMin = 0, rLonMax = 0;
    bool   rStrip = false;   // "blocco" swath (FVG parallel down to the equator)
    std::wstring cacheFile;  // PNG su disco da rimuovere se l'utente lo cestina

    Bitmap* thumb = nullptr;
};

struct App {
    HWND hwnd = nullptr;
    HWND satCombo=nullptr, prodCombo=nullptr, dateEdit=nullptr, workerChk=nullptr, stripChk=nullptr;
    HWND bandList=nullptr, rgbChk=nullptr, rCombo=nullptr, gCombo=nullptr, bCombo=nullptr;
    HWND rawChk=nullptr, citiesChk=nullptr, bordersChk=nullptr, diffChk=nullptr, fpsEdit=nullptr, sharpChk=nullptr;
    ULONG_PTR gdip = 0;
    HBRUSH panelBrush = nullptr, cardBrush = nullptr;

    std::vector<GranuleView> seq;
    int cur = -1;

    bool rgbMode = false;
    int  singleBand = 1;
    int  rBand = 1, gBand = 4, bBand = 3;   // natural true colour by default
    bool showCities = true, showBorders = true;
    bool diffMode = false;                   // show |current - previous|
    bool viaWorker = true;                   // fetch through the Cloudflare cache
    bool stripMode = false;                  // "blocco": tall swath FVG -> equator
    bool sharpen   = true;                   // unsharp mask on the shown image
    bool rawOverlay= false;                  // strato "a punti" senza la base sotto

    Bitmap* image = nullptr;
    int imgW = 0, imgH = 0;

    double scale = 1, originX = 0, originY = 0;

    RECT rcCanvas{}, rcPanel{}, rcFilm{}, rcStatus{};
    std::vector<std::pair<std::wstring,int>> sections; // (label, y) for headings
    int panelContentBottom = 0;                        // dove finiscono i controlli

    bool dragging = false;
    int  lastX = 0, lastY = 0;
    std::wstring statusText;

    Theme theme; bool light = false;
} g;

// ----------------------------- helpers ------------------------------------
static std::wstring exeDir() {
    wchar_t buf[MAX_PATH]; GetModuleFileNameW(nullptr, buf, MAX_PATH);
    std::wstring s(buf); size_t p = s.find_last_of(L"\\/");
    return p == std::wstring::npos ? L"." : s.substr(0, p);
}
static std::wstring toW(const std::string& s) {
    int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, nullptr, 0);
    std::wstring w(n > 0 ? n - 1 : 0, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, w.data(), n);
    return w;
}
static std::string toU8(const std::wstring& w) {
    int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), -1, nullptr, 0, nullptr, nullptr);
    std::string s(n > 0 ? n - 1 : 0, '\0');
    WideCharToMultiByte(CP_UTF8, 0, w.c_str(), -1, s.data(), n, nullptr, nullptr);
    return s;
}
static void logLine(const std::wstring& msg) {
    std::wstring path = exeDir() + L"\\modis-viewer.log";
    HANDLE h = CreateFileW(path.c_str(), FILE_APPEND_DATA, FILE_SHARE_READ,
                           nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) return;
    SetFilePointer(h, 0, nullptr, FILE_END);
    SYSTEMTIME st; GetLocalTime(&st);
    wchar_t ts[64]; swprintf(ts, 64, L"[%04d-%02d-%02d %02d:%02d:%02d] ",
        st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond);
    std::string u8 = toU8(ts + msg + L"\r\n");
    DWORD wr; WriteFile(h, u8.data(), (DWORD)u8.size(), &wr, nullptr);
    CloseHandle(h);
}

static Bitmap* bmpFromImage(const img::Image& im) {
    if (im.empty()) return nullptr;
    Bitmap* bmp = new Bitmap(im.w, im.h, PixelFormat32bppARGB);
    Rect rc(0, 0, im.w, im.h); BitmapData bd;
    if (bmp->LockBits(&rc, ImageLockModeWrite, PixelFormat32bppARGB, &bd) != Ok) { delete bmp; return nullptr; }
    for (int y = 0; y < im.h; ++y)
        memcpy((BYTE*)bd.Scan0 + (size_t)y * bd.Stride, &im.px[(size_t)y * im.w], (size_t)im.w * 4);
    bmp->UnlockBits(&bd);
    return bmp;
}

// ---- view accessors (unify LOCAL and REMOTE) -----------------------------
static double vLatMin(const GranuleView& v) { return v.remote ? v.rLatMin : v.g.latMin; }
static double vLatMax(const GranuleView& v) { return v.remote ? v.rLatMax : v.g.latMax; }
static double vLonMin(const GranuleView& v) { return v.remote ? v.rLonMin : v.g.lonMin; }
static double vLonMax(const GranuleView& v) { return v.remote ? v.rLonMax : v.g.lonMax; }
static std::string vProduct(const GranuleView& v)  { return v.remote ? v.rProduct  : v.g.product; }
static std::string vSat(const GranuleView& v)      { return v.remote ? v.rSat      : v.g.satellite; }
static std::string vTimeText(const GranuleView& v) { return v.remote ? v.rTimeText : v.g.timeText(); }
static std::string vSortKey(const GranuleView& v)  { return v.remote ? v.rSortKey  : v.g.sortKey(); }
static bool vHasBands(const GranuleView& v)         { return !v.remote; }

static cmap::Ramp rampFor(const modis::Granule& gr, int band) {
    const modis::Band* b = gr.bandByNumber(band);
    if (b && b->kind == modis::Kind::Temperature) return cmap::Ramp::Thermal;
    return cmap::Ramp::Gray;
}
static img::Image vRender(const GranuleView& v) {
    img::Image im;
    if (v.remote)        im = v.rimg;
    else if (g.rgbMode)  im = img::renderRGB(v.g, g.rBand, g.gBand, g.bBand);
    else                 im = img::renderSingle(v.g, g.singleBand, rampFor(v.g, g.singleBand));
    // GIBS interpolates whenever we ask for more pixels than the sensor
    // resolves, so a MODIS crop of an area this small always arrives soft.
    // The unsharp mask restores edge contrast without inventing detail.
    if (g.sharpen && !im.empty()) im = img::sharpen(im, 0.9, 1);
    return im;
}

// ----------------------------- view maths ---------------------------------
static void fitView() {
    if (!g.image || g.imgW == 0 || g.imgH == 0) return;
    RECT& c = g.rcCanvas;
    double cw = max(1L, c.right - c.left), ch = max(1L, c.bottom - c.top);
    g.scale = min(cw / g.imgW, ch / g.imgH) * 0.96;
    g.originX = c.left + (cw - g.imgW * g.scale) / 2;
    g.originY = c.top  + (ch - g.imgH * g.scale) / 2;
}
static double minScale() {
    if (!g.image) return 0.01;
    RECT& c = g.rcCanvas;
    double cw = max(1L, c.right - c.left), ch = max(1L, c.bottom - c.top);
    // Meta' del limite precedente: si puo' rimpicciolire fino a un ottavo
    // dell'inquadratura, utile per vedere il granulo nel suo contesto.
    return min(cw / g.imgW, ch / g.imgH) * 0.125;
}
static void geoToCanvas(const GranuleView& v, double lon, double lat, double& X, double& Y) {
    double fx = (lon - vLonMin(v)) / (vLonMax(v) - vLonMin(v));
    double fy = (vLatMax(v) - lat) / (vLatMax(v) - vLatMin(v));
    X = g.originX + fx * g.imgW * g.scale;
    Y = g.originY + fy * g.imgH * g.scale;
}
static bool canvasToGeo(const GranuleView& v, int px, int py, double& lon, double& lat) {
    double rx = (px - g.originX) / g.scale, ry = (py - g.originY) / g.scale;
    if (rx < 0 || ry < 0 || rx >= g.imgW || ry >= g.imgH) return false;
    lon = vLonMin(v) + (rx / g.imgW) * (vLonMax(v) - vLonMin(v));
    lat = vLatMax(v) - (ry / g.imgH) * (vLatMax(v) - vLatMin(v));
    return true;
}

// ----------------------------- rebuild ------------------------------------
static void rebuildImage() {
    if (g.image) { delete g.image; g.image = nullptr; }
    g.imgW = g.imgH = 0;
    if (g.cur < 0 || g.cur >= (int)g.seq.size()) return;
    img::Image im = vRender(g.seq[g.cur]);
    // Difference view: |current - previous| once both are the same size.
    if (g.diffMode && g.cur > 0) {
        img::Image prev = vRender(g.seq[g.cur - 1]);
        if (!prev.empty() && prev.w == im.w && prev.h == im.h)
            im = img::difference(im, prev);
    }
    if (im.empty()) return;
    g.image = bmpFromImage(im);
    g.imgW = im.w; g.imgH = im.h;
}
static void makeThumb(GranuleView& gv) {
    img::Image im;
    if (gv.remote) im = gv.rimg;
    else if (gv.g.bandByNumber(7) && gv.g.bandByNumber(2) && gv.g.bandByNumber(1)) im = img::renderRGB(gv.g, 7, 2, 1);
    else if (!gv.g.bands.empty()) im = img::renderSingle(gv.g, gv.g.bands.front().number, cmap::Ramp::Gray);
    if (!im.empty()) gv.thumb = bmpFromImage(im);
}

// ----------------------------- band UI ------------------------------------
static void refreshBandUI() {
    SendMessageW(g.bandList, LB_RESETCONTENT, 0, 0);
    SendMessageW(g.rCombo, CB_RESETCONTENT, 0, 0);
    SendMessageW(g.gCombo, CB_RESETCONTENT, 0, 0);
    SendMessageW(g.bCombo, CB_RESETCONTENT, 0, 0);
    bool bands = g.cur >= 0 && vHasBands(g.seq[g.cur]);
    EnableWindow(g.bandList, bands); EnableWindow(g.rgbChk, bands);
    EnableWindow(g.rCombo, bands && g.rgbMode); EnableWindow(g.gCombo, bands && g.rgbMode); EnableWindow(g.bCombo, bands && g.rgbMode);
    if (!bands) {
        SendMessageW(g.bandList, LB_ADDSTRING, 0, (LPARAM)L"(immagine GIBS reale — canale già composto)");
        return;
    }
    const modis::Granule& gr = g.seq[g.cur].g;
    int selIdx = 0;
    for (size_t i = 0; i < gr.bands.size(); ++i) {
        std::wstring name = toW(gr.bands[i].name);
        SendMessageW(g.bandList, LB_ADDSTRING, 0, (LPARAM)name.c_str());
        SendMessageW(g.bandList, LB_SETITEMDATA, i, (LPARAM)gr.bands[i].number);
        for (HWND c : {g.rCombo, g.gCombo, g.bCombo}) {
            SendMessageW(c, CB_ADDSTRING, 0, (LPARAM)name.c_str());
            SendMessageW(c, CB_SETITEMDATA, i, (LPARAM)gr.bands[i].number);
        }
        if (gr.bands[i].number == g.singleBand) selIdx = (int)i;
    }
    SendMessageW(g.bandList, LB_SETCURSEL, selIdx, 0);
    auto pick = [&](HWND combo, int bandNum) {
        int cnt = (int)SendMessageW(combo, CB_GETCOUNT, 0, 0);
        for (int i = 0; i < cnt; ++i)
            if ((int)SendMessageW(combo, CB_GETITEMDATA, i, 0) == bandNum) { SendMessageW(combo, CB_SETCURSEL, i, 0); return; }
        SendMessageW(combo, CB_SETCURSEL, 0, 0);
    };
    pick(g.rCombo, g.rBand); pick(g.gCombo, g.gBand); pick(g.bCombo, g.bBand);
}

static void buildStatus(int mx = -1, int my = -1) {
    if (g.cur < 0) {
        g.statusText = L"Pronto  \u00b7  \u2190 \u2192 scorre la sequenza  \u00b7  F adatta  \u00b7  +/- zoom  \u00b7  Ctrl+S salva la vista";
        return;
    }
    const GranuleView& v = g.seq[g.cur];
    std::wstring where = L"lat —, lon —";
    if (mx >= 0) {
        double lon, lat;
        if (canvasToGeo(v, mx, my, lon, lat)) {
            std::wstring val;
            if (!v.remote && !g.rgbMode) {
                const modis::Band* b = v.g.bandByNumber(g.singleBand);
                if (b) { double px, py;
                    if (v.g.pixelOfLonLat(*b, lon, lat, px, py)) {
                        double vv = b->at((int)px, (int)py); wchar_t vb[64];
                        if (!std::isnan(vv)) swprintf(vb, 64, L" · %.3f %s", vv, toW(b->unit).c_str());
                        else swprintf(vb, 64, L" · no-data");
                        val = vb; } }
            }
            wchar_t wb[128]; swprintf(wb, 128, L"lat %.4f, lon %.4f%s", lat, lon, val.c_str()); where = wb;
        }
    }
    std::wstring active = v.remote ? L"GIBS"
        : (g.rgbMode ? (L"RGB " + std::to_wstring(g.rBand) + L"-" + std::to_wstring(g.gBand) + L"-" + std::to_wstring(g.bBand))
                     : (L"banda " + std::to_wstring(g.singleBand)));
    wchar_t buf[512];
    swprintf(buf, 512, L"%s    ·    %s · %s    ·    %s    ·    %s    ·    zoom %.0f%%",
             where.c_str(), toW(vProduct(v)).c_str(), toW(vSat(v)).c_str(),
             toW(vTimeText(v)).c_str(), active.c_str(), g.scale * 100.0);
    g.statusText = buf;
}

// ----------------------------- open / sequence ----------------------------
static void addAndSelect(GranuleView&& gv, const std::string& key) {
    makeThumb(gv);
    g.seq.push_back(std::move(gv));
    std::sort(g.seq.begin(), g.seq.end(),
              [](const GranuleView& a, const GranuleView& b) { return vSortKey(a) < vSortKey(b); });
    int sel = (int)g.seq.size() - 1;
    for (int i = 0; i < (int)g.seq.size(); ++i) if (vSortKey(g.seq[i]) == key) { sel = i; break; }
    // select
    g.cur = sel;
    if (!g.seq[sel].remote && !g.seq[sel].g.bandByNumber(g.singleBand) && !g.seq[sel].g.bands.empty())
        g.singleBand = g.seq[sel].g.bands.front().number;
    rebuildImage(); fitView(); refreshBandUI(); buildStatus();
    InvalidateRect(g.hwnd, nullptr, FALSE);
}

static void selectIndex(int i) {
    if (i < 0 || i >= (int)g.seq.size()) return;
    g.cur = i;
    if (!g.seq[i].remote && !g.seq[i].g.bandByNumber(g.singleBand) && !g.seq[i].g.bands.empty())
        g.singleBand = g.seq[i].g.bands.front().number;
    rebuildImage(); fitView(); refreshBandUI(); buildStatus();
    InvalidateRect(g.hwnd, nullptr, FALSE);
}

// Cestina un elemento della sequenza. Per un granulo scaricato cancella anche
// il PNG in cache: la miniatura e' l'unico posto da cui l'utente vede quella
// libreria, quindi toglierla di li' e lasciare il file sul disco sarebbe una
// bugia - riapparirebbe al prossimo avvio.
static void removeIndex(int i) {
    if (i < 0 || i >= (int)g.seq.size()) return;
    GranuleView& gv = g.seq[i];
    if (!gv.cacheFile.empty()) {
        if (DeleteFileW(gv.cacheFile.c_str())) logLine(L"cache rimossa: " + gv.cacheFile);
        else logLine(L"cache NON rimossa: " + gv.cacheFile);
    }
    if (gv.thumb) { delete gv.thumb; gv.thumb = nullptr; }
    g.seq.erase(g.seq.begin() + i);

    if (g.seq.empty()) {
        g.cur = -1;
        if (g.image) { delete g.image; g.image = nullptr; }
        g.imgW = g.imgH = 0;
        refreshBandUI(); buildStatus();
        InvalidateRect(g.hwnd, nullptr, FALSE);
        return;
    }
    if (g.cur >= (int)g.seq.size()) g.cur = (int)g.seq.size() - 1;
    else if (g.cur > i) --g.cur;
    selectIndex(g.cur);
}

static void openFilePath(const std::wstring& path) {
    std::string p = toU8(path), err;
    modis::Granule gr = modis::parseFile(p, &err);
    if (gr.bands.empty()) {
        std::wstring msg = L"Impossibile leggere il granulo:\n" + toW(err);
        std::wstring lower = path; for (auto& c : lower) c = towlower(c);
        if (lower.size() > 4 && lower.substr(lower.size() - 4) == L".hdf")
            msg += L"\n\nI file HDF-EOS MODIS (.hdf) richiedono il lettore GDAL "
                   L"(non incluso in questa build). Usa un .mgr oppure scarica "
                   L"l'immagine reale da NASA GIBS.";
        logLine(L"OPEN FAIL: " + path + L" (" + toW(err) + L")");
        MessageBoxW(g.hwnd, msg.c_str(), APP_TITLE, MB_OK | MB_ICONWARNING); return;
    }
    if (!gr.intersectsFVG()) {
        logLine(L"OPEN fuori-FVG: " + path);
        MessageBoxW(g.hwnd, L"Il granulo è valido ma la sua impronta NON copre il FVG.\n"
            L"Molte orbite MODIS non passano sull'Italia ogni giorno: prova un altro file.",
            APP_TITLE, MB_OK | MB_ICONINFORMATION); return;
    }
    GranuleView gv; gv.remote = false; gv.g = std::move(gr);
    std::string key = gv.g.sortKey();
    logLine(L"OPEN OK: " + path);
    addAndSelect(std::move(gv), key);
}

static void doOpenDialog() {
    wchar_t file[MAX_PATH] = L"";
    OPENFILENAMEW ofn{}; ofn.lStructSize = sizeof ofn; ofn.hwndOwner = g.hwnd;
    ofn.lpstrFilter = L"Granuli MODIS (*.mgr;*.hdf)\0*.mgr;*.hdf\0Tutti i file (*.*)\0*.*\0\0";
    ofn.lpstrFile = file; ofn.nMaxFile = MAX_PATH; ofn.lpstrTitle = L"Apri un granulo MODIS";
    ofn.Flags = OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_EXPLORER;
    if (GetOpenFileNameW(&ofn)) openFilePath(file);
}

// ----------------------------- GIBS download ------------------------------
static std::wstring defaultDate() {
    // Two days back (GIBS true-colour is usually available with a short delay).
    SYSTEMTIME st; GetSystemTime(&st);
    FILETIME ft; SystemTimeToFileTime(&st, &ft);
    ULARGE_INTEGER u; u.LowPart = ft.dwLowDateTime; u.HighPart = ft.dwHighDateTime;
    u.QuadPart -= (ULONGLONG)2 * 24 * 60 * 60 * 10000000ULL;
    ft.dwLowDateTime = u.LowPart; ft.dwHighDateTime = u.HighPart;
    FileTimeToSystemTime(&ft, &st);
    wchar_t b[16]; swprintf(b, 16, L"%04d-%02d-%02d", st.wYear, st.wMonth, st.wDay);
    return b;
}

static std::wstring cacheDir() {
    std::wstring d = exeDir() + L"\\cache";
    CreateDirectoryW(d.c_str(), nullptr);
    return d;
}
// The requested box. Normally the FVG crop; in "blocco" mode a tall swath from
// the FVG parallel straight down to the equator, on the same overpass — the
// column of Earth the satellite flew over on its way to us.
struct Box { double latMin, latMax, lonMin, lonMax; };
static const double STRIP_LON_HALF = 12.0;   // ~2300 km wide: a full MODIS swath

static Box boxFor(bool strip) {
    if (!strip)
        return { modis::FVG_LAT_MIN, modis::FVG_LAT_MAX, modis::FVG_LON_MIN, modis::FVG_LON_MAX };
    double midLon = (modis::FVG_LON_MIN + modis::FVG_LON_MAX) / 2;
    double lo = midLon - STRIP_LON_HALF, hi = midLon + STRIP_LON_HALF;
    if (lo < -180) lo = -180;
    if (hi >  180) hi =  180;
    return { 0.0, modis::FVG_LAT_MAX, lo, hi };
}

// Cache filename encodes everything needed to rebuild the granule metadata:
//   gibs_<T|A>_<prodIdx>_<YYYY-MM-DD>.png          (FVG crop)
//   strip_<T|A>_<prodIdx>_<YYYY-MM-DD>.png         ("blocco" swath)
static std::wstring cacheName(int satIdx, int prodIdx, const std::string& date, bool strip) {
    wchar_t b[128];
    swprintf(b, 128, L"%s_%c_%d_%s.png", strip ? L"strip" : L"gibs",
             satIdx == 1 ? L'A' : L'T', prodIdx, toW(date).c_str());
    return b;
}

// Build and add a REMOTE granule from an already-decoded image + metadata.
static void addRemote(img::Image&& im, int satIdx, int prodIdx, const std::string& date, bool strip) {
    int nProd; const gibs::Product* P = gibs::products(nProd);
    const gibs::Product& pr = P[prodIdx < nProd ? prodIdx : 0];
    Box bx = boxFor(strip);
    GranuleView gv; gv.remote = true; gv.rimg = std::move(im); gv.rStrip = strip;
    // HLS is Landsat/Sentinel-2, not a Terra/Aqua product — don't mislabel it.
    gv.rSat = pr.ignoresSat ? "HLS" : ((satIdx == 1) ? "Aqua" : "Terra");
    gv.rProduct = toU8(pr.label);
    gv.rTimeText = date + (strip ? " (blocco)" : " (GIBS)");
    gv.rLatMin = bx.latMin; gv.rLatMax = bx.latMax;
    gv.rLonMin = bx.lonMin; gv.rLonMax = bx.lonMax;
    std::string ymd = date; ymd.erase(std::remove(ymd.begin(), ymd.end(), '-'), ymd.end());
    gv.rSortKey = ymd + "T" + (satIdx == 1 ? "A" : "T") + std::to_string(prodIdx) + (strip ? "S" : "F");
    gv.cacheFile = cacheDir() + L"\\" + cacheName(satIdx, prodIdx, date, strip);
    // Already loaded? Just bring it to the front instead of duplicating it.
    for (int i = 0; i < (int)g.seq.size(); ++i)
        if (vSortKey(g.seq[i]) == gv.rSortKey) { selectIndex(i); return; }
    addAndSelect(std::move(gv), gv.rSortKey);
}

// Load every cached PNG next to the exe into the sequence (persistent library).
static void loadCache() {
    std::wstring dir = cacheDir();
    int loaded = 0;
    // Two families of cached files: the FVG crop and the "blocco" swath.
    for (bool strip : { false, true }) {
        std::wstring prefix = strip ? L"strip_" : L"gibs_";
        WIN32_FIND_DATAW fd; HANDLE h = FindFirstFileW((dir + L"\\" + prefix + L"*.png").c_str(), &fd);
        if (h == INVALID_HANDLE_VALUE) continue;
        do {
            std::wstring fn = fd.cFileName;              // <prefix><S>_<prod>_<date>.png
            std::wstring rest = fn.substr(prefix.size());  // T_0_2026-08-22.png
            if (rest.size() < 15) continue;
            int satIdx = (rest[0] == L'A') ? 1 : 0;
            size_t p1 = rest.find(L'_');                 // after the satellite letter
            if (p1 == std::wstring::npos) continue;
            size_t p2 = rest.find(L'_', p1 + 1);         // after the product index
            if (p2 == std::wstring::npos) continue;
            int prodIdx = _wtoi(rest.substr(p1 + 1, p2 - p1 - 1).c_str());
            std::wstring tail = rest.substr(p2 + 1);     // YYYY-MM-DD.png
            std::wstring date = tail.substr(0, tail.size() >= 4 ? tail.size() - 4 : tail.size());
            img::Image im; std::wstring err;
            if (gibs::decodeFile(dir + L"\\" + fn, im, &err) && !im.empty()) {
                addRemote(std::move(im), satIdx, prodIdx, toU8(date), strip);
                ++loaded;
            }
        } while (FindNextFileW(h, &fd));
        FindClose(h);
    }
    if (loaded) logLine(L"CACHE: caricate " + std::to_wstring(loaded) + L" immagini reali");
}

static std::wstring dateMinusDays(int days) {
    SYSTEMTIME st; GetSystemTime(&st); FILETIME ft; SystemTimeToFileTime(&st, &ft);
    ULARGE_INTEGER u; u.LowPart = ft.dwLowDateTime; u.HighPart = ft.dwHighDateTime;
    u.QuadPart -= (ULONGLONG)days * 24 * 60 * 60 * 10000000ULL;
    ft.dwLowDateTime = u.LowPart; ft.dwHighDateTime = u.HighPart; FileTimeToSystemTime(&ft, &st);
    wchar_t b[16]; swprintf(b, 16, L"%04d-%02d-%02d", st.wYear, st.wMonth, st.wDay); return b;
}

// Core: fetch one granule for (satIdx, prodIdx, date). Uses the disk cache, then
// the Cloudflare Worker (if enabled) or NASA GIBS directly. Reports errors.
// Below this fraction of real pixels the tile is "the satellite wasn't here
// that day", not a dark scene. A genuine FVG crop is essentially fully covered;
// partial cloud still counts as data, so the bar can sit low.
static const double MIN_COVERAGE = 0.02;

// Show a message in the status bar and repaint right away — the fetch loop
// blocks the message pump, so without this the user would stare at a frozen
// window while we walk back through the dates.
static void flashStatus(const std::wstring& msg) {
    g.statusText = msg;
    InvalidateRect(g.hwnd, &g.rcStatus, FALSE);
    UpdateWindow(g.hwnd);
}

// `quiet` suppresses the error popup: the automatic fetches (switching product
// or satellite) must never interrupt with a dialog, they just report in the
// status bar. The explicit buttons stay loud.
static void fetchGibsCore(int satIdx, int prodIdx, const std::string& date, bool quiet = false);

// Step `date` back by `days` days. Dates here are always "YYYY-MM-DD".
static std::string dateBack(const std::string& date, int days) {
    SYSTEMTIME st{};
    st.wYear  = (WORD)atoi(date.substr(0, 4).c_str());
    st.wMonth = (WORD)atoi(date.substr(5, 2).c_str());
    st.wDay   = (WORD)atoi(date.substr(8, 2).c_str());
    FILETIME ft; if (!SystemTimeToFileTime(&st, &ft)) return date;
    LARGE_INTEGER u; u.LowPart = ft.dwLowDateTime; u.HighPart = (LONG)ft.dwHighDateTime;
    u.QuadPart -= (LONGLONG)days * 24 * 60 * 60 * 10000000LL;  // signed: days may be < 0
    ft.dwLowDateTime = u.LowPart; ft.dwHighDateTime = (DWORD)u.HighPart;
    if (!FileTimeToSystemTime(&ft, &st)) return date;
    char b[16]; std::snprintf(b, 16, "%04d-%02d-%02d", st.wYear, st.wMonth, st.wDay);
    return b;
}

static void fetchGibsCore(int satIdx, int prodIdx, const std::string& date, bool quiet) {
    int nProd; const gibs::Product* P = gibs::products(nProd);
    const gibs::Product& pr = P[prodIdx < nProd ? prodIdx : 0];
    std::string layer = (satIdx == 1) ? pr.aquaLayer : pr.terraLayer;
    const bool strip = g.stripMode;

    Box bx = boxFor(strip);
    // Ask for as many pixels as the product actually resolves — no more (that
    // would only interpolate), no fewer (that would throw detail away).
    int W = gibs::requestWidthFor(pr, bx.lonMax - bx.lonMin, (bx.latMin + bx.latMax) / 2);
    int H = (int)std::lround(W * (bx.latMax - bx.latMin) / (bx.lonMax - bx.lonMin));
    if (H < 64) H = 64;
    if (H > 4096) { H = 4096; W = (int)std::lround(H * (bx.lonMax - bx.lonMin) / (bx.latMax - bx.latMin)); }

    // A product that revisits every 2-3 days (and is processed days later) has
    // no image on most dates; MODIS flies daily but still misses the FVG. So
    // the requested day is a starting point: walk back until real data shows up.
    const int maxTries = (pr.nativeM <= 30) ? 14 : 4;

    // One fetch attempt. `probe` asks for a thumbnail instead of the real
    // image and keeps it out of the cache: at 30 m a full tile is several MB,
    // so scouting a fortnight of dates at full size would mean downloading
    // tens of MB to answer a yes/no question. A 256 px probe costs kilobytes
    // and tells us exactly the same thing — whether that day has data.
    auto attemptFetch = [&](const std::string& d, bool probe,
                            img::Image& out, std::wstring& err) -> bool {
        int fw = probe ? 256 : W;
        int fh = probe ? std::max(64, (int)std::lround(256.0 * H / W)) : H;
        // Un prodotto "a punti" non va in cache come immagine finita: il file su
        // disco resterebbe il solo strato trasparente, illeggibile al riavvio.
        std::wstring saveTo = (probe || pr.overlayOn)
            ? L"" : (cacheDir() + L"\\" + cacheName(satIdx, prodIdx, d, strip));
        HCURSOR prevCur = SetCursor(LoadCursor(nullptr, IDC_WAIT));
        auto fetchOne = [&](const std::string& prodId, const std::string& gibsLayer, img::Image& dst) {
            return g.viaWorker
                ? gibs::downloadViaWorker(gibs::workerHost(), (satIdx == 1) ? "aqua" : "terra",
                      prodId, d, bx.latMin, bx.latMax, bx.lonMin, bx.lonMax, fw, fh, dst, &err, saveTo)
                : gibs::download(gibsLayer, d, bx.latMin, bx.latMax, bx.lonMin, bx.lonMax, fw, fh, dst, &err, saveTo);
        };
        bool ok;
        if (pr.overlayOn && (probe || !g.rawOverlay)) {
            // La base porta la copertura (e quindi decide se la data e' buona);
            // lo strato sopra aggiunge i punti di calore.
            const gibs::Product* base = nullptr;
            for (int k = 0; k < nProd; ++k) if (std::strcmp(P[k].id, pr.overlayOn) == 0) base = &P[k];
            img::Image baseImg;
            ok = base && fetchOne(base->id, (satIdx == 1) ? base->aquaLayer : base->terraLayer, baseImg);
            if (ok) {
                img::Image over; std::wstring overErr;
                std::wstring keep = err; err = overErr;
                if (fetchOne(pr.id, layer, over)) out = img::composite(baseImg, over);
                else                              out = baseImg;   // niente incendi quel giorno
                err = keep;
            }
        } else {
            ok = fetchOne(pr.id, layer, out);
        }
        SetCursor(prevCur);
        if (ok && !probe && img::coverage(out) < MIN_COVERAGE)
            DeleteFileW(saveTo.c_str());   // never cache an empty tile
        return ok;
    };

    // A product that revisits every 2-3 days (and is processed days later) has
    // no image on most dates; MODIS flies daily but still misses the FVG. So
    // the requested day is a starting point: walk back until real data shows up.
    // For the 30 m products the first date is very unlikely to have data, so
    // scout with probes from the start; MODIS usually hits on day one, and
    // paying for a probe there would only add a round trip.
    // Anche per i prodotti sovrapposti: la base e' densa e sa dire se la data
    // ha dati, mentre lo strato di punti da solo non lo direbbe mai.
    const bool probeFirst = (pr.nativeM <= 30) || (pr.overlayOn != nullptr);
    std::string tryDate = date, foundDate;
    std::wstring lastErr = L"nessuna immagine trovata";
    int hardFails = 0;   // consecutive request failures (not empty tiles)

    for (int attempt = 0; attempt < maxTries && foundDate.empty(); ++attempt, tryDate = dateBack(tryDate, 1)) {
        // Disk cache hit? Load, no network at all.
        std::wstring cachePath = cacheDir() + L"\\" + cacheName(satIdx, prodIdx, tryDate, strip);
        if (GetFileAttributesW(cachePath.c_str()) != INVALID_FILE_ATTRIBUTES) {
            img::Image cim; std::wstring cerr;
            if (gibs::decodeFile(cachePath, cim, &cerr) && !cim.empty()) {
                logLine(L"cache-hit: " + cachePath);
                SetWindowTextW(g.dateEdit, toW(tryDate).c_str());
                addRemote(std::move(cim), satIdx, prodIdx, tryDate, strip);
                return;
            }
        }

        if (attempt > 0)
            flashStatus(L"Nessun dato fino al " + toW(tryDate) + L" — continuo a cercare indietro…");

        const bool probe = probeFirst || attempt > 0;
        img::Image im; std::wstring err;
        if (!attemptFetch(tryDate, probe, im, err)) {
            lastErr = err;
            // An empty tile is date-specific — another day may well have data.
            // A transport or HTTP failure is not: a rejected request fails the
            // same way on every date, so walking back 14 days would just stall
            // the window for nothing. Give it a couple of chances (a dropped
            // connection can be transient) and then stop.
            if (++hardFails >= 3) break;
            continue;
        }
        hardFails = 0;

        // An all-transparent tile means "no pass", not a black scene.
        double cov = img::coverage(im);
        if (cov < MIN_COVERAGE) {
            logLine(L"FETCH VUOTO: " + toW(layer) + L" " + toW(tryDate));
            lastErr = L"nessun passaggio del satellite in questa data";
            continue;
        }

        if (probe) { foundDate = tryDate; break; }   // now go get it for real

        logLine(std::wstring(L"FETCH OK") + (g.viaWorker ? L" [worker]" : L" [gibs]") + L": "
                + toW(layer) + L" " + toW(tryDate) + L" " + std::to_wstring(W) + L"x" + std::to_wstring(H)
                + L" cov=" + std::to_wstring((int)(cov * 100)) + L"%");
        SetWindowTextW(g.dateEdit, toW(tryDate).c_str());
        addRemote(std::move(im), satIdx, prodIdx, tryDate, strip);
        return;
    }

    // A probe found the date; fetch that one day at full resolution.
    if (!foundDate.empty()) {
        flashStatus(L"Trovati dati il " + toW(foundDate) + L" — scarico a piena risoluzione ("
                    + std::to_wstring(W) + L"x" + std::to_wstring(H) + L")…");
        img::Image im; std::wstring err;
        const bool sparseOk = (pr.overlayOn && g.rawOverlay);
        if (attemptFetch(foundDate, /*probe=*/false, im, err) && (sparseOk || img::coverage(im) >= MIN_COVERAGE)) {
            logLine(std::wstring(L"FETCH OK") + (g.viaWorker ? L" [worker]" : L" [gibs]") + L": "
                    + toW(layer) + L" " + toW(foundDate) + L" " + std::to_wstring(W) + L"x" + std::to_wstring(H));
            SetWindowTextW(g.dateEdit, toW(foundDate).c_str());
            addRemote(std::move(im), satIdx, prodIdx, foundDate, strip);
            return;
        }
        lastErr = err.empty() ? L"immagine a piena risoluzione non disponibile" : err;
    }

    logLine(L"FETCH FAIL: " + toW(layer) + L" da " + toW(date) + L" — " + lastErr);
    std::wstring span = toW(dateBack(date, maxTries - 1)) + L" … " + toW(date);
    g.statusText = L"Nessuna immagine per " + toW(toU8(pr.label)) + L" (" + span + L")";
    InvalidateRect(g.hwnd, &g.rcStatus, FALSE);
    if (!quiet) {
        std::wstring hint = pr.nativeM <= 30
            ? L"\n\nI prodotti a 30 m (Sentinel-2 / Landsat) passano ogni 2-3 giorni e "
              L"vengono elaborati con qualche giorno di ritardo: prova una data più "
              L"vecchia, oppure usa un prodotto MODIS."
            : L"\n\nAlcuni giorni non hanno copertura MODIS sul FVG: prova una data "
              L"diversa, o controlla la connessione.";
        MessageBoxW(g.hwnd, (L"Nessuna immagine trovata cercando dal " + span + L".\n"
            L"Ultimo esito: " + lastErr + hint
            + (g.viaWorker ? L"\n(Sorgente: Cloudflare Worker)" : L"\n(Sorgente: NASA GIBS diretto)")).c_str(),
            APP_TITLE, MB_OK | MB_ICONWARNING);
    }
}

// Current UI selection, shared by every fetch entry point.
static void currentSelection(int& satIdx, int& prodIdx) {
    satIdx  = (int)SendMessageW(g.satCombo,  CB_GETCURSEL, 0, 0);
    prodIdx = (int)SendMessageW(g.prodCombo, CB_GETCURSEL, 0, 0);
    if (satIdx  < 0) satIdx  = 0;
    if (prodIdx < 0) prodIdx = 0;
}

// Switching product / satellite / blocco applies immediately: show the granule
// if we already have it, otherwise fetch it silently.
static void applySelection() {
    int satIdx, prodIdx; currentSelection(satIdx, prodIdx);
    wchar_t dbuf[32] = L""; GetWindowTextW(g.dateEdit, dbuf, 32);
    std::string date = toU8(dbuf);
    if (date.size() != 10) date = toU8(defaultDate());
    fetchGibsCore(satIdx, prodIdx, date, /*quiet=*/true);
}

static void doFetchGibs() {
    int satIdx, prodIdx; currentSelection(satIdx, prodIdx);
    wchar_t dbuf[32] = L""; GetWindowTextW(g.dateEdit, dbuf, 32);
    std::string date = toU8(dbuf);
    if (date.size() != 10) { MessageBoxW(g.hwnd, L"Data non valida. Usa il formato AAAA-MM-GG.", APP_TITLE, MB_OK | MB_ICONWARNING); return; }
    fetchGibsCore(satIdx, prodIdx, date);
}

// "Al volo": grab the most recent likely-available day (yesterday UTC) for the
// selected satellite/product, straight from the Cloudflare cache.
static void doFetchLatest() {
    int satIdx, prodIdx; currentSelection(satIdx, prodIdx);
    std::string date = toU8(dateMinusDays(1));
    SetWindowTextW(g.dateEdit, toW(date).c_str());
    fetchGibsCore(satIdx, prodIdx, date);
}

// ----------------------------- timelapse ----------------------------------
static std::vector<uint32_t> resampleTo(const img::Image& im, int w, int h) {
    std::vector<uint32_t> out((size_t)w * h, img::NODATA);
    if (im.empty()) return out;
    for (int y = 0; y < h; ++y) { int sy = (int)((y + 0.5) / h * im.h); if (sy >= im.h) sy = im.h - 1;
        for (int x = 0; x < w; ++x) { int sx = (int)((x + 0.5) / w * im.w); if (sx >= im.w) sx = im.w - 1;
            out[(size_t)y * w + x] = im.at(sx, sy); } }
    return out;
}
static void doTimelapse() {
    if (g.seq.size() < 2) { MessageBoxW(g.hwnd, L"Servono almeno 2 granuli nella sequenza.", APP_TITLE, MB_OK | MB_ICONINFORMATION); return; }
    int fps = GetDlgItemInt(g.hwnd, IDC_FPS, nullptr, FALSE); if (fps < 1) fps = 6; if (fps > 60) fps = 60;
    wchar_t file[MAX_PATH]; wcscpy(file, L"modis_fvg_timelapse.mp4");
    OPENFILENAMEW ofn{}; ofn.lStructSize = sizeof ofn; ofn.hwndOwner = g.hwnd;
    ofn.lpstrFilter = L"Video MP4 (*.mp4)\0*.mp4\0\0"; ofn.lpstrFile = file; ofn.nMaxFile = MAX_PATH;
    ofn.lpstrDefExt = L"mp4"; ofn.lpstrTitle = L"Salva il timelapse"; ofn.Flags = OFN_OVERWRITEPROMPT | OFN_EXPLORER;
    if (!GetSaveFileNameW(&ofn)) return;

    img::Image first = vRender(g.seq.front());
    if (first.empty()) { MessageBoxW(g.hwnd, L"Impossibile renderizzare i fotogrammi.", APP_TITLE, MB_OK | MB_ICONERROR); return; }
    int W = first.w & ~1, H = first.h & ~1;
    std::vector<std::vector<uint32_t>> frames; frames.reserve(g.seq.size());
    for (auto& gv : g.seq) frames.push_back(resampleTo(vRender(gv), W, H));

    HCURSOR prev = SetCursor(LoadCursor(nullptr, IDC_WAIT));
    std::wstring err; bool ok = mf::encodeH264(file, W, H, fps, frames, &err);
    SetCursor(prev);
    if (ok) { logLine(std::wstring(L"TIMELAPSE OK: ") + file);
        MessageBoxW(g.hwnd, (std::wstring(L"Filmato creato:\n") + file + L"\n\n" +
            std::to_wstring(frames.size()) + L" fotogrammi a " + std::to_wstring(fps) + L" fps.").c_str(),
            APP_TITLE, MB_OK | MB_ICONINFORMATION);
    } else { logLine(L"TIMELAPSE FAIL: " + err);
        MessageBoxW(g.hwnd, (L"Errore nella creazione del filmato:\n" + err).c_str(), APP_TITLE, MB_OK | MB_ICONERROR); }
}

// ----------------------------- export -------------------------------------
// GDI+ needs the encoder's CLSID by MIME type; there is no shorter way.
static bool encoderClsid(const wchar_t* mime, CLSID* out) {
    UINT num = 0, size = 0;
    GetImageEncodersSize(&num, &size);
    if (!size) return false;
    std::vector<BYTE> buf(size);
    ImageCodecInfo* info = (ImageCodecInfo*)buf.data();
    GetImageEncoders(num, size, info);
    for (UINT i = 0; i < num; ++i)
        if (wcscmp(info[i].MimeType, mime) == 0) { *out = info[i].Clsid; return true; }
    return false;
}

static void paintCanvas(Graphics& gfx);   // defined below

// Save exactly what the canvas is showing - image, overlays, scale bar - so a
// view worth keeping can leave the app without a screenshot tool.
static void doSavePng() {
    if (!g.image) {
        MessageBoxW(g.hwnd, L"Non c'e' nessuna immagine da salvare.", APP_TITLE, MB_OK | MB_ICONINFORMATION);
        return;
    }
    int w = g.rcCanvas.right - g.rcCanvas.left, h = g.rcCanvas.bottom - g.rcCanvas.top;
    if (w < 8 || h < 8) return;

    wchar_t file[MAX_PATH];
    std::wstring suggested = L"modis_fvg";
    if (g.cur >= 0) {
        std::string tt = vTimeText(g.seq[g.cur]);
        for (char& c : tt) if (c == ' ' || c == ':' || c == '(' || c == ')') c = '_';
        suggested += L"_" + toW(tt);
    }
    suggested += L".png";
    wcsncpy(file, suggested.c_str(), MAX_PATH - 1); file[MAX_PATH - 1] = 0;

    OPENFILENAMEW ofn{}; ofn.lStructSize = sizeof ofn; ofn.hwndOwner = g.hwnd;
    ofn.lpstrFilter = L"Immagine PNG (*.png)\0*.png\0\0";
    ofn.lpstrFile = file; ofn.nMaxFile = MAX_PATH; ofn.lpstrDefExt = L"png";
    ofn.lpstrTitle = L"Salva la vista corrente";
    ofn.Flags = OFN_OVERWRITEPROMPT | OFN_EXPLORER;
    if (!GetSaveFileNameW(&ofn)) return;

    Bitmap bmp(w, h, PixelFormat32bppARGB);
    Graphics gfx(&bmp);
    gfx.SetSmoothingMode(SmoothingModeAntiAlias);
    gfx.SetTextRenderingHint(TextRenderingHintClearTypeGridFit);
    // paintCanvas works in window coordinates; shift the origin so the canvas
    // rectangle lands at (0,0) of the bitmap.
    gfx.TranslateTransform(-(REAL)g.rcCanvas.left, -(REAL)g.rcCanvas.top);
    paintCanvas(gfx);

    CLSID png;
    if (!encoderClsid(L"image/png", &png)) {
        MessageBoxW(g.hwnd, L"Codificatore PNG non disponibile.", APP_TITLE, MB_OK | MB_ICONERROR);
        return;
    }
    if (bmp.Save(file, &png, nullptr) == Ok) {
        logLine(std::wstring(L"PNG salvato: ") + file);
        g.statusText = std::wstring(L"Vista salvata: ") + file;
        InvalidateRect(g.hwnd, &g.rcStatus, FALSE);
    } else {
        MessageBoxW(g.hwnd, L"Salvataggio non riuscito.", APP_TITLE, MB_OK | MB_ICONERROR);
    }
}

// ----------------------------- layout -------------------------------------
static void doLayout() {
    RECT rc; GetClientRect(g.hwnd, &rc);
    g.rcStatus = { rc.left, rc.bottom - STATUS_H, rc.right, rc.bottom };
    g.rcFilm   = { rc.left + PANEL_W, rc.bottom - STATUS_H - FILM_H, rc.right, rc.bottom - STATUS_H };
    g.rcPanel  = { rc.left, rc.top, rc.left + PANEL_W, rc.bottom - STATUS_H };
    g.rcCanvas = { rc.left + PANEL_W, rc.top, rc.right, rc.bottom - STATUS_H - FILM_H };

    g.sections.clear();
    // Spaziature strette: il pannello deve stare tutto sopra la firma anche su
    // una finestra non massimizzata, senza barra di scorrimento.
    int x = 16, w = PANEL_W - 32, y = 74; // below header band
    auto header = [&](const wchar_t* label) { g.sections.push_back({ label, y }); y += 20; };
    auto row = [&](HWND h, int hh) { MoveWindow(h, x, y, w, hh, TRUE); y += hh + 6; };

    header(L"SORGENTE");
    row(GetDlgItem(g.hwnd, IDC_OPEN), 30);
    // GIBS: satellite + product, then date + fetch on one row.
    MoveWindow(g.satCombo,  x, y, 96, 200, TRUE);
    MoveWindow(g.prodCombo, x + 104, y, w - 104, 200, TRUE); y += 30;
    MoveWindow(g.dateEdit, x, y, 110, 26, TRUE);
    MoveWindow(GetDlgItem(g.hwnd, IDC_FETCH), x + 118, y, w - 118, 28, TRUE); y += 32;
    MoveWindow(GetDlgItem(g.hwnd, IDC_LATEST), x, y, w, 28, TRUE); y += 30;
    MoveWindow(g.workerChk, x, y, w, 22, TRUE); y += 22;
    MoveWindow(g.stripChk,  x, y, w, 22, TRUE); y += 28;

    header(L"CANALE / BANDA");
    row(g.bandList, 78);
    row(g.rgbChk, 24);
    MoveWindow(g.rCombo, x, y, w, 200, TRUE); y += 28;
    MoveWindow(g.gCombo, x, y, w, 200, TRUE); y += 28;
    MoveWindow(g.bCombo, x, y, w, 200, TRUE); y += 34;

    header(L"OVERLAY / CONFRONTO");
    row(g.citiesChk, 22);
    row(g.bordersChk, 22);
    row(g.sharpChk, 22);
    row(g.rawChk, 22);
    row(g.diffChk, 22);
    row(GetDlgItem(g.hwnd, IDC_RESET), 28);
    row(GetDlgItem(g.hwnd, IDC_SAVEPNG), 28);
    y += 4;

    header(L"TIMELAPSE");
    MoveWindow(g.fpsEdit, x, y, 56, 26, TRUE);
    MoveWindow(GetDlgItem(g.hwnd, IDC_MOVIE), x + 64, y, w - 64, 28, TRUE);
    g.panelContentBottom = y + 28;

    InvalidateRect(g.hwnd, nullptr, FALSE);
}

// ----------------------------- painting -----------------------------------
static void fillRoundRect(Graphics& gfx, Brush& br, REAL x, REAL y, REAL w, REAL h, REAL r) {
    GraphicsPath p; p.AddArc(x, y, r, r, 180, 90); p.AddArc(x + w - r, y, r, r, 270, 90);
    p.AddArc(x + w - r, y + h - r, r, r, 0, 90); p.AddArc(x, y + h - r, r, r, 90, 90); p.CloseFigure();
    gfx.FillPath(&br, &p);
}
static void drawCentered(Graphics& gfx, const RECT& r, const std::wstring& text, const Theme& t, REAL sz = 13) {
    FontFamily ff(L"Segoe UI"); Font font(&ff, sz, FontStyleRegular, UnitPixel);
    SolidBrush br(t.subtext); StringFormat sf; sf.SetAlignment(StringAlignmentCenter); sf.SetLineAlignment(StringAlignmentCenter);
    RectF rf((REAL)r.left, (REAL)r.top, (REAL)(r.right - r.left), (REAL)(r.bottom - r.top));
    gfx.DrawString(text.c_str(), -1, &font, rf, &sf, &br);
}

static void paintCanvas(Graphics& gfx) {
    const Theme& t = g.theme;
    SolidBrush bg(t.canvas);
    gfx.FillRectangle(&bg, (INT)g.rcCanvas.left, (INT)g.rcCanvas.top, (INT)(g.rcCanvas.right - g.rcCanvas.left), (INT)(g.rcCanvas.bottom - g.rcCanvas.top));
    gfx.SetClip(Rect(g.rcCanvas.left, g.rcCanvas.top, g.rcCanvas.right - g.rcCanvas.left, g.rcCanvas.bottom - g.rcCanvas.top));

    if (g.cur < 0 || !g.image) {
        drawCentered(gfx, g.rcCanvas,
            L"Nessuna immagine caricata.\n\n"
            L"SORGENTE \u2192 \u201cUltima (al volo)\u201d per scaricare l'ultimo passaggio disponibile,\n"
            L"oppure scegli satellite, prodotto e data e premi \u201cScarica reale\u201d.\n\n"
            L"Trascina per spostare \u00b7 rotellina per zoomare \u00b7 F per adattare \u00b7 \u2190 \u2192 per scorrere.", t, 14);
        gfx.ResetClip(); return;
    }
    const GranuleView& v = g.seq[g.cur];
    double dw = g.imgW * g.scale, dh = g.imgH * g.scale;
    // Nearest-neighbour straight above 1x turns a soft source into visible
    // blocks. Stay smooth through the useful zoom range and only expose raw
    // pixels far in, where seeing them is the point.
    gfx.SetInterpolationMode(g.scale >= 4.0 ? InterpolationModeNearestNeighbor
                                            : InterpolationModeHighQualityBicubic);
    gfx.SetPixelOffsetMode(PixelOffsetModeHalf);
    RectF dst((REAL)g.originX, (REAL)g.originY, (REAL)dw, (REAL)dh);
    gfx.DrawImage(g.image, dst, 0, 0, (REAL)g.imgW, (REAL)g.imgH, UnitPixel);

    // Un tratto bianco sparisce sopra nuvole o neve - cioe' su buona parte delle
    // scene MODIS. Ogni confine viene disegnato due volte: prima una guaina
    // scura e piu' spessa, poi il tratto chiaro sopra. Cosi' si legge sia sul
    // mare scuro sia su un fronte nuvoloso, senza dover indovinare lo sfondo.
    auto drawPoly = [&](const GeoPt* p, int n, Color col, REAL width) {
        std::vector<PointF> pts; pts.reserve(n);
        for (int i = 0; i < n; ++i) { double X, Y; geoToCanvas(v, p[i].lon, p[i].lat, X, Y); pts.push_back(PointF((REAL)X, (REAL)Y)); }
        if (pts.size() < 2) return;
        Pen casing(Color(150, 8, 10, 14), width + 2.4f);
        casing.SetLineJoin(LineJoinRound);
        gfx.DrawLines(&casing, pts.data(), (INT)pts.size());
        Pen pen(col, width); pen.SetLineJoin(LineJoinRound);
        gfx.DrawLines(&pen, pts.data(), (INT)pts.size());
    };
    if (g.showBorders) {
        Color faint(150, 210, 214, 220);
        drawPoly(FVG_PROV_UD, FVG_PROV_UD_N, faint, 1.2f); drawPoly(FVG_PROV_GO, FVG_PROV_GO_N, faint, 1.2f);
        drawPoly(FVG_PROV_TS, FVG_PROV_TS_N, faint, 1.2f); drawPoly(FVG_PROV_PN, FVG_PROV_PN_N, faint, 1.2f);
        drawPoly(FVG_REGION, FVG_REGION_N, Color(235, 255, 255, 255), 2.0f);
    }
    if (g.showCities) {
        // A 1px halo disappears over bright cloud, which is most of a MODIS
        // scene. A solid dark plate behind the name keeps it readable over
        // anything the satellite happens to be looking at.
        FontFamily ff(L"Segoe UI"); Font font(&ff, 12, FontStyleBold, UnitPixel);
        SolidBrush dot(Color(255, 255, 208, 64)), ring(Color(230, 10, 12, 16));
        SolidBrush plate(Color(190, 10, 12, 16)), label(Color(255, 255, 255, 255));
        for (int i = 0; i < FVG_CITIES_N; ++i) {
            double X, Y; geoToCanvas(v, FVG_CITIES[i].lon, FVG_CITIES[i].lat, X, Y);
            gfx.FillEllipse(&ring, (REAL)X - 5, (REAL)Y - 5, (REAL)10, (REAL)10);
            gfx.FillEllipse(&dot,  (REAL)X - 3, (REAL)Y - 3, (REAL)6,  (REAL)6);
            std::wstring nm = toW(FVG_CITIES[i].name);
            RectF meas; gfx.MeasureString(nm.c_str(), -1, &font, PointF(0, 0), &meas);
            REAL tx = (REAL)X + 8, ty = (REAL)Y - 9;
            fillRoundRect(gfx, plate, tx - 4, ty - 2, meas.Width + 8, meas.Height + 3, 7);
            gfx.DrawString(nm.c_str(), -1, &font, PointF(tx, ty), &label);
        }
    }
    gfx.ResetClip();

    // Scale bar. A satellite view without one leaves the reader guessing how
    // big anything is, and the answer changes with zoom and with latitude: a
    // degree of longitude is only ~70 km up here, not 111.
    {
        double lonSpan = vLonMax(v) - vLonMin(v);
        double midLat  = (vLatMin(v) + vLatMax(v)) / 2.0;
        double kmPerImgPx = lonSpan / g.imgW * 111.32 * std::cos(midLat * 3.14159265358979 / 180.0);
        double kmPerScreenPx = kmPerImgPx / (g.scale > 0 ? g.scale : 1);
        if (kmPerScreenPx > 0 && std::isfinite(kmPerScreenPx)) {
            // Pick a round distance (1/2/5 x 10^n) closest to ~150 px wide.
            double target = 150.0 * kmPerScreenPx;
            double mag = std::pow(10.0, std::floor(std::log10(target)));
            double norm = target / mag;
            double nice = (norm < 1.5) ? 1 : (norm < 3.5) ? 2 : (norm < 7.5) ? 5 : 10;
            double km = nice * mag;
            REAL barPx = (REAL)(km / kmPerScreenPx);
            if (barPx > 24 && barPx < (REAL)(g.rcCanvas.right - g.rcCanvas.left) * 0.6f) {
                REAL x0 = (REAL)g.rcCanvas.left + 16, y0 = (REAL)g.rcCanvas.bottom - 26;
                wchar_t lab[48];
                if (km >= 1) swprintf(lab, 48, L"%.0f km", km);
                else         swprintf(lab, 48, L"%.0f m", km * 1000);
                FontFamily sf(L"Segoe UI"); Font sfont(&sf, 11, FontStyleRegular, UnitPixel);
                RectF lm; gfx.MeasureString(lab, -1, &sfont, PointF(0, 0), &lm);
                SolidBrush plate(t.chip);
                fillRoundRect(gfx, plate, x0 - 8, y0 - 14, barPx + lm.Width + 22, 28, 8);
                Pen bar(t.text, 2.0f);
                gfx.DrawLine(&bar, x0, y0, x0 + barPx, y0);
                gfx.DrawLine(&bar, x0, y0 - 4, x0, y0 + 4);
                gfx.DrawLine(&bar, x0 + barPx, y0 - 4, x0 + barPx, y0 + 4);
                SolidBrush lt(t.text);
                gfx.DrawString(lab, -1, &sfont, PointF(x0 + barPx + 8, y0 - 8), &lt);
            }
        }
    }

    // Info chip (top-left of canvas).
    std::wstring chip = toW(vProduct(v)) + L"  ·  " + toW(vSat(v)) + L"  ·  " + toW(vTimeText(v));
    FontFamily ff(L"Segoe UI"); Font font(&ff, 12, FontStyleRegular, UnitPixel);
    RectF meas; gfx.MeasureString(chip.c_str(), -1, &font, PointF(0, 0), &meas);
    SolidBrush chbg(t.chip); SolidBrush chtx(t.text);
    fillRoundRect(gfx, chbg, (REAL)g.rcCanvas.left + 12, (REAL)g.rcCanvas.top + 12, meas.Width + 20, 26, 12);
    gfx.DrawString(chip.c_str(), -1, &font, PointF((REAL)g.rcCanvas.left + 22, (REAL)g.rcCanvas.top + 17), &chtx);
}

// Geometria della filmstrip, usata sia dal disegno sia dal clic: tenerla in un
// posto solo evita che il bersaglio del mouse si scosti da cio' che si vede.
static const int FILM_PAD = 10, FILM_CELLW = 132, FILM_XBTN = 18;
static RECT filmCellRect(int i) {
    int cellH = FILM_H - 2 * FILM_PAD;
    int x = g.rcFilm.left + FILM_PAD + i * (FILM_CELLW + FILM_PAD);
    int y = g.rcFilm.top + FILM_PAD;
    return RECT{ (LONG)x, (LONG)y, (LONG)(x + FILM_CELLW), (LONG)(y + cellH) };
}
static RECT filmCloseRect(int i) {
    RECT c = filmCellRect(i);
    return RECT{ c.right - FILM_XBTN - 3, c.top + 3, c.right - 3, c.top + 3 + FILM_XBTN };
}

static void paintFilm(Graphics& gfx) {
    const Theme& t = g.theme;
    SolidBrush bg(t.filmBg);
    gfx.FillRectangle(&bg, (INT)g.rcFilm.left, (INT)g.rcFilm.top, (INT)(g.rcFilm.right - g.rcFilm.left), (INT)(g.rcFilm.bottom - g.rcFilm.top));
    if (g.seq.empty()) { drawCentered(gfx, g.rcFilm, L"Sequenza vuota — apri o scarica granuli e appariranno qui.", t); return; }
    int cellH = FILM_H - 2 * FILM_PAD;
    FontFamily ff(L"Segoe UI"); Font font(&ff, 10, FontStyleRegular, UnitPixel);
    SolidBrush txt(t.text);
    gfx.SetInterpolationMode(InterpolationModeHighQualityBicubic);
    for (int i = 0; i < (int)g.seq.size(); ++i) {
        RECT c = filmCellRect(i);
        if (c.right > g.rcFilm.right) break;
        SolidBrush cb(i == g.cur ? t.cellSel : t.cell);
        fillRoundRect(gfx, cb, (REAL)c.left, (REAL)c.top, (REAL)FILM_CELLW, (REAL)cellH, 10);
        if (g.seq[i].thumb)
            gfx.DrawImage(g.seq[i].thumb, (INT)(c.left + 4), (INT)(c.top + 4),
                          (INT)(FILM_CELLW - 8), (INT)(cellH - 22));
        std::wstring lab = toW(vTimeText(g.seq[i]));
        gfx.DrawString(lab.c_str(), -1, &font, PointF((REAL)(c.left + 6), (REAL)(c.top + cellH - 16)), &txt);

        // Pulsante di rimozione: pastiglia scura con una x, in alto a destra.
        RECT xb = filmCloseRect(i);
        SolidBrush xbg(Color(190, 12, 14, 18));
        gfx.FillEllipse(&xbg, (REAL)xb.left, (REAL)xb.top, (REAL)FILM_XBTN, (REAL)FILM_XBTN);
        Pen xp(Color(235, 255, 255, 255), 1.6f);
        xp.SetStartCap(LineCapRound); xp.SetEndCap(LineCapRound);
        REAL m = 5.5f;
        gfx.DrawLine(&xp, (REAL)xb.left + m, (REAL)xb.top + m,
                          (REAL)xb.left + FILM_XBTN - m, (REAL)xb.top + FILM_XBTN - m);
        gfx.DrawLine(&xp, (REAL)xb.left + FILM_XBTN - m, (REAL)xb.top + m,
                          (REAL)xb.left + m, (REAL)xb.top + FILM_XBTN - m);
    }
}

static void paintPanel(Graphics& gfx) {
    const Theme& t = g.theme;
    SolidBrush pbg(t.panel);
    gfx.FillRectangle(&pbg, (INT)g.rcPanel.left, (INT)g.rcPanel.top, (INT)PANEL_W, (INT)(g.rcPanel.bottom - g.rcPanel.top));
    // Header band.
    SolidBrush acc(t.accent), sub(t.subtext), txt(t.text);
    FontFamily ff(L"Segoe UI"); Font h1(&ff, 20, FontStyleBold, UnitPixel); Font h2(&ff, 12, FontStyleRegular, UnitPixel);
    gfx.DrawString(L"MODIS · FVG", -1, &h1, PointF(16, 16), &acc);
    gfx.DrawString(L"Terra / Aqua · Friuli Venezia Giulia", -1, &h2, PointF(16, 44), &sub);
    // Section headings.
    Font sh(&ff, 11, FontStyleBold, UnitPixel);
    for (auto& s : g.sections) gfx.DrawString(s.first.c_str(), -1, &sh, PointF(16, (REAL)s.second), &sub);
    // Divider to canvas.
    Pen border(t.border, 1); gfx.DrawLine(&border, (INT)(PANEL_W - 1), (INT)g.rcPanel.top, (INT)(PANEL_W - 1), (INT)g.rcPanel.bottom);
    // Signature, pinned to the bottom of the panel.
    Font cred(&ff, 10, FontStyleRegular, UnitPixel);
    REAL cy = (REAL)g.rcPanel.bottom - 48;
    if (cy - 12 > (REAL)g.panelContentBottom) {   // solo se non copre i controlli
        gfx.DrawLine(&border, (INT)16, (INT)(cy - 10), (INT)(PANEL_W - 16), (INT)(cy - 10));
        gfx.DrawString(APP_CREDIT_1, -1, &cred, PointF(16, cy), &sub);
        gfx.DrawString(APP_CREDIT_2, -1, &cred, PointF(16, cy + 14), &sub);
        gfx.DrawString(APP_CREDIT_3, -1, &cred, PointF(16, cy + 28), &sub);
    }
}

static void paintStatus(Graphics& gfx) {
    const Theme& t = g.theme;
    SolidBrush bg(t.panel); gfx.FillRectangle(&bg, (INT)g.rcStatus.left, (INT)g.rcStatus.top, (INT)(g.rcStatus.right - g.rcStatus.left), (INT)STATUS_H);
    Pen border(t.border, 1); gfx.DrawLine(&border, (INT)g.rcStatus.left, (INT)g.rcStatus.top, (INT)g.rcStatus.right, (INT)g.rcStatus.top);
    FontFamily ff(L"Segoe UI"); Font font(&ff, 12, FontStyleRegular, UnitPixel); SolidBrush txt(t.text);
    gfx.DrawString(g.statusText.c_str(), -1, &font, PointF((REAL)(g.rcStatus.left + 12), (REAL)(g.rcStatus.top + 6)), &txt);
}

static void onPaint() {
    PAINTSTRUCT ps; HDC hdc = BeginPaint(g.hwnd, &ps);
    RECT rc; GetClientRect(g.hwnd, &rc);
    HDC mem = CreateCompatibleDC(hdc);
    HBITMAP bmp = CreateCompatibleBitmap(hdc, rc.right, rc.bottom);
    HBITMAP old = (HBITMAP)SelectObject(mem, bmp);
    Graphics gfx(mem);
    gfx.SetSmoothingMode(SmoothingModeAntiAlias);
    gfx.SetTextRenderingHint(TextRenderingHintClearTypeGridFit);
    paintPanel(gfx);
    paintCanvas(gfx);
    paintFilm(gfx);
    paintStatus(gfx);
    BitBlt(hdc, 0, 0, rc.right, rc.bottom, mem, 0, 0, SRCCOPY);
    SelectObject(mem, old); DeleteObject(bmp); DeleteDC(mem);
    EndPaint(g.hwnd, &ps);
}

// ----------------------------- interaction --------------------------------
static bool inRect(const RECT& r, int x, int y) { return x >= r.left && x < r.right && y >= r.top && y < r.bottom; }
static void onWheel(int mx, int my, int delta) {
    if (!g.image || !inRect(g.rcCanvas, mx, my)) return;
    double rx = (mx - g.originX) / g.scale, ry = (my - g.originY) / g.scale;
    double ns = g.scale * (delta > 0 ? 1.15 : 1.0 / 1.15);
    ns = max(minScale(), min(ns, 40.0));
    g.scale = ns; g.originX = mx - rx * g.scale; g.originY = my - ry * g.scale;
    buildStatus(mx, my); InvalidateRect(g.hwnd, &g.rcCanvas, FALSE); InvalidateRect(g.hwnd, &g.rcStatus, FALSE);
}

// ----------------------------- controls -----------------------------------
// Buttons and checkboxes are owner-drawn. A themed BUTTON control paints its
// own label with the *system* theme's text colour and ignores the colour we
// hand back from WM_CTLCOLORSTATIC, so on a dark panel the labels come out
// near-black on near-black. Drawing them ourselves is the only way to keep the
// panel readable, and it also lets the controls match the rest of the UI.
static HWND mkButton(HWND p, const wchar_t* text, int id) {
    return CreateWindowExW(0, L"BUTTON", text, WS_CHILD | WS_VISIBLE | BS_OWNERDRAW,
                           0,0,10,10, p, (HMENU)(INT_PTR)id, nullptr, nullptr);
}
static HWND mkCheck(HWND p, const wchar_t* text, int id, bool on) {
    // Owner-drawn buttons keep no check state of their own; ours lives in the
    // app state that the rest of the code already reads (see checkStateFor).
    (void)on;
    return CreateWindowExW(0, L"BUTTON", text, WS_CHILD | WS_VISIBLE | BS_OWNERDRAW,
                           0,0,10,10, p, (HMENU)(INT_PTR)id, nullptr, nullptr);
}

// The single source of truth for each checkbox, so the drawing code and the
// click handler can never disagree about what is ticked.
static bool* checkStateFor(int id) {
    switch (id) {
    case IDC_WORKER:  return &g.viaWorker;
    case IDC_STRIP:   return &g.stripMode;
    case IDC_RGB:     return &g.rgbMode;
    case IDC_CITIES:  return &g.showCities;
    case IDC_BORDERS: return &g.showBorders;
    case IDC_SHARP:   return &g.sharpen;
    case IDC_DIFF:    return &g.diffMode;
    default:          return nullptr;
    }
}

static void drawControl(const DRAWITEMSTRUCT* di) {
    const Theme& t = g.theme;
    Graphics gfx(di->hDC);
    gfx.SetSmoothingMode(SmoothingModeAntiAlias);
    gfx.SetTextRenderingHint(TextRenderingHintClearTypeGridFit);

    RECT r = di->rcItem;
    REAL w = (REAL)(r.right - r.left), h = (REAL)(r.bottom - r.top);
    const bool disabled = (di->itemState & ODS_DISABLED) != 0;
    const bool pressed  = (di->itemState & ODS_SELECTED) != 0;

    SolidBrush panelBg(t.panel);
    gfx.FillRectangle(&panelBg, 0, 0, (INT)w, (INT)h);

    FontFamily ff(L"Segoe UI");
    Font font(&ff, 12, FontStyleRegular, UnitPixel);
    wchar_t text[256] = L"";
    GetWindowTextW(di->hwndItem, text, 256);

    Color fg = disabled ? t.subtext : t.text;
    bool* state = checkStateFor((int)di->CtlID);

    if (state) {                              // ---- checkbox ----
        const REAL box = 15, bx = 1, by = (h - box) / 2;
        SolidBrush fill(*state ? t.accent : t.card);
        fillRoundRect(gfx, fill, bx, by, box, box, 5);
        Pen edge(*state ? t.accent : t.border, 1.2f);
        gfx.DrawRectangle(&edge, bx, by, box, box);
        if (*state) {                         // tick, drawn as two strokes
            Pen mark(t.panel, 2.0f);
            mark.SetStartCap(LineCapRound); mark.SetEndCap(LineCapRound);
            gfx.DrawLine(&mark, bx + 3.5f, by + 7.5f, bx + 6.2f, by + 10.5f);
            gfx.DrawLine(&mark, bx + 6.2f, by + 10.5f, bx + 11.5f, by + 4.5f);
        }
        SolidBrush tx(fg);
        StringFormat sf; sf.SetLineAlignment(StringAlignmentCenter);
        gfx.DrawString(text, -1, &font, RectF(bx + box + 9, 0, w - box - 12, h), &sf, &tx);
    } else {                                  // ---- push button ----
        Color face = pressed ? t.accent : t.card;
        SolidBrush fill(face);
        fillRoundRect(gfx, fill, 0.5f, 0.5f, w - 1, h - 1, 8);
        Pen edge(t.border, 1.0f);
        edge.SetAlignment(PenAlignmentInset);
        GraphicsPath outline;
        outline.AddArc(0.5f, 0.5f, (REAL)8, (REAL)8, (REAL)180, (REAL)90);
        outline.AddArc(w - 8.5f, 0.5f, (REAL)8, (REAL)8, (REAL)270, (REAL)90);
        outline.AddArc(w - 8.5f, h - 8.5f, (REAL)8, (REAL)8, (REAL)0, (REAL)90);
        outline.AddArc(0.5f, h - 8.5f, (REAL)8, (REAL)8, (REAL)90, (REAL)90);
        outline.CloseFigure();
        gfx.DrawPath(&edge, &outline);
        SolidBrush tx(pressed ? t.panel : fg);
        StringFormat sf;
        sf.SetAlignment(StringAlignmentCenter); sf.SetLineAlignment(StringAlignmentCenter);
        gfx.DrawString(text, -1, &font, RectF(0, 0, w, h), &sf, &tx);
    }

    if (di->itemState & ODS_FOCUS) {          // keyboard focus stays visible
        Pen ring(t.accent, 1.0f);
        ring.SetDashStyle(DashStyleDot);
        gfx.DrawRectangle(&ring, 0.5f, 0.5f, w - 2, h - 2);
    }
}
static HWND mkCombo(HWND p, int id) {
    return CreateWindowExW(0, L"COMBOBOX", nullptr, WS_CHILD | WS_VISIBLE | CBS_DROPDOWNLIST | WS_VSCROLL, 0,0,10,10, p, (HMENU)(INT_PTR)id, nullptr, nullptr);
}

static LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
    case WM_CREATE: {
        mkButton(hwnd, L"Apri file… (.mgr)", IDC_OPEN);
        g.satCombo = mkCombo(hwnd, IDC_SAT);
        SendMessageW(g.satCombo, CB_ADDSTRING, 0, (LPARAM)L"Terra");
        SendMessageW(g.satCombo, CB_ADDSTRING, 0, (LPARAM)L"Aqua");
        SendMessageW(g.satCombo, CB_SETCURSEL, 0, 0);
        g.prodCombo = mkCombo(hwnd, IDC_PRODUCT);
        { int n; const gibs::Product* P = gibs::products(n);
          for (int i = 0; i < n; ++i) SendMessageW(g.prodCombo, CB_ADDSTRING, 0, (LPARAM)P[i].label);
          SendMessageW(g.prodCombo, CB_SETCURSEL, 0, 0); }
        g.dateEdit = CreateWindowExW(WS_EX_CLIENTEDGE, L"EDIT", defaultDate().c_str(),
            WS_CHILD | WS_VISIBLE | ES_CENTER, 0,0,10,10, hwnd, (HMENU)IDC_DATE, nullptr, nullptr);
        mkButton(hwnd, L"Scarica reale", IDC_FETCH);
        mkButton(hwnd, L"⤓ Ultima (al volo)", IDC_LATEST);
        g.workerChk = mkCheck(hwnd, L"Via Cloudflare (cache edge)", IDC_WORKER, true);
        g.stripChk  = mkCheck(hwnd, L"Blocco: FVG → equatore", IDC_STRIP, false);

        g.bandList = CreateWindowExW(0, L"LISTBOX", nullptr,
            WS_CHILD | WS_VISIBLE | WS_BORDER | WS_VSCROLL | LBS_NOTIFY, 0,0,10,10, hwnd, (HMENU)IDC_BANDLIST, nullptr, nullptr);
        g.rgbChk = mkCheck(hwnd, L"Composito RGB false-color", IDC_RGB, false);
        g.rCombo = mkCombo(hwnd, IDC_RCOMBO); g.gCombo = mkCombo(hwnd, IDC_GCOMBO); g.bCombo = mkCombo(hwnd, IDC_BCOMBO);
        g.citiesChk  = mkCheck(hwnd, L"Mostra città", IDC_CITIES, true);
        g.bordersChk = mkCheck(hwnd, L"Mostra confini FVG", IDC_BORDERS, true);
        g.sharpChk   = mkCheck(hwnd, L"Nitidezza (unsharp)", IDC_SHARP, true);
        g.rawChk     = mkCheck(hwnd, L"Solo strato (senza base)", IDC_RAWLAYER, false);
        g.diffChk    = mkCheck(hwnd, L"Diff vs precedente", IDC_DIFF, false);
        mkButton(hwnd, L"Reset vista (fit)", IDC_RESET);
        mkButton(hwnd, L"Salva vista (PNG)", IDC_SAVEPNG);
        g.fpsEdit = CreateWindowExW(WS_EX_CLIENTEDGE, L"EDIT", L"6",
            WS_CHILD | WS_VISIBLE | ES_NUMBER | ES_CENTER, 0,0,10,10, hwnd, (HMENU)IDC_FPS, nullptr, nullptr);
        mkButton(hwnd, L"Genera filmato (MP4)", IDC_MOVIE);
        EnableWindow(g.rCombo, FALSE); EnableWindow(g.gCombo, FALSE); EnableWindow(g.bCombo, FALSE);
        return 0;
    }
    case WM_CTLCOLORLISTBOX: case WM_CTLCOLOREDIT: case WM_CTLCOLORSTATIC: {
        HDC dc = (HDC)wp; SetBkColor(dc, g.light ? RGB(248,250,252) : RGB(31,36,44));
        SetTextColor(dc, g.light ? RGB(22,26,32) : RGB(233,238,244));
        if (!g.cardBrush) g.cardBrush = CreateSolidBrush(g.light ? RGB(248,250,252) : RGB(31,36,44));
        return (LRESULT)g.cardBrush;
    }
    case WM_COMMAND: {
        int id = LOWORD(wp), code = HIWORD(wp);
        // Owner-drawn checkboxes do not toggle themselves: flip our state first,
        // then let the per-control case react to the new value.
        if (code == BN_CLICKED) {
            if (bool* st = checkStateFor(id)) {
                *st = !*st;
                InvalidateRect((HWND)lp, nullptr, TRUE);
            }
        }
        switch (id) {
        case IDC_OPEN:  doOpenDialog(); return 0;
        case IDC_FETCH: doFetchGibs(); return 0;
        case IDC_LATEST: doFetchLatest(); return 0;
        case IDC_WORKER: return 0;   // stato gia' invertito in WM_COMMAND, sopra
        case IDC_STRIP:
            applySelection(); return 0;
        case IDC_SHARP:
            rebuildImage(); buildStatus(); InvalidateRect(hwnd, nullptr, FALSE); return 0;
        case IDC_SAT: case IDC_PRODUCT:
            // Point of the dashboard: pick a product or a satellite and it is
            // simply there — cached ones instantly, the rest fetched quietly.
            if (code == CBN_SELCHANGE) applySelection();
            return 0;
        case IDC_RESET: fitView(); buildStatus(); InvalidateRect(hwnd, nullptr, FALSE); return 0;
        case IDC_MOVIE: doTimelapse(); return 0;
        case IDC_SAVEPNG: doSavePng(); return 0;
        case IDC_RGB:
            { bool bands = g.cur >= 0 && vHasBands(g.seq[g.cur]);
              EnableWindow(g.rCombo, bands && g.rgbMode); EnableWindow(g.gCombo, bands && g.rgbMode); EnableWindow(g.bCombo, bands && g.rgbMode); }
            rebuildImage(); fitView(); buildStatus(); InvalidateRect(hwnd, nullptr, FALSE); return 0;
        case IDC_CITIES:  InvalidateRect(hwnd, &g.rcCanvas, FALSE); return 0;
        case IDC_BORDERS: InvalidateRect(hwnd, &g.rcCanvas, FALSE); return 0;
        case IDC_DIFF:
            rebuildImage(); fitView(); buildStatus(); InvalidateRect(hwnd, nullptr, FALSE); return 0;
        case IDC_BANDLIST:
            if (code == LBN_SELCHANGE && g.cur >= 0 && vHasBands(g.seq[g.cur])) {
                int i = (int)SendMessageW(g.bandList, LB_GETCURSEL, 0, 0);
                if (i >= 0) {
                    g.singleBand = (int)SendMessageW(g.bandList, LB_GETITEMDATA, i, 0);
                    // Clicking a band means "show me this band": leave the RGB
                    // composite rather than selecting into a view that ignores it.
                    if (g.rgbMode) {
                        g.rgbMode = false;
                        InvalidateRect(g.rgbChk, nullptr, TRUE);
                        EnableWindow(g.rCombo, FALSE); EnableWindow(g.gCombo, FALSE); EnableWindow(g.bCombo, FALSE);
                    }
                    rebuildImage(); fitView(); buildStatus();
                    InvalidateRect(hwnd, nullptr, FALSE);
                }
            }
            return 0;
        case IDC_RCOMBO: case IDC_GCOMBO: case IDC_BCOMBO:
            if (code == CBN_SELCHANGE) {
                auto val = [&](HWND c) { int i = (int)SendMessageW(c, CB_GETCURSEL, 0, 0); return i < 0 ? 0 : (int)SendMessageW(c, CB_GETITEMDATA, i, 0); };
                g.rBand = val(g.rCombo); g.gBand = val(g.gCombo); g.bBand = val(g.bCombo);
                if (g.rgbMode) { rebuildImage(); fitView(); buildStatus(); InvalidateRect(hwnd, nullptr, FALSE); }
            }
            return 0;
        }
        return 0;
    }
    case WM_MOUSEWHEEL: { POINT pt{ GET_X_LPARAM(lp), GET_Y_LPARAM(lp) }; ScreenToClient(hwnd, &pt); onWheel(pt.x, pt.y, GET_WHEEL_DELTA_WPARAM(wp)); return 0; }
    case WM_LBUTTONDOWN: {
        int x = GET_X_LPARAM(lp), y = GET_Y_LPARAM(lp);
        if (inRect(g.rcFilm, x, y)) {
            int idx = (x - (g.rcFilm.left + FILM_PAD)) / (FILM_CELLW + FILM_PAD);
            if (idx >= 0 && idx < (int)g.seq.size()) {
                if (inRect(filmCloseRect(idx), x, y)) removeIndex(idx);
                else selectIndex(idx);
            }
            return 0;
        }
        if (inRect(g.rcCanvas, x, y)) {
            SetFocus(hwnd);   // senza questo le frecce restano ai controlli del pannello
            if (g.image) { g.dragging = true; g.lastX = x; g.lastY = y; SetCapture(hwnd); }
        }
        return 0;
    }
    case WM_MOUSEMOVE: {
        int x = GET_X_LPARAM(lp), y = GET_Y_LPARAM(lp);
        if (g.dragging) { g.originX += x - g.lastX; g.originY += y - g.lastY; g.lastX = x; g.lastY = y; InvalidateRect(hwnd, &g.rcCanvas, FALSE); }
        if (inRect(g.rcCanvas, x, y)) { buildStatus(x, y); InvalidateRect(hwnd, &g.rcStatus, FALSE); }
        return 0;
    }
    case WM_LBUTTONUP: if (g.dragging) { g.dragging = false; ReleaseCapture(); } return 0;
    case WM_SIZE: doLayout(); if (g.image) fitView(); return 0;
    case WM_SETTINGCHANGE:
        g.light = isLightTheme(); g.theme = makeTheme(g.light);
        if (g.cardBrush) { DeleteObject(g.cardBrush); g.cardBrush = nullptr; }
        { BOOL dark = !g.light; DwmSetWindowAttribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, &dark, sizeof dark); }
        InvalidateRect(hwnd, nullptr, FALSE); return 0;
    case WM_KEYDOWN: {
        const bool ctrl = (GetKeyState(VK_CONTROL) & 0x8000) != 0;
        switch (wp) {
        case VK_LEFT:  if (g.cur > 0) selectIndex(g.cur - 1); return 0;
        case VK_RIGHT: if (g.cur >= 0 && g.cur + 1 < (int)g.seq.size()) selectIndex(g.cur + 1); return 0;
        case VK_HOME:  if (!g.seq.empty()) selectIndex(0); return 0;
        case VK_END:   if (!g.seq.empty()) selectIndex((int)g.seq.size() - 1); return 0;
        case 'F':      fitView(); buildStatus(); InvalidateRect(hwnd, nullptr, FALSE); return 0;
        case 'S':      if (ctrl) { doSavePng(); return 0; } break;
        case VK_OEM_PLUS: case VK_ADD: case VK_OEM_MINUS: case VK_SUBTRACT: {
            // Zoom from the centre of the canvas, the keyboard's equivalent of
            // pointing the wheel at it.
            bool in = (wp == VK_OEM_PLUS || wp == VK_ADD);
            int cx = (g.rcCanvas.left + g.rcCanvas.right) / 2;
            int cy = (g.rcCanvas.top + g.rcCanvas.bottom) / 2;
            onWheel(cx, cy, in ? 120 : -120);
            return 0;
        }
        }
        return 0;
    }
    case WM_DRAWITEM:
        drawControl((const DRAWITEMSTRUCT*)lp);
        return TRUE;
    case WM_ERASEBKGND: return 1;
    case WM_PAINT: onPaint(); return 0;
    case WM_DESTROY: PostQuitMessage(0); return 0;
    }
    return DefWindowProcW(hwnd, msg, wp, lp);
}

// ----------------------------- entry --------------------------------------
int WINAPI wWinMain(HINSTANCE hInst, HINSTANCE, PWSTR cmdLine, int nShow) {
    GdiplusStartupInput gi; GdiplusStartup(&g.gdip, &gi, nullptr);
    INITCOMMONCONTROLSEX ic{ sizeof ic, ICC_STANDARD_CLASSES | ICC_BAR_CLASSES }; InitCommonControlsEx(&ic);
    g.light = isLightTheme(); g.theme = makeTheme(g.light);

    WNDCLASSW wc{}; wc.lpfnWndProc = WndProc; wc.hInstance = hInst; wc.lpszClassName = L"ModisFVGViewerWnd";
    wc.hCursor = LoadCursor(nullptr, IDC_ARROW); wc.hbrBackground = nullptr; wc.hIcon = LoadIcon(nullptr, IDI_APPLICATION);
    RegisterClassW(&wc);

    g.hwnd = CreateWindowExW(0, wc.lpszClassName, APP_TITLE, WS_OVERLAPPEDWINDOW,
        CW_USEDEFAULT, CW_USEDEFAULT, 1280, 900, nullptr, nullptr, hInst, nullptr);

    { BOOL dark = !g.light; DwmSetWindowAttribute(g.hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, &dark, sizeof dark); }
    { int backdrop = DWMSBT_MAINWINDOW; DwmSetWindowAttribute(g.hwnd, DWMWA_SYSTEMBACKDROP_TYPE, &backdrop, sizeof backdrop); }

    doLayout();
    logLine(L"MODIS FVG Viewer avviato");

    // Only real imagery is loaded at startup: the cache of MODIS/HLS granules
    // downloaded in earlier sessions. The synthetic .mgr samples stay in test/
    // and can still be opened by hand - they exist to exercise the reader and
    // the compositing offline, not to greet the user with a drawn cartoon.
    loadCache();
    if (!g.seq.empty()) selectIndex(0);

    if (cmdLine && cmdLine[0]) { std::wstring arg(cmdLine);
        if (!arg.empty() && arg.front() == L'"') arg = arg.substr(1, arg.find_last_of(L'"') - 1);
        if (GetFileAttributesW(arg.c_str()) != INVALID_FILE_ATTRIBUTES) openFilePath(arg); }

    ShowWindow(g.hwnd, nShow); UpdateWindow(g.hwnd);

    // Immagine di apertura: se la cache e' vuota (primo avvio) scarichiamo una
    // vera immagine MODIS, invece di lasciare il canvas spoglio.
    //
    // Terra in true-color, e non a caso. True-color perche' e' l'unica resa in
    // cui il Friuli si riconosce a colpo d'occhio: verde la pianura, scuro
    // l'Adriatico, bianche le Alpi. Terra perche' passa verso le 10:30 locali,
    // prima che il riscaldamento diurno monti i cumuli del pomeriggio: le sue
    // immagini sono mediamente piu' limpide di quelle di Aqua.
    //
    // Va fatto dopo ShowWindow: la finestra e' gia' a schermo e la barra di
    // stato racconta cosa sta succedendo, invece di sembrare bloccata.
    if (g.seq.empty()) {
        flashStatus(L"Primo avvio: scarico un'immagine MODIS recente\u2026");
        SendMessageW(g.satCombo,  CB_SETCURSEL, 0, 0);   // Terra
        SendMessageW(g.prodCombo, CB_SETCURSEL, 0, 0);   // True Color
        fetchGibsCore(0, 0, toU8(defaultDate()), /*quiet=*/true);
        if (g.seq.empty()) {
            g.statusText = L"Nessuna connessione o nessun dato: usa \u201cUltima (al volo)\u201d quando sei online.";
            InvalidateRect(g.hwnd, &g.rcStatus, FALSE);
        }
    }

    MSG m; while (GetMessageW(&m, nullptr, 0, 0)) { TranslateMessage(&m); DispatchMessageW(&m); }

    for (auto& gv : g.seq) if (gv.thumb) delete gv.thumb;
    if (g.image) delete g.image;
    if (g.cardBrush) DeleteObject(g.cardBrush);
    GdiplusShutdown(g.gdip);
    return 0;
}
