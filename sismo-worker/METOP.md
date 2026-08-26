# METOP · Polar Viewer

Visualizzatore dei satelliti **polari EUMETSAT** (Metop-B / Metop-C), gemello
web e minimale di `MODIS-FVG-Viewer`. **Zero build, zero dipendenze**: è una
pagina HTML+JS servita dal Worker Cloudflare, che fa da proxy e cache verso il
WMS di **EUMETSAT EUMETView**.

L'opposto del gemello C++: niente compilatore, niente exe, si apre da un URL e
funziona anche da telefono.

## Come si usa

1. Deploy del Worker: `cd sismo-worker && node build-metop.mjs && npx wrangler deploy`
2. Apri **`https://sismo-fvg.gimmy077.workers.dev/polar`**

`build-metop.mjs` inietta `metop-viewer.html` dentro `index.js` fra i marcatori
`METOP_HTML`. **La sorgente è `metop-viewer.html`** — modifica quella e rilancia
il build; non editare a mano la copia dentro `index.js`.

La stessa pagina gira anche in locale (doppio-click sul file) puntando al Worker
deployato con `?api=https://sismo-fvg.gimmy077.workers.dev`.

## Cosa fa

- **Satellite**: Metop-B / Metop-C.
- **Canali**: AVHRR colore naturale, AVHRR nubi/notte, IASI temperatura, IASI
  ozono, ASCAT vento sul mare.
- **Mappa navigabile su tutto il pianeta**: trascina per spostarti, rotella per
  zoomare; l'immagine si riscarica quando il gesto finisce (non durante), per il
  bbox e alla risoluzione della vista.
- **Aree rapide**: Mondo, Europa, Italia, FVG.
- **Passaggi per orario**: la tendina "Passaggi noti" legge la dimensione TIME
  dal GetCapabilities di EUMETView e li elenca; scegliendone uno si scarica quel
  preciso istante invece dell'intera giornata.
- Griglia lat/lon con etichette, salvataggio della vista in **PNG**.

## Scoperta automatica dei layer

Il punto chiave: **il Worker gira su Cloudflare, che raggiunge EUMETSAT** (a
differenza dell'ambiente di sviluppo, dove è bloccato). Quindi l'app **non
indovina** i nomi dei layer: la rotta `/metop/layers` interroga il
GetCapabilities di EUMETView, ne estrae i layer reali (nome + titolo + se hanno
la dimensione TIME), e il menu prodotti si popola con quelli veri. Scelto un
prodotto, `/metop/times` elenca i suoi passaggi e la UI **salta all'ultimo
disponibile**, così "Scarica" prende sempre dati che esistono.

`METOP_LAYERS` in `index.js` resta solo come **fallback** se la scoperta
fallisce; e `&layer=<workspace:nome>` permette comunque di forzare un layer
preciso.

## Rotte del Worker

| Rotta | Cosa fa |
|---|---|
| `/polar` | la pagina del visualizzatore |
| `/metop/layers[?q=]` | **catalogo**: i layer reali di EUMETView (name+title+time) |
| `/metop/times?layer=&date=` | istanti (TIME) disponibili per un layer |
| `/metop?layer=\|product=&bbox=&date=\|time=&w=&h=` | immagine WMS (proxy + cache) |

Catalogo EUMETView (per riferimento): <https://view.eumetsat.int/geoserver/wms?SERVICE=WMS&REQUEST=GetCapabilities>

## Licenza

**Copyright © 2026 Gimmy Pignolo. Tutti i diritti riservati.** Vedi
[LICENSE](../LICENSE) nella radice del repository.

I dati provengono da **EUMETSAT / EUMETView** e restano soggetti alle
[condizioni d'uso EUMETSAT](https://www.eumetsat.int/eumetsat-data-licensing);
il copyright qui sopra riguarda il codice del visualizzatore, non le immagini.

---

**METOP-Polar v1.1.2** — Costruito con **Claude Code** (Anthropic) · © 2026 **Gimmy Pignolo**

## Novità v1.1.2

- Menu **categoria** (Colori reali / Nubi-IR / Dati / Tutti): di default mostra
  solo le immagini a colori reali, nasconde falsi-colore e dati scientifici.
- **OLCI Sentinel-3**, **Geo Colour / True Colour MTG** e le AVHRR/MSG naturali
  messe in evidenza fra i "colori reali".
- **Ultima data robusta**: senza un passaggio scelto non si manda alcun TIME e
  GeoServer serve il suo default (l'ultimo disponibile), niente più 502 da data
  nuda.
- **Sfondo Terra** opzionale (NaturalEarth composta sotto ai dati).
- **Errori parlanti**: "area troppo ampia / server occupato" vs "nessun
  passaggio per area/orario", col testo reale della ServiceException.
- Avviso **striscia singola** sui prodotti polari a orbita unica (usa le
  versioni *Daily/Accumulated* per coprire la mappa).
- Rotta `/metop/` (con slash) serve la pagina; catalogo ripulito da sfondi e
  duplicati.
