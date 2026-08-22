// net.h — tiny HTTPS client + GitHub release check, built on WinHTTP.
// Windows-only (this is the part that talks to the network).
#pragma once
#include <string>
#include <vector>
#include <cstdint>

namespace net {

// GET a URL over HTTPS. Returns true on 2xx and fills `out` with the body.
// `err` receives a human message on failure. Follows redirects.
bool httpGet(const std::wstring& url, std::vector<uint8_t>& out, std::string& err);

// Download a URL straight to a file path. Returns true on success.
bool downloadToFile(const std::wstring& url, const std::wstring& path, std::string& err);

struct Release {
    std::string tag;          // e.g. "v1.2.0"
    std::string htmlUrl;      // release page
    std::string assetUrl;     // browser_download_url of the first .exe/.zip asset
    std::string assetName;
};

// Query https://api.github.com/repos/<owner>/<repo>/releases/latest.
// Minimal JSON scraping (no external json lib). Returns true if a release was found.
bool latestRelease(const std::string& owner, const std::string& repo,
                   Release& rel, std::string& err);

// Compare two semver-ish tags ("v1.2.0"). Returns >0 if a>b, 0 if equal, <0 if a<b.
int compareVersions(const std::string& a, const std::string& b);

} // namespace net
