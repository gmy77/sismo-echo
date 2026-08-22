# Indicizzazione — cosa è già fatto e cosa devi fare tu

Stato al 2026-07-31. I passaggi qui descritti non dipendono dalla versione dell'applicazione:
per quella fa fede il numero mostrato in basso a destra nel sito.

## Già fatto nel sito (nessuna azione richiesta)

| Elemento | Dove | A cosa serve |
|---|---|---|
| ~690 parole di testo reale nell'HTML | pannello "guida" in `index.html` | È l'unica cosa che i crawler delle IA possono leggere: non eseguono JavaScript |
| `<meta name="description">` | `index.html` | Il testo che Google mostra sotto il titolo nei risultati |
| `<link rel="canonical">` | `index.html` | Evita che lo stesso contenuto risulti duplicato su più URL |
| Open Graph + Twitter Card | `index.html` | Anteprima con immagine quando condividi il link su WhatsApp, Telegram, X, LinkedIn |
| `og-image.png` (1200×630) | radice del sito | L'immagine di quell'anteprima |
| JSON-LD `WebApplication` + `Dataset` + `FAQPage` | `index.html` | Dice ai motori *cosa sei* senza che debbano dedurlo |
| `robots.txt` | radice | Ammette esplicitamente GPTBot, ClaudeBot, PerplexityBot e gli altri crawler IA |
| `sitemap.xml` | radice | Elenco delle pagine, richiamato dal robots.txt |
| `llms.txt` | radice | Convenzione proposta per le IA — nessun crawler importante la rispetta ancora, costa poco e non fa danno |

## Da fare tu (servono i tuoi accessi)

### 1. Google Search Console — 10 minuti, l'azione con più impatto

1. Vai su <https://search.google.com/search-console> e accedi con gimmy077@gmail.com.
2. "Aggiungi proprietà" → scegli **Prefisso URL** (non Dominio) e inserisci `https://sismo.gimmycloud.net/`.
3. Come verifica scegli **Tag HTML**: ti dà una riga `<meta name="google-site-verification" content="...">`.
   Passamela e la aggiungo io a `index.html`, oppure incollala tu subito dopo `<meta name="theme-color">`.
   *(In alternativa la verifica via DNS TXT su Cloudflare funziona ugualmente e vale per tutti i sottodomini.)*
4. Verificata la proprietà: menu **Sitemap** → inserisci `sitemap.xml` → Invia.
5. Menu **Controllo URL** → incolla `https://sismo.gimmycloud.net/` → **Richiedi indicizzazione**.

Il punto 5 è la cosa più simile a "forzare" l'indicizzazione che esista, ed è ufficiale.
Dopo qualche giorno, in **Risultati di ricerca** vedrai con quali parole ti trovano.

### 2. Bing Webmaster Tools — 5 minuti, conta più di quanto sembri

Serve perché **ChatGPT si appoggia a Bing** per le ricerche web: essere indicizzato bene su Bing
significa comparire nelle risposte di ChatGPT.

1. Vai su <https://www.bing.com/webmasters> e accedi.
2. C'è l'opzione **"Importa da Google Search Console"**: se hai fatto il punto 1, importa tutto
   in un click, verifica compresa.
3. Invia la sitemap e usa **"Invia URL"** per l'indicizzazione immediata.

### 3. IndexNow su Cloudflare — 2 minuti

Notifica a Bing e Yandex ogni modifica senza aspettare il passaggio del crawler.

1. Pannello Cloudflare → dominio **gimmycloud.net** → sezione **Caching** → **Configuration**.
2. Attiva **Crawler Hints** (è l'implementazione di IndexNow, gratuita).

Vale per tutta la zona, quindi copre anche astro, techno e gli altri sottodomini.

### 4. Link da fuori — è la leva vera per il posizionamento

Nessuna ottimizzazione tecnica sostituisce l'essere citati altrove. Hai già i due link buoni
(dashboard gimmycloud.net e repo GitHub). Idee a basso sforzo e alta resa:

- Aggiungi `topics` al repo GitHub: `earthquake`, `seismology`, `globe`, `dataviz`, `usgs`, `threejs`.
  I repo vengono indicizzati per topic ed è traffico gratuito.
- Proponi il progetto a liste "awesome" pertinenti (es. *awesome-webgl*, *awesome-dataviz*):
  si fa con una pull request.
- Un post dove uno strumento così è genuinamente utile (community di geoscienze, dataviz,
  three.js). Un contributo fatto bene vale più di cento directory automatiche.

## Cosa NON fare mai

Keyword nascoste o testo bianco su bianco, acquisto di backlink, iscrizione massiva a directory,
pagine-civetta, contenuti generati in serie senza valore. Erano trucchi vent'anni fa: oggi sono
segnali di spam che portano a declassamento o rimozione dall'indice.

## Aspettative realistiche

Per ricerche generiche come "terremoti tempo reale" competi con INGV, USGS ed EMSC: lì non arriverai
in cima, ed è normale. Il terreno buono è la nicchia — "globo 3D terremoti", "mappa sismica
interattiva", "energia sismica rilasciata" — dove il contenuto specifico che ora hai nella guida
può davvero emergere. Le IA in particolare sono brave a pescare risposte di nicchia da fonti piccole
ma precise.

Tempi: la prima indicizzazione dopo la richiesta manuale richiede in genere da qualche ora a qualche
giorno. Comparire nelle risposte delle IA è più lento e meno prevedibile, perché dipende da quando
ripassano i crawler.
