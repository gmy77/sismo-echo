#!/usr/bin/env bash
# fetch_fvg_grib.sh — scarica dal GFS (NOMADS) il ritaglio Friuli Venezia Giulia
# con CAPE + vento + temperatura + umidità, e lo ri-codifica in "simple packing"
# (template 5.0), l'unico che il parser dell'app legge oggi.
#
# Uso:  fetch_fvg_grib.sh [file_output.grib2]
# Richiede: curl, eccodes-tools (grib_set/grib_ls).
set -euo pipefail

OUT="${1:-FVG_latest.grib2}"

# Riquadro FVG (stesso della griglia del file di esempio): 12–14°E, 45–47°N.
BOX="subregion=&toplat=47&bottomlat=45&leftlon=12&rightlon=14"
# Variabili: CAPE, CIN, vento (U/V), temperatura, umidità relativa.
VARS="var_CAPE=on&var_CIN=on&var_UGRD=on&var_VGRD=on&var_TMP=on&var_RH=on"
# Livelli: superficie, 10 m, 2 m, 500 hPa.
LEVS="lev_surface=on&lev_10_m_above_ground=on&lev_2_m_above_ground=on&lev_500_mb=on"
FF=000  # analisi (t+0) = "adesso"

tmp="$(mktemp)"
ok=0
# Il ciclo GFS più recente è disponibile ~4 h dopo l'orario del run. Provo dai
# cicli più recenti a ritroso finché non ne trovo uno pronto e valido.
for back in 3 6 9 12 15 18 24 30; do
  ts=$(date -u -d "-${back} hours" +%s)
  hh=$(date -u -d "@${ts}" +%H)
  cyc=$(printf '%02d' $(( (10#$hh / 6) * 6 )))   # 00/06/12/18 precedente
  day=$(date -u -d "@${ts}" +%Y%m%d)
  url="https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl?dir=%2Fgfs.${day}%2F${cyc}%2Fatmos&file=gfs.t${cyc}z.pgrb2.0p25.f${FF}&${VARS}&${LEVS}&${BOX}"
  echo "Provo GFS ${day} ${cyc}z f${FF}..."
  if curl -sSL --fail --max-time 120 "$url" -o "$tmp" && [ -s "$tmp" ] \
        && grib_ls "$tmp" >/dev/null 2>&1; then
    echo "OK: $(stat -c%s "$tmp") byte, $(grib_count "$tmp") messaggi."
    ok=1; break
  fi
  echo "  non disponibile, provo un ciclo precedente."
done
[ "$ok" = 1 ] || { echo "ERRORE: nessun ciclo GFS disponibile."; exit 1; }

# Ri-codifica in simple packing (grid_simple) — così l'app lo legge.
grib_set -r -s packingType=grid_simple "$tmp" "$OUT"
rm -f "$tmp"

echo "Scritto ${OUT}:"
grib_ls -p shortName,typeOfLevel,level,packingType,dataDate,dataTime "$OUT"
