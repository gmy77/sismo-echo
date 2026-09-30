// meteogrib_gui.cpp — interfaccia grafica minimale Win32 per MeteoGrib.
//
// Apre un file GRIB, elenca i campi in una lista, disegna la heatmap del
// campo selezionato e permette di attivare/disattivare le opzioni (città,
// badge del massimo, griglia) e di salvare BMP / esportare CSV.
//
// Compila solo su Windows (usa l'API Win32).  La logica di lettura e resa
// è condivisa con la CLI (grib_reader / render / bmp), quindi la GUI è un
// sottile strato di finestre sopra lo stesso motore.
//
// Parte del progetto SISMO ECHO — MeteoGrib (porting C++).
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <commdlg.h>
#include <shellapi.h>
#include <wininet.h>
#include <string>
#include <vector>
#include <memory>

#include "grib_reader.h"
#include "render.h"

#pragma comment(lib, "wininet.lib")

using namespace mg;

// Versione dell'applicazione.  All'uscita di una nuova release su GitHub, chi
// ha installato il programma la scarica dal pulsante "Aggiornamento".
#define APP_VERSION "1.0.0"

// Repository GitHub da cui prelevare gli aggiornamenti.
static const char* GH_API =
    "https://api.github.com/repos/gmy77/sismo-echo/releases/latest";

// ---- identificatori dei controlli ----------------------------------------
enum {
    IDC_OPEN = 101, IDC_SAVEBMP, IDC_SAVECSV,
    IDC_LIST, IDC_CHK_CITIES, IDC_CHK_MAX, IDC_CHK_GRID, IDC_STATUS, IDC_ABOUT,
    IDC_UPDATE, IDC_CHK_SMOOTH
};

static const char* ABOUT_TEXT =
    "MeteoGrib per Windows - versione " APP_VERSION "\r\n"
    "Visualizzatore di file GRIB (meteo) nativo, senza Cygwin.\r\n\r\n"
    "Una creazione di Gimmy Pignolo & Anthropic (Claude Code).\r\n"
    "Progetto SISMO ECHO - (c) 2026 Gimmy Pignolo - tutti i diritti riservati.\r\n\r\n"
    "Nato perche' su Windows mancano gestori GRIB semplici e nativi.\r\n"
    "Lettura dati: libreria ecCodes (ECMWF).";

static const int PANEL_W = 230;   // larghezza pannello controlli a sinistra

// ---- stato globale --------------------------------------------------------
static std::vector<GribField> g_fields;
static RenderOpts             g_opts;
static std::unique_ptr<Image> g_img;
static int                    g_sel = -1;
static std::string            g_file;
static HWND g_list, g_status;

// ---- utilità --------------------------------------------------------------
static void setStatus(HWND w, const std::string& s) {
    SetWindowTextA(g_status, s.c_str());
}

static void rerender(HWND w) {
    g_img.reset();
    if (g_sel >= 0 && g_sel < (int)g_fields.size() && g_fields[g_sel].regular) {
        const GribField& g = g_fields[g_sel];
        g_img.reset(new Image(renderField(g, classify(g), g_opts)));
        char buf[256];
        snprintf(buf, sizeof(buf), "%.60s  |  max %ld  min %ld",
                 g.shortName.c_str(), (long)g.vmax, (long)g.vmin);
        setStatus(w, buf);
    } else if (g_sel >= 0) {
        setStatus(w, "Campo su griglia non regolare: mappa non disponibile.");
    }
    InvalidateRect(w, nullptr, TRUE);
}

