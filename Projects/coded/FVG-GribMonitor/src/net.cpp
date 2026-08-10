// net.cpp — WinHTTP implementation of net.h.
#include "net.h"
#include <windows.h>
#include <winhttp.h>
#include <cstdio>
#include <cstdlib>

#pragma comment(lib, "winhttp.lib")

namespace net {

static std::wstring toW(const std::string& s) {
    if (s.empty()) return L"";
    int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), nullptr, 0);
    std::wstring w(n, 0);
    MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), &w[0], n);
    return w;
}
bool httpGet(const std::wstring& url, std::vector<uint8_t>& out, std::string& err) {
    out.clear();
    URL_COMPONENTS uc; ZeroMemory(&uc, sizeof(uc)); uc.dwStructSize = sizeof(uc);
    wchar_t host[256] = {0}, path[2048] = {0};
    uc.lpszHostName = host; uc.dwHostNameLength = 255;
    uc.lpszUrlPath = path; uc.dwUrlPathLength = 2047;
    if (!WinHttpCrackUrl(url.c_str(), 0, 0, &uc)) { err = "URL non valido"; return false; }

    HINTERNET hs = WinHttpOpen(L"FVG-GribMonitor/1.0",
        WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_NO_PROXY_NAME,
        WINHTTP_NO_PROXY_BYPASS, 0);
    if (!hs) { err = "WinHttpOpen fallita"; return false; }

    bool https = (uc.nScheme == INTERNET_SCHEME_HTTPS);
    HINTERNET hc = WinHttpConnect(hs, host, uc.nPort, 0);
    HINTERNET hr = hc ? WinHttpOpenRequest(hc, L"GET", path, nullptr,
        WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES,
        https ? WINHTTP_FLAG_SECURE : 0) : nullptr;

    bool ok = false;
    if (hr) {
        // WinHTTP follows HTTP redirects by default, which is what we want for
        // GitHub's release-asset download URLs (they redirect to a CDN).
        if (WinHttpSendRequest(hr, WINHTTP_NO_ADDITIONAL_HEADERS, 0,
                WINHTTP_NO_REQUEST_DATA, 0, 0, 0) &&
            WinHttpReceiveResponse(hr, nullptr)) {
            DWORD status = 0, sz = sizeof(status);
            WinHttpQueryHeaders(hr, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                WINHTTP_HEADER_NAME_BY_INDEX, &status, &sz, WINHTTP_NO_HEADER_INDEX);
            if (status >= 200 && status < 300) {
                DWORD avail = 0;
                do {
                    avail = 0;
                    if (!WinHttpQueryDataAvailable(hr, &avail)) break;
                    if (!avail) break;
                    size_t off = out.size();
                    out.resize(off + avail);
                    DWORD read = 0;
                    if (!WinHttpReadData(hr, out.data() + off, avail, &read)) break;
                    out.resize(off + read);
                } while (avail > 0);
                ok = true;
            } else {
                char buf[64]; std::snprintf(buf, sizeof(buf), "HTTP %lu", status);
                err = buf;
            }
        } else {
            err = "richiesta fallita (rete?)";
        }
    } else {
        err = "connessione fallita";
    }
    if (hr) WinHttpCloseHandle(hr);
    if (hc) WinHttpCloseHandle(hc);
    if (hs) WinHttpCloseHandle(hs);
    return ok;
}

bool downloadToFile(const std::wstring& url, const std::wstring& path, std::string& err) {
    std::vector<uint8_t> body;
    if (!httpGet(url, body, err)) return false;
    FILE* fp = _wfopen(path.c_str(), L"wb");
    if (!fp) { err = "impossibile scrivere il file"; return false; }
    if (!body.empty()) std::fwrite(body.data(), 1, body.size(), fp);
    std::fclose(fp);
    return true;
}

// Extract the string value of "key":"value" from a JSON blob (first match).
static std::string jsonStr(const std::string& j, const std::string& key) {
    std::string pat = "\"" + key + "\"";
    size_t p = j.find(pat);
    if (p == std::string::npos) return "";
    p = j.find(':', p + pat.size());
    if (p == std::string::npos) return "";
    p = j.find('"', p);
    if (p == std::string::npos) return "";
    size_t q = j.find('"', p + 1);
    while (q != std::string::npos && j[q - 1] == '\\') q = j.find('"', q + 1);
    if (q == std::string::npos) return "";
    return j.substr(p + 1, q - p - 1);
}

bool latestRelease(const std::string& owner, const std::string& repo,
                   Release& rel, std::string& err) {
    std::wstring url = L"https://api.github.com/repos/" + toW(owner) + L"/" +
                       toW(repo) + L"/releases/latest";
    std::vector<uint8_t> body;
    if (!httpGet(url, body, err)) return false;
    std::string j(body.begin(), body.end());
    rel.tag = jsonStr(j, "tag_name");
    rel.htmlUrl = jsonStr(j, "html_url");
    if (rel.tag.empty()) { err = "nessuna release trovata"; return false; }

    // First asset with a browser_download_url; prefer .exe then .zip.
    size_t p = 0; std::string firstUrl, firstName;
    while ((p = j.find("\"browser_download_url\"", p)) != std::string::npos) {
        std::string sub = j.substr(p);
        std::string durl = jsonStr(sub, "browser_download_url");
        // name appears just before in the same asset object
        size_t np = j.rfind("\"name\"", p);
        std::string name = np != std::string::npos ? jsonStr(j.substr(np), "name") : "";
        if (firstUrl.empty()) { firstUrl = durl; firstName = name; }
        auto endsWith = [](const std::string& s, const std::string& e) {
            return s.size() >= e.size() && s.compare(s.size() - e.size(), e.size(), e) == 0;
        };
        if (endsWith(name, ".exe")) { rel.assetUrl = durl; rel.assetName = name; break; }
        p += 22;
    }
    if (rel.assetUrl.empty()) { rel.assetUrl = firstUrl; rel.assetName = firstName; }
    return true;
}

int compareVersions(const std::string& a, const std::string& b) {
    auto nums = [](const std::string& s) {
        std::vector<int> v; int cur = 0; bool in = false;
        for (char ch : s) {
            if (ch >= '0' && ch <= '9') { cur = cur * 10 + (ch - '0'); in = true; }
            else if (in) { v.push_back(cur); cur = 0; in = false; }
        }
        if (in) v.push_back(cur);
        return v;
    };
    auto va = nums(a), vb = nums(b);
    for (size_t i = 0; i < va.size() || i < vb.size(); ++i) {
        int x = i < va.size() ? va[i] : 0;
        int y = i < vb.size() ? vb[i] : 0;
        if (x != y) return x < y ? -1 : 1;
    }
    return 0;
}

} // namespace net
