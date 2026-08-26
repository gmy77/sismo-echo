// Copyright (c) 2026 Gimmy Pignolo. Tutti i diritti riservati.
// MODIS-FVG Viewer 1.0.0 - vedi LICENSE nella radice del repository.
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
    const char*    id;          // worker product id: truecolor/bands721/…/hls_s30
    bool           temperature; // true => already a colorized LST layer
    int            nativeM;     // native ground resolution, metres per pixel
    bool           ignoresSat;  // true => not a Terra/Aqua product (HLS)
    const char*    overlayOn;   // id del prodotto di base su cui sovrapporlo
};

// The products offered in the UI.
//
// `nativeM` drives how many pixels we ask GIBS for: requesting more pixels than
// the sensor resolves only interpolates, which is exactly what makes MODIS look
// soft over an area as small as the FVG (~124 km wide = ~500 MODIS pixels).
// The HLS entries are Landsat/Sentinel-2 harmonised surface reflectance at 30 m
// — ~8x finer, so the same box resolves to ~4100 px and is genuinely sharp.
// The trade-off is revisit time: MODIS is twice daily, HLS every 2-3 days.
inline const Product* products(int& count) {
    static const Product P[] = {
        { L"True Color (riflettanza reale)",
          "MODIS_Terra_CorrectedReflectance_TrueColor",
          "MODIS_Aqua_CorrectedReflectance_TrueColor", "truecolor", false, 250, false, nullptr },
        { L"Bande 7-2-1 (naturale-migliorato)",
          "MODIS_Terra_CorrectedReflectance_Bands721",
          "MODIS_Aqua_CorrectedReflectance_Bands721", "bands721", false, 250, false, nullptr },
        { L"Bande 3-6-7 (neve / ghiaccio)",
          "MODIS_Terra_CorrectedReflectance_Bands367",
          "MODIS_Aqua_CorrectedReflectance_Bands367", "bands367", false, 250, false, nullptr },
        { L"Temp. superficie giorno (LST)",
          "MODIS_Terra_Land_Surface_Temp_Day",
          "MODIS_Aqua_Land_Surface_Temp_Day", "lst", true, 1000, false, nullptr },
        { L"★ Sentinel-2 30 m (nitido)",
          "HLS_S30_Nadir_BRDF_Adjusted_Reflectance",
          "HLS_S30_Nadir_BRDF_Adjusted_Reflectance", "hls_s30", false, 30, true, nullptr },
        { L"★ Landsat 30 m (nitido)",
          "HLS_L30_Nadir_BRDF_Adjusted_Reflectance",
          "HLS_L30_Nadir_BRDF_Adjusted_Reflectance", "hls_l30", false, 30, true, nullptr },
        // Incendi: il layer da solo e' quasi tutto trasparente (sono punti di
        // calore), quindi va sovrapposto a una base per essere leggibile.
        //
        // La base e' il composito 7-2-1, non il true-color, e non per gusto: la
        // banda 7 e' infrarosso a onde corte (2105-2155 nm), che attraversa il
        // fumo invece di fermarcisi sopra. Cosi' le cicatrici da incendio e il
        // suolo appena bruciato risaltano in rosso-arancio, la vegetazione viva
        // resta verde brillante e l'acqua nera. In true-color un incendio si
        // vedrebbe soprattutto come una macchia grigia di fumo, che nasconde
        // proprio la cosa che si vuole guardare.
        { L"\U0001F525 Incendi / anomalie termiche",
          "MODIS_Terra_Thermal_Anomalies_All",
          "MODIS_Aqua_Thermal_Anomalies_All", "fires", false, 250, false, "bands721" },
        { L"Aerosol (fumo, polveri, foschia)",
          "MODIS_Terra_Aerosol", "MODIS_Aqua_Aerosol", "aerosol", false, 1000, false, nullptr },
        { L"Neve / ghiaccio (NDSI)",
          "MODIS_Terra_NDSI_Snow_Cover", "MODIS_Aqua_NDSI_Snow_Cover", "snow", false, 500, false, nullptr },
        { L"Vegetazione (NDVI, 8 giorni)",
          "MODIS_Terra_NDVI_8Day", "MODIS_Aqua_NDVI_8Day", "ndvi", false, 250, false, nullptr },
        { L"Clorofilla del mare",
          "MODIS_Terra_Chlorophyll_A", "MODIS_Aqua_Chlorophyll_A", "chlor", false, 1000, false, nullptr },
    };
    count = (int)(sizeof P / sizeof P[0]);
    return P;
}

// How many pixels wide to request so the image is resolved at (but not beyond)
// the product's native ground resolution, capped to what GIBS/the Worker allow.
inline int requestWidthFor(const Product& p, double lonSpanDeg, double midLat) {
    const double kmPerDeg = 111.32 * (midLat > 0 ? 0.7 : 1.0); // cos(~46 deg)
    double km = lonSpanDeg * kmPerDeg;
    int px = (int)(km * 1000.0 / (p.nativeM > 0 ? p.nativeM : 250));
    if (px < 256)  px = 256;
    if (px > 4096) px = 4096;
    return px;
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
