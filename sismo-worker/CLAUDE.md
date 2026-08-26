# METOP · Polar Viewer — contesto per Claude Code

Visualizzatore web dei satelliti **polari EUMETSAT** + imager geostazionari, servito
dal Worker Cloudflare `sismo-worker/index.js`. **Zero build lato utente, zero
dipendenze**: HTML+JS puro. Versione attuale **1.1.2**. Autori: Claude Code
(Anthropic) · © 2026 Gimmy Pignolo.

Gemello web e minimale del C++ `MODIS-FVG-Viewer` (vedi
`Projects/coded/MODIS-FVG-Viewer/CLAUDE.md`): nato per evitare la fatica di
compilazione, si apre da un URL.

Branch di lavoro: `claude/modis-fvg-viewer-winui-2fnm3y`.

---

## Dov'è e come si apre

- Live: **https://sismo-fvg.gimmy077.workers.dev/polar** (anche `/metop/` con lo slash).
- La versione è scritta nel **pannello** (sottotitolo "EUMETView · vX.Y.Z") e nel
  titolo della scheda: **è il modo per sapere se il deploy è andato**.

## Come è fatto

**Sorgente unica**: `metop-viewer.html` è la pagina vera. `build-metop.mjs` la
inietta dentro `index.js` fra i marcatori `// >>>METOP_HTML` / `// <<<METOP_HTML`.
**Modifica sempre `metop-viewer.html`** e rilancia il build; non editare a mano la
copia in `index.js`. Vincolo: l'HTML non deve contenere backtick né `${` (romperebbero
il template literal) — il build lo verifica e si ferma.

**Il Worker gira su Cloudflare, che RAGGIUNGE EUMETSAT** (l'ambiente di sviluppo no:
`view.eumetsat.int` e `*.workers.dev` sono bloccati in uscita da qui). Quindi la
verifica finale la fa sempre l'utente dal browser; da qui si testa solo la logica
offline (es. `node -e` sul `catOf`).

Dati da **EUMETSAT EUMETView** (GeoServer WMS 1.3.0, pubblico, senza auth):
`https://view.eumetsat.int/geoserver/wms`. La Data Store autenticata NON è usata
(richiederebbe token + elaborazione nativa). **Se l'utente ripropone le chiavi
EUMETSAT: NON servono per EUMETView; per un'eventuale Data Store andrebbero in
`wrangler secret put`, MAI nel codice/git; se le incolla in chat, considerarle
compromesse e dirgli di rigenerarle.**

## Rotte del Worker (in `index.js`)

| Rotta | Cosa fa |
|---|---|
| `/polar`, `/metop-viewer`, `/metop/` | la pagina del visualizzatore |
| `/metop/layers[?q=]` | catalogo: layer reali (name+title+time), rumore filtrato, featured/polari in cima |
| `/metop/times?layer=&date=` | istanti TIME per un layer |
| `/metop?layer=\|product=&bbox=&date=\|time=&w=&h=&bg=1` | immagine WMS (proxy + cache); `bg=1` compone sotto `backgrounds:ne_gray` |

`/metop` senza `&time`/`&date` **non manda TIME** → GeoServer serve il suo default
(l'ultimo disponibile). `bbox` è lat,lon (ordine WMS 1.3.0, EPSG:4326).

---

## DEPLOY — procedura e trappola (importante)

Il repo dell'utente è clonato **direttamente in `C:\Users\gimmy`** (la home *è* il
repo). Deploya da `C:\Users\gimmy\sismo-worker`. Ma il suo locale ha **modifiche
divergenti** su `index.js`/`metop-viewer.html` e **file non tracciati** di altri
progetti (`Projects/coded/SismoGlobe/…`) che **bloccano `git checkout`/`git pull`**
del branch intero.

**Soluzione chirurgica** (non tocca gli altri progetti):
```powershell
cd C:\Users\gimmy
git fetch origin claude/modis-fvg-viewer-winui-2fnm3y
git checkout origin/claude/modis-fvg-viewer-winui-2fnm3y -- sismo-worker/index.js sismo-worker/metop-viewer.html
cd sismo-worker
npx wrangler deploy
```
Poi **Ctrl+F5**. `wrangler deploy` pubblica il file LOCALE: senza il `checkout` prima,
ridistribuisce sempre la versione vecchia (era la causa di "deployo ma non cambia").

