// grib_reader.h — lettura di file GRIB1/GRIB2 tramite l'API C di ecCodes.
// Parte del progetto SISMO ECHO — MeteoGrib (porting C++).
#ifndef METEOGRIB_GRIB_READER_H
#define METEOGRIB_GRIB_READER_H

#include <string>
#include <vector>

namespace mg {

// Un singolo messaggio GRIB decodificato.
struct GribField {
    int number = 0;                 // indice 1-based nel file
    std::string shortName = "?";
    std::string name = "?";
    std::string units = "";
    long edition = 2;
    long discipline = 0, category = -1, paramNumber = -1;
    long level = 0;
    std::string typeOfLevel;
    std::string dataDate;           // AAAAMMGG
    long dataTime = 0;              // HHMM
    std::string step;               // scadenza (ore)
    std::string gridType;
    long ni = 0, nj = 0;
    bool regular = false;           // true se griglia ni*nj regolare

    std::vector<double> values;     // nj*ni (row-major, NaN per i mancanti)
    std::vector<double> lats;       // stesse dimensioni
    std::vector<double> lons;

    // statistiche (ignorando i NaN)
    double vmin = 0, vmax = 0, vmean = 0;

    std::string levelLabel() const;
    std::string inventoryLine() const;  // riga stile wgrib2
};

// Categoria "grafica" del campo (per scegliere colormap/etichette).
enum class Kind { Temperature, Pressure, Precip, Humidity, Cape, WindU, WindV, Generic };
Kind classify(const GribField& f);
const char* displayUnit(Kind k, const std::string& fallback);

// Legge tutti i messaggi del file.  Ritorna false in caso di errore di apertura.
bool readGrib(const std::string& path, std::vector<GribField>& out, std::string& err);

} // namespace mg
#endif
