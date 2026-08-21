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

// A user-facing product with its Terra/Aqua GIBS layer identifiers.
struct Product {
    const wchar_t* label;
    const char*    terraLayer;
    const char*    aquaLayer;
    bool           temperature; // true => already a colorized LST layer
};

// The products offered in the UI.
inline const Product* products(int& count) {
    static const Product P[] = {
        { L"True Color (riflettanza reale)",
          "MODIS_Terra_CorrectedReflectance_TrueColor",
          "MODIS_Aqua_CorrectedReflectance_TrueColor", false },
        { L"Bande 7-2-1 (naturale-migliorato)",
          "MODIS_Terra_CorrectedReflectance_Bands721",
          "MODIS_Aqua_CorrectedReflectance_Bands721", false },
        { L"Bande 3-6-7 (neve / ghiaccio)",
          "MODIS_Terra_CorrectedReflectance_Bands367",
          "MODIS_Aqua_CorrectedReflectance_Bands367", false },
        { L"Temp. superficie giorno (LST)",
          "MODIS_Terra_Land_Surface_Temp_Day",
          "MODIS_Aqua_Land_Surface_Temp_Day", true },
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

// Decode a cached PNG/JPEG file from disk into `out`. No network.
bool decodeFile(const std::wstring& path, img::Image& out, std::wstring* err = nullptr);

} // namespace gibs