**Verifica del deploy = numero di versione nel pannello.** Se non cambia, il
`checkout` non ha preso il codice nuovo. Per questo **ogni fix funzionale va
accompagnato da un bump di versione**, altrimenti l'utente non distingue i deploy.

---

## Trappole già pagate — non ricascarci

- **`/metop/times` cercava il nome CORTO del layer** (`<Name>rgb_natural</Name>`), ma
  EUMETView elenca il nome COMPLETO (`<Name>ws:rgb_natural</Name>`): la ricerca
  falliva sempre → "passaggi" vuoti → TIME ridotto a una data nuda → **502**.
- **Una data nuda come TIME dà 502** su layer che vogliono un istante. Fix: senza
  passaggio scelto non si manda TIME (default = ultimo).
- **`/metop/layers` è in cache 3h** (Cache-Control + edge). L'app aggiunge
  `?v=Date.now()` per bustarla; l'utente deve fare Ctrl+F5.
- **Il ranking premiava "natural/rgb" → MSG geostazionario in cima**, non i polari.
  Ora i workspace `eps:`/`copernicus:` vengono prima, `msg`/`mtg` in fondo.
- **OLCI è titolata solo "OLCI Level 1B RGB"** (senza "Natural/True Colour"): la
  classificazione per TITOLO la buttava fra gli "altri" e il filtro "Colori reali" la
  nascondeva. Fix definitivo: **`catOf(title, name)` guarda PRIMA il NOME del layer**
  (`olci…rgb`, `geocolour`, `rgb_natural` → reali; `rgb_124`/`_ir`/`_wv`/`_vis` →
  nubi; `sst`/`ascat`/`wind`/`orbit` → dati).
- **Prodotti a "striscia" = una singola orbita** di un satellite (`Sentinel-3A`,
  `Metop B`): coprono solo una fascia, il nero intorno NON è un dato mancante. Usare
  le versioni **Daily/Accumulated** (`daily_…`, `6 orbits`) per la mappa piena. C'è
  un avviso automatico nel `prodhint`.
- **"Natural Colour + Fog" su Mondo** mostra il lato notte in **magenta** (ricetta
  fog IR): normale, non un bug. Per la foto pulita usare aree illuminate o OLCI.
- **`/metop` nudo senza `&layer=`** ripiega su `METOP_LAYERS` (ora nomi VERI, non più
  i segnaposto inventati `metop:avhrr3_*`).

## Prodotti belli (per riferimento)

- **OLCI Level 1B RGB Daily Accumulated — Sentinel-3**:
  `copernicus:daily_sentinel3ab_olci_l1_rgb_fulres` (nota il typo "fulres" = nome
  vero). ~300 m, true colour, il più nitido. È il default in evidenza.
- OLCI singoli: `copernicus:sentinel3a_olci_l1_rgb_fullres` / `…3b…` (una striscia).
- **Geo Colour RGB — MTG-I**: `mtg_fd:rgb_geocolour` (giorno reale + luci di notte).
- **True Colour RGB — MTG-I** (disco intero diurno).
- **AVHRR Natural Colour + Fog** (i polari): `eps:m01_rgb_natural_fog` (Metop-B),
  `_m03_` (C), `_m02_` (A).
- **Natural Colour Enhanced — MSG**: `msg_fes:rgb_naturalenhncd`.

I nomi curati sono cablati in `CURATED` (client) e `FEATURED` (server) così restano
in cima anche se la scoperta/cache fa i capricci.

---

## TODO — prossime "gemme" (un po' al giorno)

Proposte all'utente, da confermare:
- 📸 **Scarica foto pulita**: un tasto che salva il PNG senza griglia/etichette.
- 🧠 **Memoria dell'ultima scelta** (prodotto/area) in `localStorage`, ripristinata
  all'apertura.
- ⭐ **Badge "in evidenza"** o `<optgroup>` sui prodotti top nel menu.
- (Idea) mosaico che tiene le immagini precedenti mentre si naviga, per riempire le
  strisce OLCI.

## Convenzioni

- Commenti e messaggi di commit **in italiano**.
- Ogni fix funzionale → **bump di versione** (pannello = prova del deploy).
- Nessun identificativo di modello negli artefatti del repo (solo in chat).
- Verifica la logica offline con `node -e` (EUMETSAT è irraggiungibile da qui);
  la prova finale la fa l'utente col deploy + screenshot.