static void openFile(HWND w) {
    char path[MAX_PATH] = "";
    OPENFILENAMEA ofn = {0};
    ofn.lStructSize = sizeof(ofn);
    ofn.hwndOwner = w;
    ofn.lpstrFilter = "File GRIB\0*.grib;*.grib2;*.grb;*.grb2\0Tutti i file\0*.*\0";
    ofn.lpstrFile = path;
    ofn.nMaxFile = MAX_PATH;
    ofn.Flags = OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST;
    if (!GetOpenFileNameA(&ofn)) return;

    g_fields.clear(); g_sel = -1; g_img.reset();
    SendMessageA(g_list, LB_RESETCONTENT, 0, 0);

    std::string err;
    if (!readGrib(path, g_fields, err)) {
        MessageBoxA(w, err.c_str(), "MeteoGrib", MB_ICONERROR);
        return;
    }
    g_file = path;
    SetWindowTextA(w, ("MeteoGrib — " + std::string(path)).c_str());
    for (const auto& g : g_fields) {
        std::string line = std::to_string(g.number) + ": " + g.shortName
                         + "  " + g.levelLabel();
        SendMessageA(g_list, LB_ADDSTRING, 0, (LPARAM)line.c_str());
    }
    if (!g_fields.empty()) {
        SendMessageA(g_list, LB_SETCURSEL, 0, 0);
        g_sel = 0;
    }
    rerender(w);
}

static void saveBmp(HWND w) {
    if (!g_img) { MessageBoxA(w, "Nessuna mappa da salvare.", "MeteoGrib", MB_ICONINFORMATION); return; }
    char path[MAX_PATH] = "mappa.bmp";
    OPENFILENAMEA ofn = {0};
    ofn.lStructSize = sizeof(ofn); ofn.hwndOwner = w;
    ofn.lpstrFilter = "Immagine BMP\0*.bmp\0"; ofn.lpstrFile = path;
    ofn.nMaxFile = MAX_PATH; ofn.lpstrDefExt = "bmp";
    ofn.Flags = OFN_OVERWRITEPROMPT;
    if (GetSaveFileNameA(&ofn)) {
        if (g_img->saveBMP(path)) setStatus(w, std::string("Salvato: ")+path);
        else MessageBoxA(w,"Scrittura fallita.","MeteoGrib",MB_ICONERROR);
    }
}

static void saveCsv(HWND w) {
    if (g_sel < 0) return;
    const GribField& g = g_fields[g_sel];
    if (g.lats.size() != g.values.size() || g.lons.size() != g.values.size()
        || g.values.empty()) {
        MessageBoxA(w, "Coordinate lat/lon non disponibili per questo campo:\n"
                       "export CSV non possibile.", "MeteoGrib", MB_ICONWARNING);
        return;
    }
    char path[MAX_PATH] = "campo.csv";
    OPENFILENAMEA ofn = {0};
    ofn.lStructSize = sizeof(ofn); ofn.hwndOwner = w;
    ofn.lpstrFilter = "CSV\0*.csv\0"; ofn.lpstrFile = path;
    ofn.nMaxFile = MAX_PATH; ofn.lpstrDefExt = "csv";
    ofn.Flags = OFN_OVERWRITEPROMPT;
    if (!GetSaveFileNameA(&ofn)) return;
    FILE* f = fopen(path, "wb");
    if (!f) { MessageBoxA(w,"Scrittura fallita.","MeteoGrib",MB_ICONERROR); return; }
    fprintf(f, "# %s [%s] %s step %s\nlat,lon,valore\n",
            g.name.c_str(), g.units.c_str(), g.levelLabel().c_str(), g.step.c_str());
    for (size_t i=0;i<g.values.size();++i)
        fprintf(f, "%.4f,%.4f,%.6g\n", g.lats[i], g.lons[i], g.values[i]);
    fclose(f);
    setStatus(w, std::string("Esportato: ")+path);
}

