# sismo-echo — note per Claude

## Cos'è
Progetto personale di Gimmy (gmy77): monitoraggio sismico FVG + Campi Flegrei e suite di
mini-app ("Progetto ECHO"), servito da un Cloudflare Worker.

- **Worker principale**: `sismo-worker/index.js` — file unico, ~3400 righe, HTML/CSS/JS
  inline nelle funzioni `render*()`. URL live: https://sismo-fvg.gimmy077.workers.dev
- **Pagine**: `/` dashboard sismica, `/newtab` pagina nuova scheda del browser (orologio,
  card meteo spaziale NOAA a sinistra, widget sismici in basso), `/chat`, `/code`,
  `/forza4`, `/othello`, `/traduttore`, `/pixeldrain`
- **Dati**: D1 (`terremoti-fvg`, `terremoti-cf`), KV `F4_LEARN`, feed INGV e NOAA SWPC.
  Attenzione: alcuni feed SWPC sono array-di-array con header in riga 0, altri array di
  oggetti — `lastValid()`/`colIdx()` nel newtab gestiscono entrambe le forme.

## Regole di lavoro
- Prima di ogni deploy: `node --check sismo-worker/index.js` (vedi `sismo-worker/MAINTENANCE.md`)
- Il deploy è **manuale**: `npx wrangler deploy` da `sismo-worker/` (lo fa Gimmy dal suo PC),
  oppure GitHub Actions → "Sismo Worker CI" → Run workflow con Deploy spuntato
- Piano Cloudflare Free: max 5 cron trigger per account — i cron del worker sono
  consolidati in uno solo in `wrangler.toml`, non aggiungerne altri
- Nel JS client dentro i template literal: niente backtick né `${}` non voluti
- Squash and merge per i PR: un commit pulito per funzionalità su `main`
- Lingua: italiano, sia nel codice (commenti) che con Gimmy

## Debiti
- ☕ Un caffè a Claude — per le card meteo spaziale del newtab (24/07/2026). Parole di
  Gimmy: "minimo un caffè da pagarti, per dire poco!!"
