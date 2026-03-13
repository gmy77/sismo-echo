# 🌋 ECHO Monitor — Sismo FVG + Correlazione Solare

**Progetto ECHO** · *Earth Correlation Hypothesis Observatory*
Monitor sismico in tempo reale con correlazione solare — Cloudflare Worker + D1
Gimmy Pignolo © 2026 — [gimmycloud.com](https://gimmycloud.com)

🔗 **Live:** [https://sismo-fvg.gimmy077.workers.dev](https://sismo-fvg.gimmy077.workers.dev)

---

## 🎯 Scopo del Progetto

ECHO nasce per investigare la **correlazione osservazionale** tra attività solare (Kp index, vento solare) e sismicità terrestre, con focus su due aree ad alta attività:

- **FVG** — Friuli Venezia Giulia (area sismica attiva del Nord-Est Italia)
- **Campi Flegrei · Vesuvio · Ischia** — sistema vulcanico napoletano, tra i più monitorati al mondo

La tesi da verificare: *picchi di attività geomagnetica (Kp ≥ 4) precedono o coincidono con aumenti di sismicità locale con un delay di 0–72h.*

---

## ⚙️ Architettura

```
INGV FDSNWS API ──→ Cloudflare Worker ──→ D1: terremoti-fvg
NOAA Solar API  ──→       (cron 5x/gg) ──→ D1: terremoti-cf
                                        ──→ KV: ingv_status
                                        ──→ HTML Dashboard
```

| Componente | Tecnologia |
|---|---|
| Runtime | Cloudflare Workers (Edge) |
| Database FVG | Cloudflare D1 (`terremoti-fvg`) |
| Database CF | Cloudflare D1 (`terremoti-cf`) |
| KV Store | Cloudflare KV (status INGV, AI learning) |
| Dati sismici | INGV FDSNWS (`webservices.ingv.it`) |
| Dati solari | NOAA Space Weather (`services.swpc.noaa.gov`) |

---

## 📋 Changelog

### v3.0 — Progetto ECHO · Marzo 2026
> Separazione DB, Campi Flegrei dedicato, correlazione solare avanzata

**Novità principali:**
- ✅ **Database separato** `terremoti-cf` per Area Napoletana (Campi Flegrei · Vesuvio · Ischia)
- ✅ **`fetchINGVArea(area, giorni, minMag)`** — funzione generica multi-area (refactor di `fetchINGV`)
- ✅ **Soglia M≥0.0 per CF** — cattura ogni micro-sisma (vs M≥0.5 per FVG)
- ✅ **5 cron trigger/giorno** (03:00, 08:00, 13:00, 18:00, 23:00 UTC) — era 4x
- ✅ **Pannello CF dedicato** nella dashboard con:
  - Stats card (totale eventi, magnitudine massima, ultimi 30gg, hit rate)
  - Timeline correlazione Kp↔sismicità CF (grafico SVG a barre)
  - Sezione coincidenze Kp≥4 + attività CF
  - Tabella ultimi 20 eventi CF ≥ M0.0
- ✅ **Hit rate CF** — % giorni con Kp≥4 che hanno coincidenza sismica (ultimi 30gg)
- ✅ **`initCFDB()`** — inizializza automaticamente le tabelle nel DB CF al primo avvio
- ✅ **`getCFData(db_cf)`** — query ottimizzate dedicate all'area CF

### v2.1 — Febbraio 2026
- Banner INGV offline con status persistente su KV
- Gestione risposta 204 (No Content) da INGV
- Sistema AI learning via Cloudflare KV
- Obfuscation JS per logica AI e gioco Forza 4

### v2.0 — Gennaio 2026
- Refactor completo dashboard (layout a pannelli, dark theme)
- Timeline correlazione sismo-solare FVG (SVG)
- Sezione "Area Napoletana" iniziale (dati aggregati)
- Statistiche mensili, top 5 eventi, ultimo fetch log

### v1.0 — Dicembre 2025
- Prima release: monitor sismico FVG su Cloudflare Worker
- Integrazione INGV FDSNWS + NOAA Kp index
- Database D1 `terremoti-fvg`
- Dashboard HTML minimale

---

## 🗄️ Schema Database

### `terremoti-fvg` e `terremoti-cf` (identici)

```sql
CREATE TABLE terremoti (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    TEXT UNIQUE NOT NULL,       -- ID univoco INGV
  data_ora    TEXT NOT NULL,              -- ISO 8601 UTC
  magnitudine REAL,
  latitudine  REAL,
  longitudine REAL,
  profondita  REAL,                       -- km
  localita    TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);
```

### `dati_solari` (solo in `terremoti-fvg`)

```sql
CREATE TABLE dati_solari (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  time_tag TEXT UNIQUE NOT NULL,
  kp_index REAL
);
```

---

## 🌍 Aree Monitorate

| Area | Lat | Lon | Soglia | Note |
|---|---|---|---|---|
| FVG | 45.5–46.8 | 12.4–14.1 | M≥0.5 | Zona sismica attiva NE Italia |
| CF·Vesuvio·Ischia | 40.4–41.1 | 13.7–14.8 | **M≥0.0** | Sistema vulcanico napoletano |

---

## 🔄 Endpoint

| URL | Descrizione |
|---|---|
| `GET /` | Dashboard HTML completa |
| `GET /?updated=N` | Dashboard post-aggiornamento |
| `GET /update?token=SECRET` | Trigger manuale aggiornamento |
| `GET /update?token=SECRET&giorni=7` | Fetch ultimi N giorni |
| `GET /api/solar` | JSON dati solari raw |

---

## 🚀 Deploy

```bash
# Prerequisiti
npm install -g wrangler

# Clone e setup
git clone <repo>
cd sismo-worker

# Crea i database D1
wrangler d1 create terremoti-fvg
wrangler d1 create terremoti-cf

# Aggiorna i database_id in wrangler.toml

# Deploy
wrangler deploy

# Primo aggiornamento dati (ultimi 30 giorni)
curl "https://<worker>.workers.dev/update?token=SECRET&giorni=30"
```

---

## 📊 Metodologia ECHO

```
CORRELAZIONE OSSERVAZIONALE
  │
  ├── Input A: Kp index (NOAA, 1 min resolution, aggregato/giorno)
  ├── Input B: N eventi sismici CF/FVG per giorno (INGV)
  │
  ├── Metrica: Hit Rate = giorni(Kp≥4 AND N_sismi>0) / giorni(N_sismi>0)
  │
  ├── Delay analizzato: 0h (sincrono) — TODO: +24h, +48h, +72h
  │
  └── Significatività: aumenta con l'accumulo dei dati (dataset in crescita)
```

> ⚠️ **Nota metodologica**: correlazione ≠ causalità. Il dataset cresce ogni giorno.
> La significatività statistica aumenta con l'accumulo dei dati.

---

## 📁 Struttura

```
sismo-worker/
├── index.js          # Worker principale (dashboard + API + cron)
├── wrangler.toml     # Config Cloudflare (DB, KV, cron triggers)
├── package.json
└── README.md
```

---

*Progetto ECHO · Earth Correlation Hypothesis Observatory*
*"I dati parlano — noi ascoltiamo"*