// disegna l'Image (RGB top-down) nel rettangolo dst tramite StretchDIBits
static void blit(HDC hdc, const Image& img, RECT area) {
    // fit preservando le proporzioni
    double sx = double(area.right-area.left)/img.w;
    double sy = double(area.bottom-area.top)/img.h;
    double s = sx < sy ? sx : sy;
    int dw = int(img.w*s), dh = int(img.h*s);
    int dx = area.left + ((area.right-area.left)-dw)/2;
    int dy = area.top  + ((area.bottom-area.top)-dh)/2;

    // buffer 32-bit riusato tra i WM_PAINT: evita di riallocare a ogni frame
    static std::vector<uint32_t> buf;
    buf.resize(size_t(img.w)*img.h);
    for (size_t i=0;i<buf.size();++i) {
        RGB c = img.px[i];
        buf[i] = (uint32_t(c.r)<<16)|(uint32_t(c.g)<<8)|uint32_t(c.b);
    }
    BITMAPINFO bi = {0};
    bi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    bi.bmiHeader.biWidth = img.w;
    bi.bmiHeader.biHeight = -img.h;   // negativo = top-down
    bi.bmiHeader.biPlanes = 1;
    bi.bmiHeader.biBitCount = 32;
    bi.bmiHeader.biCompression = BI_RGB;
    SetStretchBltMode(hdc, HALFTONE);
    StretchDIBits(hdc, dx, dy, dw, dh, 0, 0, img.w, img.h,
                  buf.data(), &bi, DIB_RGB_COLORS, SRCCOPY);
}

// ==========================================================================
//  Aggiornamento automatico da GitHub Releases (solo WinINet, nessuna dip.)
// ==========================================================================

// GET HTTP(S).  Se 'toFile' è non nullo scrive lì il contenuto (download
// binario), altrimenti accumula in 'out' (testo, es. risposta JSON).
static bool httpGet(const std::string& url, std::string* out, const char* toFile) {
    HINTERNET hI = InternetOpenA("MeteoGrib-Updater/" APP_VERSION,
                                 INTERNET_OPEN_TYPE_PRECONFIG, nullptr, nullptr, 0);
    if (!hI) return false;
    DWORD flags = INTERNET_FLAG_RELOAD | INTERNET_FLAG_NO_CACHE_WRITE |
                  INTERNET_FLAG_NO_UI;
    if (url.rfind("https", 0) == 0) flags |= INTERNET_FLAG_SECURE;
    // GitHub richiede uno User-Agent: InternetOpenA lo imposta già.
    HINTERNET hU = InternetOpenUrlA(hI, url.c_str(), nullptr, 0, flags, 0);
    if (!hU) { InternetCloseHandle(hI); return false; }

    FILE* f = toFile ? fopen(toFile, "wb") : nullptr;
    if (toFile && !f) { InternetCloseHandle(hU); InternetCloseHandle(hI); return false; }

    char buf[8192]; DWORD n = 0; bool ok = true; BOOL r = TRUE;
    while ((r = InternetReadFile(hU, buf, sizeof(buf), &n)) && n > 0) {
        if (f) { if (fwrite(buf, 1, n, f) != n) { ok = false; break; } }
        else   out->append(buf, n);
    }
    if (!r) ok = false;   // InternetReadFile ha fallito prima dell'EOF
    if (f) { if (fclose(f) != 0) ok = false; }
    InternetCloseHandle(hU); InternetCloseHandle(hI);
    return ok;
}

// Estrae il valore stringa di una chiave JSON ("key":"valore").
static std::string jsonString(const std::string& s, const std::string& key) {
    size_t p = s.find("\"" + key + "\"");
    if (p == std::string::npos) return "";
    p = s.find(':', p); if (p == std::string::npos) return "";
    size_t a = s.find('"', p); if (a == std::string::npos) return "";
    size_t b = s.find('"', a + 1); if (b == std::string::npos) return "";
    return s.substr(a + 1, b - a - 1);
}

// Accetta solo URL HTTPS su domini GitHub attesi (gli asset delle release
// stanno su github.com o *.githubusercontent.com).  Evita di scaricare ed
// eseguire un binario da un host arbitrario finito nel JSON.
static bool isTrustedGithubUrl(const std::string& u) {
    if (u.rfind("https://", 0) != 0) return false;
    size_t host0 = 8;                         // dopo "https://"
    size_t host1 = u.find('/', host0);
    std::string host = u.substr(host0, host1 == std::string::npos
                                       ? std::string::npos : host1 - host0);
    auto endsWith = [](const std::string& s, const char* suf) {
        std::string t(suf); return s.size() >= t.size() &&
               s.compare(s.size()-t.size(), t.size(), t) == 0;
    };
    return host == "github.com" ||
           endsWith(host, ".githubusercontent.com");
}

