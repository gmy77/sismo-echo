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

## Rotte del Worker

| Rotta | Cosa fa |
|---|---|
| `/polar` | la pagina del visualizzatore |
| `/metop?sat=&product=&bbox=&date=\|time=&w=&h=` | immagine WMS (proxy + cache) |
| `/metop/times?sat=&product=&date=` | istanti disponibili (dal GetCapabilities) |

## ⚠️ Da verificare: i nomi dei layer EUMETView

I nomi dei layer in `METOP_LAYERS` (dentro `index.js`) sono la **migliore
ipotesi** e vanno confermati: dall'ambiente di sviluppo EUMETSAT è irraggiungibile,
quindi non è stato possibile interrogare il catalogo. Se un canale dà errore:

- **Correzione permanente**: aggiorna il nome in `METOP_LAYERS` e ridistribuisci.
- **Prova al volo, senza redeploy**: passa il layer vero nella richiesta con
  `&layer=<workspace:nome>` — la UI e le rotte lo rispettano e scavalcano i
  predefiniti. Utile per trovare il nome giusto interrogando EUMETView dal
  browser, poi lo si fissa nel Worker.

Elenco dei layer EUMETView: <https://view.eumetsat.int/geoserver/wms?SERVICE=WMS&REQUEST=GetCapabilities>

## Licenza

**Copyright © 2026 Gimmy Pignolo. Tutti i diritti riservati.** Vedi
[LICENSE](../LICENSE) nella radice del repository.

I dati provengono da **EUMETSAT / EUMETView** e restano soggetti alle
[condizioni d'uso EUMETSAT](https://www.eumetsat.int/eumetsat-data-licensing);
il copyright qui sopra riguarda il codice del visualizzatore, non le immagini.

---

**METOP-Polar v1.0.0** — Costruito con **Claude Code** (Anthropic) · © 2026 **Gimmy Pignolo**
