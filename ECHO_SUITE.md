# ECHO Suite — catalogo delle app

Indice di tutte le schede della griglia **ECHO Suite** su https://gimmycloud.net (worker `sismo-fvg`)
e delle app della famiglia ECHO che stanno fuori dalla griglia.
Ultimo controllo completo: **20/11/2026** (locale = GitHub = online per tutte le voci).

Per aggiungere una scheda: vedi i quattro punti in fondo.

## Schede dentro il worker sismo-fvg (stesso codice, stesso deploy)

Codice: `C:\Users\gimmy\repos\sismo-echo\sismo-worker\index.js` · repo `gmy77/sismo-echo` ·
ramo di lavoro `deploy/paid` (poi PR verso `main`) · versione **3.17** (`ECHO_VERSION`, riga 8).
Pubblicazione: `wrangler deploy` dentro `sismo-worker` (solo con l'ok di Gimmy).

| Scheda | Percorso | Dove nel codice | Note |
|---|---|---|---|
| Echo Radiazione | `/radiazione` | `index.js` (rotta `/radiazione`), `RADIAZIONE.md` | GOES protoni/elettroni, scala S1–S5 |
| Echo Chat | `/chat` | `index.js` | Workers AI, LLaMA 3.3 70B |
| Echo Code | `/code` | `index.js` | Workers AI, GLM 4.7 Flash |
| Echo Translate | `/traduttore` | `index.js` | m2m100 EN↔IT |
| Forza 4 | `/forza4` | `index.js`, `Forza4_react.jsx` | apprendimento su KV `F4_LEARN` |
| Othello | `/othello` | `index.js`, `othello_fn.js` | repo a parte: `Projects\Games\othello` → `gmy77/othello-ai` |
| METOP Polar | `/polar` | `metop-viewer.html` + `build-metop.mjs`, `METOP.md` | EUMETSAT Metop-B/C |

Nel dock ci sono anche Monitor, Campi Flegrei, Eventi FVG (pagine interne del worker).

## Schede che aprono un progetto esterno

| Scheda | Indirizzo | Cartella locale | Repo GitHub (ramo) | Hosting / deploy | Versione |
|---|---|---|---|---|---|
| SismoGlobe | https://sismo.gimmycloud.net | `repos\sismoglobe` | `gmy77/sismoglobe` (`main`) | GitHub Pages + Cloudflare | v1.10.0 (`main.js`) |
| Echo Terra Dinamica | https://sismo.gimmycloud.net/terra.html | `repos\sismoglobe` (`terra.html`) | `gmy77/sismoglobe` (`main`) | come SismoGlobe | — |
| Echo Constellation | https://echo-constellation.gimmy077.workers.dev | `repos\orbite` | `gmy77/ECHO-Constellation` (`main`) | Worker `echo-constellation` + KV, `deploy.bat`; exe `dist\ECHO Constellation.exe` | 1.0.0 |
| Echo SAA | https://saa-observatory.gimmy077.workers.dev | `repos\south-atlantic-anomaly-dashboard` | `gmy77/south-atlantic-anomaly-dashboard` (`main`) | Worker `saa-observatory` + D1 | — |
| AstroSandbox | https://astro.gimmycloud.net | `repos\Physics\SimulatoreSostanze` | `gmy77/astrosandbox` (`main`) | GitHub Pages (CNAME) | v1.1.0 |
| TechnoLab 95 | https://techno.gimmycloud.net | `repos\technolab` | `gmy77/technolab` (`main`) | GitHub Pages (CNAME) | — |

## Famiglia ECHO fuori dalla griglia

| App | Dove si apre | Cartella locale | Repo GitHub (ramo) | Versione |
|---|---|---|---|---|
| ECHO Tab (pagina iniziale Edge) | https://sismo-echo-tab.pages.dev | `repos\sismo-echo-tab` | `gmy77/sismo-echo-tab` (`main`), `deploy.bat` | 3.7.0 — un'etichetta per ogni scheda della griglia |
| ECHO Cosmic Ray (desktop Rust) | `dist\Radiazione Cosmica.exe` | `repos\cosmic-ray-dashboard` | `gmy77/ECHO-Cosmic-Ray` (`master`) | 0.3.0 |
| Fasce di Van Allen (desktop Rust) | `dist\vanallen.exe` + Worker https://van-allen-history.gimmy077.workers.dev | `repos\van-allen-dashboard` | `gmy77/van-allen-dashboard` (`main`) | 0.1.0 — scheda nella griglia non ancora fatta |

## Lavori aperti noti

- Scheda «Echo Van Allen» nella griglia: serve prima una pagina web servita dal Worker `van-allen-history`.
- `gmy77/sismo-echo` ha molti rami remoti vecchi (`claude/*`, `agent/*`, da marzo a ottobre 2026): da potare quando si vuole.
- `gmy77/sismoglobe` ha rami `feat/*` e `fix/*` di agosto–ottobre 2026 ancora aperti.

## Aggiungere una scheda (4 punti in `index.js`)

1. `<a class="app-card">` dentro `.suite-grid` (nome «Echo …», `--app`, `data-tt-title`, `data-tt-badge="NUOVO"`, `data-tt`, icona, descrizione, tag fonte, «APRI →»);
2. `<a class="dock-item">` nel `<nav id="dock">`;
3. scorciatoia `<a class="app">` nella pagina nuova scheda;
4. `ECHO_VERSION` +0.01 a mano;
5. aggiungere l'etichetta anche in ECHO Tab (`repos\sismo-echo-tab\index.html`, blocco `.links`, stesso ordine della griglia) e poi `deploy.bat`;
6. aggiornare questo file.