// Primo asset .exe (su dominio GitHub) tra i browser_download_url.
static std::string firstExeAsset(const std::string& s) {
    const std::string k = "\"browser_download_url\"";
    size_t p = 0;
    while ((p = s.find(k, p)) != std::string::npos) {
        size_t a = s.find('"', p + k.size());
        size_t c = s.find(':', p);
        a = s.find('"', c);
        size_t b = s.find('"', a + 1);
        std::string url = s.substr(a + 1, b - a - 1);
        if (url.size() > 4 && url.substr(url.size() - 4) == ".exe"
            && isTrustedGithubUrl(url)) return url;
        p = b;
    }
    return "";
}

// Confronto versioni "1.2.3": true se 'latest' > 'current'.
static bool versionNewer(const std::string& latest, const std::string& current) {
    auto parse = [](const std::string& v, int out[3]) {
        out[0] = out[1] = out[2] = 0; int idx = 0; std::string num;
        for (char c : v) {
            if (c >= '0' && c <= '9') { num += c; }
            else if (!num.empty()) { if (idx < 3) out[idx++] = atoi(num.c_str()); num.clear(); }
        }
        if (!num.empty() && idx < 3) out[idx] = atoi(num.c_str());
    };
    int L[3], C[3]; parse(latest, L); parse(current, C);
    for (int i = 0; i < 3; ++i) { if (L[i] != C[i]) return L[i] > C[i]; }
    return false;
}

// Scrive un .bat che, uscito il programma, sostituisce l'exe e riavvia.
static bool launchSelfReplace(const std::string& newExe, const std::string& dstExe) {
    char tmp[MAX_PATH]; GetTempPathA(MAX_PATH, tmp);
    std::string bat = std::string(tmp) + "meteogrib_update.bat";
    FILE* f = fopen(bat.c_str(), "wb");
    if (!f) return false;
    fprintf(f,
        "@echo off\r\n"
        ":retry\r\n"
        "copy /y \"%s\" \"%s\" >nul 2>&1\r\n"
        "if errorlevel 1 ( timeout /t 1 /nobreak >nul & goto retry )\r\n"
        "start \"\" \"%s\"\r\n"
        "del \"%s\" >nul 2>&1\r\n"
        "del \"%%~f0\" >nul 2>&1\r\n",
        newExe.c_str(), dstExe.c_str(), dstExe.c_str(), newExe.c_str());
    fclose(f);
    HINSTANCE r = ShellExecuteA(nullptr, "open", bat.c_str(), nullptr, nullptr, SW_HIDE);
    return (INT_PTR)r > 32;
}

// Controlla la release più recente.  silent=true → notifica soltanto.
static void checkUpdate(HWND w, bool silent) {
    std::string json;
    if (!httpGet(GH_API, &json, nullptr) || json.empty()) {
        if (!silent) MessageBoxA(w, "Impossibile contattare GitHub.\n"
                                    "Controlla la connessione a Internet.",
                                 "Aggiornamento", MB_ICONWARNING);
        return;
    }
    std::string tag = jsonString(json, "tag_name");
    if (tag.empty()) {
        if (!silent) MessageBoxA(w, "Nessuna release trovata sul repository.",
                                 "Aggiornamento", MB_ICONINFORMATION);
        return;
    }
    if (!versionNewer(tag, APP_VERSION)) {
        if (!silent)
            MessageBoxA(w, "Sei gia' aggiornato (versione " APP_VERSION ").",
                        "Aggiornamento", MB_ICONINFORMATION);
        else
            setStatus(w, "MeteoGrib " APP_VERSION " - aggiornato.");
        return;
    }
    // c'è una versione più recente
    std::string asset = firstExeAsset(json);
    std::string msg = "Disponibile una nuova versione: " + tag +
                      "\n(installata: " APP_VERSION ")\n\nScaricare e installare ora?";
    if (silent) { setStatus(w, ("Aggiornamento disponibile: " + tag).c_str()); return; }
    if (MessageBoxA(w, msg.c_str(), "Aggiornamento", MB_ICONQUESTION | MB_YESNO) != IDYES)
        return;
    if (asset.empty() || !isTrustedGithubUrl(asset)) {
        MessageBoxA(w, "La release non contiene un file .exe scaricabile da un "
                       "dominio GitHub attendibile.", "Aggiornamento", MB_ICONWARNING);
        return;
    }
    char tmp[MAX_PATH]; GetTempPathA(MAX_PATH, tmp);
    std::string newExe = std::string(tmp) + "MeteoGrib_new.exe";
    setStatus(w, "Scaricamento in corso...");
    if (!httpGet(asset, nullptr, newExe.c_str())) {
        MessageBoxA(w, "Download fallito.", "Aggiornamento", MB_ICONERROR);
        return;
    }
    char self[MAX_PATH]; GetModuleFileNameA(nullptr, self, MAX_PATH);
    if (launchSelfReplace(newExe, self)) {
        MessageBoxA(w, "Aggiornamento scaricato. Il programma si riavviera' "
                       "con la nuova versione.", "Aggiornamento", MB_ICONINFORMATION);
        PostQuitMessage(0);   // esci: il .bat sostituisce l'exe e riavvia
    } else {
        MessageBoxA(w, "Impossibile avviare la sostituzione automatica.",
                    "Aggiornamento", MB_ICONERROR);
    }
}

