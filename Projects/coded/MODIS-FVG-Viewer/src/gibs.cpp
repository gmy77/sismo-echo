// gibs.cpp — WinHTTP download + GDI+ decode for NASA GIBS WMS. See gibs.h.
#ifndef UNICODE
#define UNICODE
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <winhttp.h>
#include <shlwapi.h>   // SHCreateMemStream
#include <algorithm>
using std::min; using std::max;
#include <gdiplus.h>

#include "gibs.h"
#include <vector>
#include <string>

#pragma comment(lib, "winhttp.lib")
#pragma comment(lib, "shlwapi.lib")
#pragma comment(lib, "gdiplus.lib")

using namespace Gdiplus;

namespace gibs {

static bool fail(std::wstring* err, const wchar_t* m, DWORD e = 0) {
    if (err) {
        wchar_t b[256];
        if (e) swprintf(b, 256, L"%s (err=%lu)", m, e);
        else   swprintf(b, 256, L"%s", m);
        *err = b;
    }
    return false;
}

// GET https://gibs.earthdata.nasa.gov/... into `body`. Returns false on error.
static bool httpGet(const std::wstring& path, std::vector<BYTE>& body, std::wstring* err) {
    const wchar_t* host = L"gibs.earthdata.nasa.gov";
    HINTERNET hSession = WinHttpOpen(L"MODIS-FVG-Viewer/1.0",
        WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (!hSession) return fail(err, L"WinHttpOpen fallita", GetLastError());

    HINTERNET hConnect = WinHttpConnect(hSession, host, INTERNET_DEFAULT_HTTPS_PORT, 0);
    if (!hConnect) { WinHttpCloseHandle(hSession); return fail(err, L"WinHttpConnect fallita", GetLastError()); }

    HINTERNET hReq = WinHttpOpenRequest(hConnect, L"GET", path.c_str(), nullptr,
        WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, WINHTTP_FLAG_SECURE);
    if (!hReq) { WinHttpCloseHandle(hConnect); WinHttpCloseHandle(hSession);
                 return fail(err, L"WinHttpOpenRequest fallita", GetLastError()); }

    bool ok = false;
    if (WinHttpSendRequest(hReq, WINHTTP_NO_ADDITIONAL_HEADERS, 0, WINHTTP_NO_REQUEST_DATA, 0, 0, 0) &&
        WinHttpReceiveResponse(hReq, nullptr)) {
        DWORD status = 0, len = sizeof status;
        WinHttpQueryHeaders(hReq, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                            WINHTTP_HEADER_NAME_BY_INDEX, &status, &len, WINHTTP_NO_HEADER_INDEX);
        if (status == 200) {
            DWORD avail = 0;
            do {
                if (!WinHttpQueryDataAvailable(hReq, &avail)) break;
                if (!avail) break;
                size_t off = body.size();
                body.resize(off + avail);
                DWORD read = 0;
                if (!WinHttpReadData(hReq, body.data() + off, avail, &read)) break;
                body.resize(off + read);
            } while (avail > 0);
            ok = !body.empty();
            if (!ok) fail(err, L"risposta vuota da GIBS");
        } else {
            wchar_t b[128]; swprintf(b, 128, L"GIBS ha risposto HTTP %lu", status);
            fail(err, b);
        }
    } else {
        fail(err, L"invio richiesta GIBS fallito", GetLastError());
    }

    WinHttpCloseHandle(hReq); WinHttpCloseHandle(hConnect); WinHttpCloseHandle(hSession);
    return ok;
}

static bool decode(const std::vector<BYTE>& body, img::Image& out, std::wstring* err) {
    IStream* stream = SHCreateMemStream(body.data(), (UINT)body.size());
    if (!stream) return fail(err, L"SHCreateMemStream fallita");
    Bitmap* bmp = Bitmap::FromStream(stream);
    stream->Release();
    if (!bmp || bmp->GetLastStatus() != Ok) { if (bmp) delete bmp; return fail(err, L"decodifica immagine fallita (formato non riconosciuto?)"); }

    int w = (int)bmp->GetWidth(), h = (int)bmp->GetHeight();
    out.w = w; out.h = h; out.px.assign((size_t)w * h, img::NODATA);
    Rect rc(0, 0, w, h); BitmapData bd;
    if (bmp->LockBits(&rc, ImageLockModeRead, PixelFormat32bppARGB, &bd) == Ok) {
        for (int y = 0; y < h; ++y) {
            const uint32_t* src = (const uint32_t*)((BYTE*)bd.Scan0 + (size_t)y * bd.Stride);
            for (int x = 0; x < w; ++x) out.px[(size_t)y * w + x] = 0xFF000000u | (src[x] & 0x00FFFFFFu);
        }
        bmp->UnlockBits(&bd);
    } else { delete bmp; return fail(err, L"LockBits fallita"); }
    delete bmp;
    return true;
}

bool decodeFile(const std::wstring& path, img::Image& out, std::wstring* err) {
    HANDLE h = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr,
                           OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) return fail(err, L"apertura file cache fallita", GetLastError());
    DWORD sz = GetFileSize(h, nullptr);
    std::vector<BYTE> body(sz);
    DWORD got = 0; BOOL ok = ReadFile(h, body.data(), sz, &got, nullptr);
    CloseHandle(h);
    if (!ok || got != sz) return fail(err, L"lettura file cache fallita");
    return decode(body, out, err);
}

static void writeFile(const std::wstring& path, const std::vector<BYTE>& body) {
    HANDLE h = CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr,
                           CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) return;
    DWORD wr; WriteFile(h, body.data(), (DWORD)body.size(), &wr, nullptr);
    CloseHandle(h);
}

bool download(const std::string& layer, const std::string& date,
              double latMin, double latMax, double lonMin, double lonMax,
              int width, int height, img::Image& out, std::wstring* err,
              const std::wstring& saveTo) {
    // WMS 1.3.0, EPSG:4326 -> BBOX axis order is lat,lon.
    char q[1024];
    std::snprintf(q, sizeof q,
        "/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0"
        "&LAYERS=%s&STYLES=&CRS=EPSG:4326&BBOX=%.5f,%.5f,%.5f,%.5f"
        "&WIDTH=%d&HEIGHT=%d&FORMAT=image/png&TIME=%s",
        layer.c_str(), latMin, lonMin, latMax, lonMax, width, height, date.c_str());
    // Widen the ASCII path to UTF-16 for WinHTTP.
    std::string path(q);
    std::wstring wpath(path.begin(), path.end());

    std::vector<BYTE> body;
    if (!httpGet(wpath, body, err)) return false;
    // A WMS error comes back as XML/text, not an image; guard on that.
    if (body.size() > 5 && (body[0] == '<' || (body[0] == 0xEF && body[1] == 0xBB)))
        return fail(err, L"GIBS ha restituito un errore (data senza copertura MODIS?)");
    if (!decode(body, out, err)) return false;
    if (!saveTo.empty()) writeFile(saveTo, body); // populate the disk cache
    return true;
}

} // namespace gibs
