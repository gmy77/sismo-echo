#!/usr/bin/env bash
# Build della sola CLI su Linux/macOS (per test).  Su Windows si usa la
# soluzione Visual Studio MeteoGrib.sln — vedi README_CPP.md.
#
# Richiede ecCodes con header C.  Esempi per impostare ECCODES_DIR:
#   - pacchetto di sistema:  sudo apt install libeccodes-dev   (poi ECCODES_DIR=/usr)
#   - via pip (bundle 2.48): usa anche ECKIT_DIR, es.
#       PKG=$(python3 -c "import eccodes,os;print(os.path.dirname(eccodes.__file__))")
#       ECCODES_DIR="$PKG/../eccodeslib" ECKIT_DIR="$PKG/../eckitlib" ./build_linux.sh
set -e
cd "$(dirname "$0")"

# Percorsi ecCodes: personalizzabili con la variabile ECCODES_DIR.
: "${ECCODES_DIR:=/usr}"
INC="$ECCODES_DIR/include"
LIB="$ECCODES_DIR/lib64"
[ -d "$LIB" ] || LIB="$ECCODES_DIR/lib"

echo "ecCodes: include=$INC  lib=$LIB"

# Opzionale: alcune build recenti di ecCodes (es. il pacchetto pip 2.48)
# dipendono anche dalle librerie eckit.  Indicane la cartella con ECKIT_DIR.
EXTRA=""
if [ -n "$ECKIT_DIR" ]; then
    EKLIB="$ECKIT_DIR/lib64"; [ -d "$EKLIB" ] || EKLIB="$ECKIT_DIR/lib"
    EXTRA="-L$EKLIB -Wl,-rpath,$EKLIB"
fi

g++ -std=c++14 -O2 -Iinclude -I"$INC" \
    src/grib_reader.cpp src/meteogrib_cli.cpp \
    -L"$LIB" -leccodes -Wl,-rpath,"$LIB" $EXTRA \
    -o meteogrib_cli

echo "Fatto: ./meteogrib_cli"
echo "Prova:  ./meteogrib_cli info tuofile.grib2"
