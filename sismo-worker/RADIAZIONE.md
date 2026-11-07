# Rilevatore di radiazione spaziale e storico

Il worker `sismo-fvg` raccoglie la radiazione spaziale dai satelliti NOAA e la conserva in D1.
La usano la pagina `/radiazione` del worker e SismoGlobe (riquadro, scheda laterale e pagina
[`radiazione.html`](https://sismo.gimmycloud.net/radiazione.html), repo `gmy77/sismoglobe`, dalla v1.10.0).

## Cosa misura

| Grandezza | Fonte | Unità | Soglie utili |
|---|---|---|---|
| Protoni ≥10 MeV / ≥100 MeV | NOAA GOES | pfu | 10 pfu = S1 (tempesta radiativa) |
| Elettroni ≥2 MeV | NOAA GOES | pfu | ≥1000 = allerta satelliti |
| Flusso raggi X 0.1–0.8 nm | NOAA GOES | W/m² | 1e-6 C · 1e-5 M · 1e-4 X |
| Vento solare (velocità, densità) | NOAA DSCOVR | km/s, p/cm³ | ≥600 km/s = veloce |
| Kp attuale, scala S | NOAA SWPC | — | Kp≥5 tempesta geomagnetica |

## Tabelle D1 (`terremoti-fvg`)

```sql
-- campioni a 5 minuti, scritti dal cron (fetchRadiazione/salvaRadiazione)
radiazione_spaziale (id, time_tag UNIQUE, proton_10mev, proton_100mev, electron_2mev, s_scale,
                     flare_class, wind_speed, xray_flux, wind_density, kp_now)

-- attività solare giornaliera GFZ Potsdam (Kp_ap_Ap_SN_F107), dal 1932
attivita_solare (giorno PRIMARY KEY, ap, sn, f107_obs, f107_adj, definitivo)
```

- `radiazione_spaziale` contiene dati **dal 2026-09-21**, con un buco dall'11/10 al 7/11/2026
  (worker bloccato, vedi l'incidente in [MAINTENANCE.md](MAINTENANCE.md)).
- `attivita_solare`: 34.644 giorni dal 1932-01-01. Ap è l'indice giornaliero di disturbo
  geomagnetico (≥30 tempesta, ≥100 estrema), `sn` il numero di macchie solari (SILSO),
  `f107_obs` il flusso radio a 10,7 cm (dal 1947). `definitivo`: 0 preliminare, 1 Kp definitivo, 2 tutto definitivo.

## Endpoint

### `GET /api/radiation`
Ultimi 300 campioni (circa 1 giorno) in ordine crescente, più:
- `context`: ultimo valore non nullo di Kp, vento, raggi X, classe del brillamento, scala S;
- `derived`: min/max 24 ore, tendenza protoni, giorni consecutivi in S0.

Cache 120 s. CORS aperto.

### `GET /api/radiation/history`
```jsonc
{
  "since": "2026-09-21",
  "days": [ { "giorno", "s_max", "p10_max", "p10_avg", "p100_max", "e2_max",
              "xray_max", "flare_max", "wind_max", "kp_max", "campioni" } ],
  "sun": {
    "monthly": [ { "mese", "sn", "f107", "ap", "ap_max" } ],   // dal 1932
    "daily":   [ { "giorno", "sn", "f107", "ap" } ],           // ultimi 730 giorni
    "top":     [ { "giorno", "ap", "sn" } ],                   // 12 tempeste con Ap più alto
    "yearly":  [ { "anno", "sn", "f107", "tempeste", "estreme", "ap_max" } ]
  }
}
```
Cache 1 ora. CORS aperto.

## Aggiornamento

- **Cron** (8, 13, 18, 23 UTC): radiazione NOAA, poi `aggiornaAttivitaSolare()` legge il
  nowcast GFZ (`Kp_ap_Ap_SN_F107_nowcast.txt`, ultimi ~30 giorni) con `INSERT OR REPLACE`,
  perché i valori preliminari vengono corretti nei giorni successivi.
- **A mano**: `GET /update?token=<UPDATE_SECRET>` (risponde 302) lancia lo stesso aggiornamento.
- **Storico completo** da rifare (solo se serve, è idempotente):
  ```bash
  cd sismo-worker
  python scripts/import-storico.py --solo-sole
  npx wrangler d1 execute terremoti-fvg --remote --file scripts/out/sole.sql
  ```
  Senza `--solo-sole` lo script rigenera anche terremoti FVG/CF dal 1985 e Kp a 3 ore dal 1932
  (vedi l'intestazione dello script).

## Fonti scartate (per non riperdere tempo)

- Archivi NOAA SWPC giornalieri `old_indices/YYYY_DPD.txt` (particelle) e `YYYY_DSD.txt`
  (brillamenti): non più raggiungibili (404 su services.swpc, ftp.swpc non risponde).
- Archivio scientifico GOES su NCEI (`data.ngdc.noaa.gov/.../goes16/l2/data`): solo file netCDF
  a 1–5 minuti, uno per giorno, troppo pesante per un sito; i medi giornalieri `sgps-l2-avg1d` non esistono.

## Risultati già visibili nei dati

- Tempeste record dal 1932 per Ap: 13/11/1960 (280), 11/05/2024 (271, "tempesta di Gannon",
  aurora vista in Italia), 13/03/1989 (246, blackout del Québec).
- Il ciclo solare 25 ha avuto il picco a ottobre 2024 (circa 161 macchie, media 13 mesi),
  più forte del ciclo 24 (circa 116).
