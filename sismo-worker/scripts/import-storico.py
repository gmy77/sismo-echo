#!/usr/bin/env python3
"""
Import dello storico nei database D1 di sismo-fvg.

Genera file SQL (INSERT OR IGNORE, quindi rilanciabile senza duplicati) con:
  - terremoti FVG  (INGV FDSN, stesso riquadro e soglia M0.5 del cron)  -> D1 terremoti-fvg, tabella terremoti
  - terremoti CF   (INGV FDSN, riquadro Campi Flegrei, M0.0)            -> D1 terremoti-cf,  tabella terremoti
  - Kp ogni 3 ore dal 1932 (GFZ Potsdam, file ufficiale)               -> D1 terremoti-fvg, tabella dati_solari

Uso (dalla cartella sismo-worker):
  python scripts/import-storico.py              # scarica e scrive scripts/out/*.sql
  npx wrangler d1 execute terremoti-fvg --remote --file scripts/out/fvg.sql
  npx wrangler d1 execute terremoti-cf  --remote --file scripts/out/cf.sql
  npx wrangler d1 execute terremoti-fvg --remote --file scripts/out/kp.sql

Stessi formati del cron in index.js: data_ora = tempo INGV (26 caratteri, ISO con 'T'),
time_tag Kp = 'YYYY-MM-DDTHH:00:00' (inizio dell'intervallo di 3 ore, come NOAA).
"""
import datetime as dt
import os
import sys
import time
import urllib.request

INGV = "https://webservices.ingv.it/fdsnws/event/1/query"
GFZ_KP = "https://kp.gfz.de/app/files/Kp_ap_since_1932.txt"
UA = {"User-Agent": "SismoFVG-storico/1.0 gimmycloud.net"}

# Stessi riquadri di index.js (FVG, CF)
FVG = dict(lat_min=45.5, lat_max=46.8, lon_min=12.4, lon_max=14.1, min_mag=0.5)
CF = dict(lat_min=40.4, lat_max=41.1, lon_min=13.7, lon_max=14.8, min_mag=0.0)

ANNO_INIZIO = 1985  # inizio del catalogo strumentale INGV disponibile via FDSN
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
RIGHE_PER_INSERT = 200


def get(url, tentativi=4):
    for i in range(tentativi):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r:
                if r.status == 204:
                    return ""
                return r.read().decode("utf-8", "replace")
        except Exception as e:  # rete instabile o INGV lento: riprova con attesa crescente
            if i == tentativi - 1:
                raise
            print(f"  riprovo ({e})", file=sys.stderr)
            time.sleep(5 * (i + 1))


def q(s):
    """Letterale SQL sicuro per stringhe."""
    return "NULL" if s is None else "'" + str(s).replace("'", "''") + "'"


def num(x):
    try:
        return repr(float(x))
    except (TypeError, ValueError):
        return "NULL"


def scarica_area(area, nome):
    righe = {}
    anno_fine = dt.date.today().year
    for anno in range(ANNO_INIZIO, anno_fine + 1):
        url = (f"{INGV}?format=text&starttime={anno}-01-01T00:00:00&endtime={anno + 1}-01-01T00:00:00"
               f"&minmagnitude={area['min_mag']}"
               f"&minlatitude={area['lat_min']}&maxlatitude={area['lat_max']}"
               f"&minlongitude={area['lon_min']}&maxlongitude={area['lon_max']}&orderby=time")
        testo = get(url)
        n = 0
        for linea in testo.splitlines():
            if not linea or linea.startswith("#"):
                continue
            c = linea.split("|")
            if len(c) < 13:
                continue
            ev_id, tempo, lat, lon, prof, mag, luogo = c[0], c[1], c[2], c[3], c[4], c[10], c[12]
            try:
                float(mag)
            except ValueError:
                continue
            righe[ev_id] = (ev_id, tempo[:26], mag, lat, lon, prof, luogo or "N/D")
            n += 1
        print(f"  {nome} {anno}: {n}")
        time.sleep(0.5)  # gentili con INGV
    return list(righe.values())


def scrivi_terremoti(righe, file_sql):
    with open(file_sql, "w", encoding="utf-8") as f:
        f.write("CREATE INDEX IF NOT EXISTS idx_terremoti_data_ora ON terremoti(data_ora);\n")
        f.write("CREATE INDEX IF NOT EXISTS idx_terremoti_mag ON terremoti(magnitudine);\n")
        for i in range(0, len(righe), RIGHE_PER_INSERT):
            blocco = righe[i:i + RIGHE_PER_INSERT]
            valori = ",\n".join(
                f"({q(e)},{q(t)},{num(m)},{num(la)},{num(lo)},{num(p)},{q(l)})"
                for e, t, m, la, lo, p, l in blocco)
            f.write("INSERT OR IGNORE INTO terremoti "
                    "(event_id,data_ora,magnitudine,latitudine,longitudine,profondita,localita) VALUES\n"
                    f"{valori};\n")


def scarica_kp():
    righe = []
    for linea in get(GFZ_KP).splitlines():
        if not linea or linea.startswith("#"):
            continue
        c = linea.split()
        # YYYY MM DD hh.h hh._m days days_m Kp ap D
        if len(c) < 8:
            continue
        try:
            y, m, d = int(c[0]), int(c[1]), int(c[2])
            ora = int(float(c[3]))
            kp = float(c[7])
        except ValueError:
            continue
        if kp < 0:  # -1 = valore mancante nel file GFZ
            continue
        righe.append((f"{y:04d}-{m:02d}-{d:02d}T{ora:02d}:00:00", round(kp, 2)))
    return righe


def scrivi_kp(righe, file_sql):
    with open(file_sql, "w", encoding="utf-8") as f:
        for i in range(0, len(righe), RIGHE_PER_INSERT * 2):
            blocco = righe[i:i + RIGHE_PER_INSERT * 2]
            valori = ",".join(f"({q(t)},{kp!r})" for t, kp in blocco)
            f.write(f"INSERT OR IGNORE INTO dati_solari (time_tag,kp_index) VALUES {valori};\n")


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # console Windows cp1252
    os.makedirs(OUT, exist_ok=True)
    print("INGV — Friuli Venezia Giulia")
    fvg = scarica_area(FVG, "FVG")
    scrivi_terremoti(fvg, os.path.join(OUT, "fvg.sql"))
    print("INGV — Campi Flegrei / Vesuvio / Ischia")
    cf = scarica_area(CF, "CF")
    scrivi_terremoti(cf, os.path.join(OUT, "cf.sql"))
    print("GFZ — Kp dal 1932")
    kp = scarica_kp()
    scrivi_kp(kp, os.path.join(OUT, "kp.sql"))
    print(f"\nFatto: {len(fvg)} eventi FVG, {len(cf)} eventi CF, {len(kp)} valori Kp "
          f"({kp[0][0] if kp else '-'} → {kp[-1][0] if kp else '-'}). File in {OUT}")


if __name__ == "__main__":
    main()
