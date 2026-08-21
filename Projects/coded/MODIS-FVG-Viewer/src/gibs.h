// gibs.h — fetch *real* MODIS imagery from NASA GIBS (Global Imagery Browse
// Services) over WMS, cropped to a lat/lon box. Windows-only: downloads with
// WinHTTP and decodes the PNG/JPEG with GDI+ (no GDAL, no HDF, no ffmpeg).
//
// GIBS serves georeferenced MODIS Terra/Aqua products as WMS layers, so the
// returned image is already map-projected to EPSG:4326 over the requested BBOX
// — which is exactly how this viewer geolocates a granule.
#pragma once
#include "image.h"
#include <string>

namespace gibs {

// The Cloudflare Worker that proxies + caches GIBS (see sismo-worker/index.js).
// The app can fetch through it ("al volo", edge-cached) instead of hitting NASA
// directly. Host only — the app builds the /modis path.
inline const char* workerHost() { return "sismo-fvg.gimmy077.workers.dev"; }

// A user-facing product with its Terra/Aqua GIBS layer identifiers, plus the
// short id understood by the Worker (?product=...).
struct Product {
    const wchar_t* label;
    const char*    terraLayer;
    const char*    aquaLayer;
    const char*    id;          // worker product id: truecolor/bands721/bands367/lst
    bool           temperature; // true => already a colorized LST layer
};

// The products offered in the UI.
inline const Product* products(int& count) {
    static const Product P[] = {
        { L"True Color (riflettanza reale)",
          "MODIS_Terra_CorrectedReflectance_TrueColor",
          "MODIS_Aqua_CorrectedReflectance_TrueColor", "truecolor", false },
        { L"Bande 7-2-1 (naturale-migliorato)",
          "MODIS_Terra_CorrectedReflectance_Bands721",
          "MODIS_Aqua_CorrectedReflectance_Bands721", "bands721", false },
        { L"Bande 3-6-7 (neve / ghiaccio)",
          "MODIS_Terra_CorrectedReflectance_Bands367",
          "MODIS_Aqua_CorrectedReflectance_Bands367", "bands367", false },
        { L"Temp. superficie giorno (LST)",
          "MODIS_Terra_Land_Surface_Temp_Day",
          "MODIS_Aqua_Land_Surface_Temp_Day", "lst", true },
    };
    count = (int)(sizeof P / sizeof P[0]);
    return P;
}

// Download and decode a GIBS WMS GetMap into `out` (top-down 0xAARRGGBB).
// `layer` is a GIBS layer id, `date` is "YYYY-MM-DD". BBOX is degrees.
// If `saveTo` is non-empty the raw PNG is written there first (disk cache).
// Returns false and fills *err on failure.
bool download(const std::string& layer, const std::string& date,
              double latMin, double latMax, double lonMin, double lonMax,
              int width, int height, img::Image& out, std::wstring* err = nullptr,
              const std::wstring& saveTo = L"");

// Same as download(), but through the Cloudflare Worker proxy/cache: GET
// https://<host>/modis?sat=&product=&date=&bbox=&w=&h= . `sat` is "terra"/"aqua",
// `product` is a Worker id (truecolor/bands721/bands367/lst). If `date` is empty
// the Worker uses the latest (yesterday UTC) — this is the "al volo" path.
bool downloadViaWorker(const std::string& host, const std::string& sat,
                       const std::string& product, const std::string& date,
                       double latMin, double latMax, double lonMin, double lonMax,
                       int width, int height, img::Image& out,
                       std::wstring* err = nullptr, const std::wstring& saveTo = L"");

// Decode a cached PNG/JPEG file from disk into `out`. No network.
bool decodeFile(const std::wstring& path, img::Image& out, std::wstring* err = nullptr);

} // namespace gibs