static LRESULT CALLBACK WndProc(HWND w, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
    case WM_CREATE: {
        int y = 10;
        CreateWindowA("BUTTON","Apri GRIB...",WS_CHILD|WS_VISIBLE,
                      10,y,200,28,w,(HMENU)IDC_OPEN,0,0); y+=36;
        CreateWindowA("BUTTON","Salva BMP...",WS_CHILD|WS_VISIBLE,
                      10,y,95,26,w,(HMENU)IDC_SAVEBMP,0,0);
        CreateWindowA("BUTTON","Esporta CSV",WS_CHILD|WS_VISIBLE,
                      115,y,95,26,w,(HMENU)IDC_SAVECSV,0,0); y+=32;
        CreateWindowA("BUTTON","Aggiornamento",WS_CHILD|WS_VISIBLE,
                      10,y,95,24,w,(HMENU)IDC_UPDATE,0,0);
        CreateWindowA("BUTTON","Info / Crediti",WS_CHILD|WS_VISIBLE,
                      115,y,95,24,w,(HMENU)IDC_ABOUT,0,0); y+=34;
        CreateWindowA("BUTTON","Mostra citta'",WS_CHILD|WS_VISIBLE|BS_AUTOCHECKBOX,
                      10,y,200,22,w,(HMENU)IDC_CHK_CITIES,0,0);
        CheckDlgButton(w,IDC_CHK_CITIES,BST_CHECKED); y+=26;
        CreateWindowA("BUTTON","Badge del massimo",WS_CHILD|WS_VISIBLE|BS_AUTOCHECKBOX,
                      10,y,200,22,w,(HMENU)IDC_CHK_MAX,0,0);
        CheckDlgButton(w,IDC_CHK_MAX,BST_CHECKED); y+=26;
        CreateWindowA("BUTTON","Sfuma (interpola)",WS_CHILD|WS_VISIBLE|BS_AUTOCHECKBOX,
                      10,y,200,22,w,(HMENU)IDC_CHK_SMOOTH,0,0);
        CheckDlgButton(w,IDC_CHK_SMOOTH,BST_CHECKED); y+=26;
        CreateWindowA("BUTTON","Griglia",WS_CHILD|WS_VISIBLE|BS_AUTOCHECKBOX,
                      10,y,200,22,w,(HMENU)IDC_CHK_GRID,0,0); y+=32;
        CreateWindowA("STATIC","Campi:",WS_CHILD|WS_VISIBLE,10,y,200,16,w,0,0,0); y+=20;
        g_list = CreateWindowA("LISTBOX","",
                      WS_CHILD|WS_VISIBLE|WS_VSCROLL|LBS_NOTIFY,
                      10,y,200,260,w,(HMENU)IDC_LIST,0,0);
        g_status = CreateWindowA("STATIC",
                      "Apri un file GRIB per iniziare.\r\n\r\n"
                      "MeteoGrib v" APP_VERSION " - creazione di\r\nGimmy Pignolo & Anthropic",
                      WS_CHILD|WS_VISIBLE,10,y+270,210,90,w,(HMENU)IDC_STATUS,0,0);
        PostMessageA(w, WM_APP + 1, 0, 0);   // controllo aggiornamenti all'avvio
        return 0;
    }
    case WM_APP + 1:                          // check silenzioso post-creazione
        checkUpdate(w, true);
        return 0;
    case WM_COMMAND: {
        int id = LOWORD(wp), code = HIWORD(wp);
        switch (id) {
        case IDC_OPEN:    openFile(w); break;
        case IDC_SAVEBMP: saveBmp(w); break;
        case IDC_SAVECSV: saveCsv(w); break;
        case IDC_ABOUT:
            MessageBoxA(w, ABOUT_TEXT, "MeteoGrib - Info", MB_ICONINFORMATION);
            break;
        case IDC_UPDATE:
            checkUpdate(w, false);
            break;
        case IDC_CHK_CITIES:
            g_opts.showCities = IsDlgButtonChecked(w,IDC_CHK_CITIES)==BST_CHECKED;
            rerender(w); break;
        case IDC_CHK_MAX:
            g_opts.showMax = IsDlgButtonChecked(w,IDC_CHK_MAX)==BST_CHECKED;
            rerender(w); break;
        case IDC_CHK_GRID:
            g_opts.showGrid = IsDlgButtonChecked(w,IDC_CHK_GRID)==BST_CHECKED;
            rerender(w); break;
        case IDC_CHK_SMOOTH:
            g_opts.smooth = IsDlgButtonChecked(w,IDC_CHK_SMOOTH)==BST_CHECKED;
            rerender(w); break;
        case IDC_LIST:
            if (code == LBN_SELCHANGE) {
                g_sel = (int)SendMessageA(g_list, LB_GETCURSEL, 0, 0);
                rerender(w);
            }
            break;
        }
        return 0;
    }
    case WM_PAINT: {
        PAINTSTRUCT ps; HDC hdc = BeginPaint(w, &ps);
        RECT rc; GetClientRect(w, &rc);
        RECT map = { PANEL_W, 0, rc.right, rc.bottom };
        HBRUSH bg = CreateSolidBrush(RGB(12,18,28));
        FillRect(hdc, &map, bg); DeleteObject(bg);
        if (g_img) blit(hdc, *g_img, map);
        else {
            SetBkMode(hdc, TRANSPARENT); SetTextColor(hdc, RGB(150,170,200));
            const char* t = "Apri un file GRIB (pulsante in alto a sinistra).";
            TextOutA(hdc, PANEL_W+24, 24, t, lstrlenA(t));
        }
        EndPaint(w, &ps);
        return 0;
    }
    case WM_DESTROY: PostQuitMessage(0); return 0;
    }
    return DefWindowProcA(w, msg, wp, lp);
}

int WINAPI WinMain(HINSTANCE hInst, HINSTANCE, LPSTR, int nShow) {
    WNDCLASSA wc = {0};
    wc.lpfnWndProc = WndProc;
    wc.hInstance = hInst;
    wc.hCursor = LoadCursor(0, IDC_ARROW);
    wc.hbrBackground = (HBRUSH)(COLOR_BTNFACE+1);
    wc.lpszClassName = "MeteoGribWnd";
    RegisterClassA(&wc);

    HWND w = CreateWindowA("MeteoGribWnd",
        "MeteoGrib v" APP_VERSION " - visualizzatore GRIB (Pignolo & Anthropic)",
        WS_OVERLAPPEDWINDOW, CW_USEDEFAULT, CW_USEDEFAULT, 1040, 720,
        0, 0, hInst, 0);
    ShowWindow(w, nShow);
    UpdateWindow(w);

    MSG m;
    while (GetMessage(&m, 0, 0, 0)) { TranslateMessage(&m); DispatchMessage(&m); }
    return 0;
}
#else
int main() { return 0; }   // la GUI è solo Windows
#endif
