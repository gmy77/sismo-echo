# SISMO ECHO — note di progetto

Claude Code legge questo file in automatico, sia dalla CLI sul PC di Gimmy sia
nelle sessioni cloud: è la memoria condivisa fra le sessioni. Va aggiornato
quando si chiude qualcosa di importante o si scopre qualcosa da ricordare.

## Dove sta il repo sul PC di Gimmy

- Repo git: `C:\Users\gimmy\repos\sismo-echo`. Qui si fa `git pull origin main`,
  dopo aver controllato che `git branch --show-current` dica `main` e che
  `git status` sia pulito.
- Deploy: `C:\Users\gimmy\repos\sismo-echo\sismo-worker`. Qui si lancia
  `wrangler deploy`, perché è qui che c'è `wrangler.toml`.
- Regola: i progetti stanno SOLO dentro `C:\Users\gimmy\repos`. Sismo-echo è
  stato spostato qui da `C:\Users\gimmy`, dove c'era confusione.
- Non usare le worktree di Claude Code sotto `.claude\worktrees\` (per esempio
  `tender-curran`): contenevano solo `index.js` e `wrangler.toml`, senza i
  sorgenti (`metop-viewer.html`, `build-metop.mjs`).
- Lezione del 2026-09-24: se `git pull` dice "MERGE_HEAD exists", prima
  `git merge --abort` e SOLO DOPO `git stash` delle modifiche locali. Fatto
  al contrario, lo stash si porta dietro anche i file del merge a metà e il
  `stash pop` va in conflitto.

## Come Claude controlla la produzione da solo (dalle sessioni cloud)

Dal cloud il Worker non è raggiungibile via HTTP (rete in uscita bloccata:
`EGRESS_BLOCKED` su `*.workers.dev`, `view.eumetsat.int`, docs Cloudflare).
I canali che funzionano:

1. **D1 (lettura e scrittura), tool `Cloudflare_Developer_Platform`.**
   Database `terremoti-fvg`, id `6504ff40-54b2-4a79-8860-99c9279da534`.
   Tabella `diagnostica` (ts, origine, evento, dettaglio JSON), scritta dal
   Worker e pulita a 14 giorni dal cron. Query utili:
   - `SELECT * FROM diagnostica ORDER BY id DESC LIMIT 30`
   - `SELECT evento, COUNT(*) FROM diagnostica WHERE origine='lightning' AND ts > datetime('now','-1 day') GROUP BY evento`
   - `SELECT * FROM diagnostica WHERE origine='cron' ORDER BY id DESC LIMIT 8`
     (il cron gira? 4 volte al giorno). NON usare `fetch_log` per questo: viene
     scritto solo quando INGV restituisce sismi nella finestra di 2 giorni,
     quindi resta fermo per giorni anche col cron sano (verificato il
     2026-09-24: ultima riga del giorno prima, radiazione aggiornata quel
     mattino).
   Eventi: `lightning/connect|heartbeat(5 min)|disconnect|error|payload_keys`,
   `metop/upstream_timeout|upstream_error|legend_timeout`, `cron/run|error`.
   `lightning/payload_keys` si scrive una volta per connessione MQTT, al primo
   fulmine: chiavi del payload vero, se c'è la lista stazioni `sig` e un
   esempio. È la prova di cosa manda DAVVERO il broker.
2. **Sonda HTTP via GitHub Actions**: workflow `worker-probe.yml`. Interroga
   `/lightning/status`, `/metop/layers?q=li`, `/api/stats`, `/polar` e, per
   StormShift, `/status` e `/api/radar/latest` (con l'età dell'ultimo frame
   radar). Gira
   da sola ogni 6 ore (00:17, 06:17, 12:17, 18:17 UTC): Claude NON può
   lanciarla, l'integrazione GitHub del cloud risponde 403 "Resource not
   accessible by integration" a `run_workflow` (verificato il 2026-09-24).
   Si leggono i log dell'ultima esecuzione: `actions_list list_workflow_runs`
   con `resource_id=worker-probe.yml`, poi `list_workflow_jobs` e
   `get_job_logs` col `job_id`. Gimmy può lanciarla a mano da Actions, anche
   con un percorso extra (input `path`).
3. **`/lightning/status`** (pubblico) espone: `version`, `connected`,
   `connectedSince`, `clients`, `strikeCount`, `lastStrikes` (ultime 20),
   `reconnects`, `lastError`, `subscription.tiles` (le tessere geohash
   sottoscritte DAVVERO, non quelle nel commit).
4. **Deploy da Actions**: `sismo-worker-ci.yml` ha il job "Deploy worker"
   (`workflow_dispatch` con `deploy=true`), già usato con successo il
   2026-07-30, quindi i segreti Cloudflare ci sono. Claude lo usa SOLO con
   l'ok esplicito di Gimmy per quel deploy: di norma il deploy lo fa Gimmy
   dal PC.

## Tassonomia diagnostica (categorie + gravità, valida per ogni progetto)

Decisa con Gimmy il 2026-09-25, per smettere di far scoprire alla sentinella
da zero cosa conta ogni volta: il codice stesso dichiara la gravità quando
scrive in `diagnostica` (colonna `gravita`, aggiunta con `addColIfMissing`
dentro `logDiag` — vedi `sismo-worker/index.js`).

**Categorie** (dimensioni, non colonne separate — si riconoscono dal campo
`origine`): Disponibilità (il servizio/cron/deploy gira?), Dati (freschi,
completi, plausibili?), Sicurezza (segreti, accessi anomali, dipendenze
vulnerabili), Prestazioni/risorse (tempi in crescita, vicino ai limiti del
piano gratuito), Igiene (branch vecchi, workflow rotti, dipendenze deprecate).

**Gravità** (colonna `gravita`, stessa scala per ogni categoria):
- `bloccante` — il servizio non fa quello per cui esiste. Nel rapporto della
  sentinella sempre, notifica push sempre. Esempio in questo repo: `cron/error`
  (quel giro non ha scaricato/salvato niente).
- `da_guardare` — non blocca oggi, ma è da tenere d'occhio (si auto-cura da
  sola, o è vicino a una soglia). Nel rapporto, senza notifica isolata.
  Esempi: `lightning/error` (si riprova da sola col backoff),
  `metop/upstream_timeout|upstream_error|legend_timeout` (di solito è
  EUMETView lento, non un guasto nostro — diventa serio solo se un layer
  fallisce SEMPRE, pattern che la sentinella vede contando le righe, non una
  regola scritta nel codice).
- `NULL` (default, non passare il parametro) — informativo, rumore di fondo
  normale (`lightning/connect|heartbeat|disconnect`, `cron/run` senza errori).
  Solo storico, non entra nel rapporto a meno che richiesto esplicitamente.

**Limite onesto sulla frequenza**: il controllo a orario (sentinella 2 volte
a settimana) ha un ritardo fisico — una cosa `bloccante` può restare
invisibile fino a 3-4 giorni. Per un progetto hobby è un compromesso
accettato; se in futuro si vuole vedere prima Disponibilità/Sicurezza, la
strada è un controllo più frequente solo per quelle categorie, non ancora
implementato — deciderlo con Gimmy prima di farlo, non a occhio.

**Centralizzazione a due corsie, decisa il 2026-09-25** (risolve il buco che
prima era aperto): un unico tubo uguale per tutti avrebbe due difetti — un
produttore che si comporta male inonda la tabella condivisa e nasconde i
segnali degli altri, e un produttore poco fidato (rete, non lo stesso
account) potrebbe scrivere qualunque cosa. La fiducia del produttore decide
quale corsia usa, non il tipo di progetto:

1. **Worker Cloudflare** (stormshift, newtab-worker, futuri): binding D1
   diretto sullo stesso database nel proprio `wrangler.toml`, stessa
   `logDiag`-style locale (nessuna rete di mezzo, nessuna autenticazione:
   stesso account, stessa fiducia di `sismo-fvg`). Ancora da fare per i
   Worker esistenti — non è automatico, va aggiunto binding + chiamata in
   ognuno.
2. **Tutto il resto** (SatView_preview su Python/PC, o qualunque produttore
   non-Worker): `POST /diag/ingest` su `sismo-fvg`, già implementato e
   testato (verificare estraendo le funzioni dal file reale, come per
   `geohashTilesForBounds`):
   - `?token=<UPDATE_SECRET>` (stesso segreto delle altre rotte protette,
     stessa rotazione secondo `MAINTENANCE.md`);
   - corpo `{origine, evento, dettaglio, gravita}` — stessa forma di
     `logDiag`, `dettaglio` troncato a 4000 caratteri se troppo grande,
     `gravita` fuori da `bloccante`/`da_guardare` scartata a `NULL`;
   - **limite di velocità: 20 scritture/minuto per `origine`**, via KV
     `F4_LEARN` (bucket per minuto, scadenza 120s — non lascia residui). Un
     produttore che sbanda intasa solo la propria fetta, non quella degli
     altri (verificato: un'origine satura il suo limite, un'altra scrive
     comunque nello stesso minuto). Funziona anche senza `F4_LEARN` bindato
     (il limite è un extra, non una dipendenza: senza KV semplicemente non
     limita).
   - **lato PC (da fare, non ancora iniziato)**: SatView_preview deve
     scrivere PRIMA in un log locale (JSONL o simile, sincrono, mai vuoto
     anche offline), POI tentare l'invio a `/diag/ingest` con un timeout
     corto e senza bloccare la pipeline se fallisce — così una rete/Worker
     giù per un po' non perde l'evento, lo si rispedisce al giro dopo. Il
     log locale resta la fonte di verità per quel progetto; D1 è comodità
     centralizzata, non l'unica copia.

## Pattern globale di diagnostica (da replicare negli altri progetti)

Deciso con Gimmy il 2026-09-24: ogni progetto deve avere un posto dove Claude
capisce da solo come sta girando, senza chiedere a Gimmy di guardare. Questo
repo è il primo; il pattern va copiato negli altri un po' alla volta (sezione
da riportare nel `CLAUDE.md` di ciascun progetto, perché non esiste una memoria
unica condivisa fra CLI e cloud per tutti i repo).

Ricetta, in 4 pezzi:
1. **Una tabella `diagnostica`** (`ts`, `origine`, `evento`, `dettaglio` JSON)
   in un posto che Claude legge da fuori (qui D1; per un progetto Python sul
   PC può essere un SQLite/JSONL spedito a un endpoint del Worker, da vedere).
2. **Un helper `logDiag(...)`** che non lancia mai eccezioni, no-op se manca il
   database, e che scrive SOLO eventi di ciclo di vita, errori e un heartbeat
   periodico: mai una riga per singolo dato (scarica, pixel, richiesta ok).
3. **Ritenzione** automatica (qui 14 giorni, nel cron) e **uno status endpoint
   pubblico** che dice cosa è configurato DAVVERO (es. le tessere sottoscritte),
   non cosa c'è nel commit.
4. **Una sonda** che gira da sola a orario e i cui log Claude può leggere (qui
   il workflow `worker-probe.yml`), per vedere le risposte HTTP vere quando la
   rete del cloud non arriva al servizio. A orario e non a comando, perché dal
   cloud Claude non ha il permesso di lanciare workflow.

### Controllo periodico (la "sentinella")

Una sessione Claude dedicata viene svegliata da una Routine due volte a
settimana e segue questa checklist, in sola lettura. Non modifica codice, non
fa merge, non fa deploy: riferisce. Se tutto è a posto lo dice in una riga;
se qualcosa non va, dice cosa, da quando e con quale prova (la query o il log).

La Routine si chiama "Sentinella progetti Gimmy" (`trig_01Nj3uc9vkcPX3Tqh6uuFRRw`)
e gira lunedì e giovedì alle 07 UTC. Dopo il primo lancio di prova del
2026-09-24 era rimasta **spenta** (`enabled:false`) senza che nessuno se ne
accorgesse. L'ho trovata così il 2026-09-25 e l'ho riaccesa con il prompt
aggiornato alla colonna `gravita`. Una sessione che vuole fidarsi della
sentinella deve prima controllare con `get_trigger` che sia davvero
`enabled:true`, e che `last_run` non sia più vecchio di 4 giorni.

1. **Cron del Worker**: `SELECT * FROM diagnostica WHERE origine='cron'
   ORDER BY id DESC LIMIT 8`. Atteso: 4 esecuzioni al giorno (08, 13, 18, 23
   UTC). Allarmi: buchi di oltre 6 ore, `evento='error'`, `ingvOk:false`
   ripetuto, `kp:0` ripetuto (NOAA giù).
2. **Dati freschi**: `SELECT MAX(data_ora) FROM terremoti`,
   `SELECT MAX(time_tag) FROM dati_solari`,
   `SELECT MAX(time_tag) FROM radiazione_spaziale`. Allarme se il Kp è più
   vecchio di 18 ore o la radiazione di 15: il cron ha buchi fino a 9 ore
   (23→08 UTC) e il Kp esce a blocchi di 3 ore, quindi soglie più strette
   danno falsi allarmi. I sismi possono mancare per giorni senza che sia un
   guasto.
3. **Relay fulmini**: righe `origine='lightning'` degli ultimi giorni. Allarmi:
   `error` ripetuti, `CONNACK rifiutato`, reconnect molto frequenti. Nessuna
   riga è normale se nessuno ha aperto il viewer con la spunta.
4. **Proxy METOP**: conteggio `upstream_timeout`/`upstream_error` per layer.
   Allarme se un layer fallisce sempre (magari è stato rinominato su
   EUMETView).
5. **Sonda HTTP**: leggere i log dell'ultima esecuzione di `worker-probe.yml`
   (gira da sola ogni 6 ore). Allarmi: risposte diverse da 200,
   `/lightning/status` senza `subscription`, ultima esecuzione più vecchia di
   12 ore (lo schedule di GitHub si è fermato). La soglia era 8 ore, ma il
   2026-09-25 GitHub faceva partire i giri con 3–5,5 ore di ritardo (quello
   delle 06:17 è partito alle 11:54), con intervalli reali già di 7–7,5 ore:
   con 8 ore sarebbero arrivati falsi allarmi.
6. **GitHub Actions**: ultimi run di ogni workflow su `main`. Allarmi: rossi
   nuovi. Quelli sospesi di proposito sono elencati sotto.
7. **Deploy allineato**: `workers_list` su Cloudflare, confrontare il
   `modified_on` di `sismo-fvg` con la data dell'ultimo merge su `main` che
   tocca `sismo-worker/`. Se `main` è più nuovo da giorni: deploy dimenticato.
8. **Pulizia**: la tabella `diagnostica` non deve avere righe più vecchie di
   14 giorni (altrimenti la pulizia del cron non gira).

9. **StormShift** (solo quando è segnato `[x]` nella lista Adozione qui
   sotto):
   - su D1, righe `origine='stormshift'` dall'ultimo giro. Allarmi:
     - `container_stop` con `gravita='da_guardare'` (uscita diversa da 0:
       crash o memoria finita);
     - `container_error` ripetuti;
     - `api_5xx`: ogni riga riassume fino a 10 minuti di errori, con il
       conteggio.
   - nei log di `worker-probe.yml`, step "StormShift":
     - `/status` deve avere `secrets` entrambi `true` e `d1: true`;
     - la riga `radar: ultimo frame …` deve avere un'età sotto i 60 minuti.
       La soglia è provvisoria: va rivista dopo le prime settimane di sonde.

   Nessuna riga `container_start` per giorni non è un guasto: il container
   parte solo quando qualcuno apre la dashboard (o la sonda chiama
   `/api/radar/latest`).

Perimetro, deciso con Gimmy il 2026-09-25: la sentinella copre **solo le app
meteo online**. Inventario dei Worker Cloudflare, fatto lo stesso giorno
leggendo il codice in produzione con `workers_get_worker_code`:
- è meteo solo `stormshift`, oltre a `sismo-fvg`;
- non sono meteo: `newtab-worker` (pagina "nuova scheda"), `luce-circadiana-01`
  (lampada), `game-monitor`, `cloudflare-mcp-worker` e `throbbing-queen-1b6f`
  (demo di Workers AI del 2025).

Esclusi per scelta di Gimmy anche SatView_preview (gira solo sul PC) e
FVG-GribMonitor.

Adozione:
- [x] sismo-echo / Worker `sismo-fvg` (relay fulmini, proxy METOP, cron)
- [ ] StormShift: repo privato `gmy77/Storm_Shift`, Worker `stormshift` +
  Container con il bridge radar METEOHUB.
  - La diagnostica e `/status` sono nel codice (PR #1 di Storm_Shift, mergiata
    il 2026-09-25); la sonda interroga già StormShift.
  - Diventa `[x]` dopo il primo deploy dal repo Storm_Shift, verificato con
    una riga `stormshift/container_start` su D1 e con `/status` che risponde
    `version: "cf-1"`.
  - Il deploy lo fa Gimmy dal PC con Docker acceso: vedi il `CLAUDE.md` di
    Storm_Shift.

## Fulmini live: stato attuale

- `LightningRelay` (Durable Object in `sismo-worker/index.js`): relay MQTT
  (broker comunitario `blitzortung.ha.sed.pl:1883`) → WebSocket per il viewer.
- Copertura: `NORTH_ITALY_BOUNDS` (44.2–46.9°N, 7.3–14.0°E), 15 tessere
  geohash di precisione 3 (PR #18). Verificato in produzione il 2026-09-24
  alle 11:59 UTC dopo il deploy: `connected:true`, `clients:1`, nessun errore.
- Non si è ancora visto arrivare un fulmine reale: durante i test non c'erano
  temporali in zona (controllato su lightningmaps.org).
- Versione 3.12 verificata in produzione il 2026-09-25:
  - il deploy delle 13:16 UTC era identico a `main`: codice scaricato con
    `workers_get_worker_code` e `METOP_HTML` valutato e confrontato byte per
    byte;
  - alle 13:19 UTC D1 ha registrato `lightning/connect` con 15 tessere;
  - `/lightning/status` riporta `coverage` aperta e nessun errore.

  Con zero fulmini `fieldsSeen` resta `{}`: la domanda su `sig` è ancora
  aperta.

### Mappa fulmini "tipo lightningmaps" (viewer 1.5.x, `ECHO_VERSION` 3.12+)

- **Storico di 1 ora nella memoria del Durable Object** (`LIGHTNING_BUFFER_MS`,
  massimo 6000 scariche). Esiste solo finché il DO è vivo e qualcuno guarda:
  il relay si apre solo con un viewer connesso, e un riavvio del DO azzera
  tutto. Non è su D1 e non deve andarci: sarebbe una riga per dato, proprio
  ciò che la regola di `logDiag` vieta.
- **Protocollo WebSocket**. Dal server arrivano:
  - `hello`: versione, stato, `coverage` (gli intervalli in cui il relay era
    davvero collegato), `fieldsSeen`, `sigSeen`, `latency`;
  - `backfill`: lo storico a blocchi da 1000 righe in forma colonnare
    (`cols` + `strikes`), SENZA lista stazioni per stare leggero;
  - `strike`: la scarica live, con `sig`;
  - `detail`: la lista stazioni di una scarica vecchia, se è ancora fra le
    ultime 400 che la conservano (altrimenti `missing:true`);
  - `state`: cambi di connessione.

  Il client può mandare solo `{type:"detail", id}`.
- **Viewer**:
  - bottone "Modalità fulmini", oppure `?fulmini` nell'URL;
  - colori per età, finestra regolabile, celle temporalesche con direzione di
    moto, allerta di vicinanza;
  - pannello di dettaglio con la tabella delle stazioni, suono opzionale;
  - PNG che include i fulmini.

  Il punto di riferimento predefinito è **Udine città, NON la casa di
  Gimmy** (il viewer è pubblico). Un punto personale si imposta con un clic o
  col GPS e resta solo nel `localStorage` del browser.
- **Cosa NON c'è nel feed pubblico**:
  - la corrente di picco (kA): Blitzortung non la pubblica;
  - la lista stazioni `sig`: se passi per il proxy MQTT NON è verificato. Il
    container cloud non raggiunge la porta 1883, quindi lo si vede solo in
    produzione con `lightning/payload_keys` su D1, o con
    `sigSeen`/`fieldsSeen` su `/lightning/status`. Se `sigSeen` resta a 0
    con fulmini arrivati, il proxy la toglie e il pannello stazioni resterà
    vuoto: non è un bug del viewer.
- **I fulmini possono cadere fuori dal rettangolo tratteggiato**: le tessere
  geohash (precisione 3, circa 156×156 km) sono più grandi del rettangolo, e
  il broker manda tutto quello che cade nella tessera.
- **`/lightning/status`**, oltre ai campi di prima, ora dà: `fieldsSeen`,
  `sigSeen`, `latency` (p50/p90 in ms fra scarica e arrivo), `bufferSize`,
  `coverage`, `doStartedAt`, `lastStrikeAt`.
- Il layout del viewer non è pensato per il telefono: era così anche prima,
  va affrontato a parte.

### Lezione del 2026-09-25: il build rompeva le regex del viewer

`build-metop.mjs` incollava l'HTML dentro un template literal senza raddoppiare
i backslash. Così ogni regex del viewer arrivava rotta in produzione: `\b`
diventava un backspace e `\s` una semplice `s`. Filtri satellite, descrizioni
dei prodotti e riconoscimento delle categorie non funzionavano, senza dare
errori. Ora il build raddoppia i backslash e usa un replacer a funzione
(`$&`/`$1` nell'HTML non vengono più interpretati). Come verificarlo:
**valutare la costante `METOP_HTML` di `index.js` e confrontarla byte per byte
con `metop-viewer.html`**. Non basta cercare la stringa col grep, perché il
file sorgente e il letterale hanno escape diversi.

## Da fare

### Courtesy notice Blitzortung
- [ ] Aggiungere un commento alla issue di cortesia aperta da Gimmy su
  `mrk-its/homeassistant-blitzortung`: le tessere sono passate da 9 a 15
  (PR #18). Testo proposto:

  > Small update: I've widened the covered area from ~9 tiles around
  > Friuli-Venezia Giulia to 15 geohash tiles (precision 3) covering Northern
  > Italy, so storms can be seen approaching before they reach the area.
  > Everything else is unchanged: still a single connection, opened only while
  > a viewer is active, QoS 0, no publishes, backoff on reconnect. Happy to
  > scale it back if this is too much.

### Riordino cartelle (segnalato da Gimmy il 2026-09-24)
- [ ] In `C:\Users\gimmy\repos` c'è anche una cartella `sismo-worker` allo
  stesso livello di `sismo-echo`: probabile avanzo del trasloco
  (`sismo-worker` è una sottocartella del repo, non un progetto a sé).
- [ ] Ricontrollare `C:\Users\gimmy` per avanzi della vecchia posizione.
- [x] Modifiche locali a `sismo-worker/package.json` e `package-lock.json` sul
  PC di Gimmy. Il diff (visto il 2026-09-25) era solo wrangler da `^4.70.0` a
  `^4.135.0`, quindi è stato portato su `main`: wrangler `^4.140.0`, con il
  lock rigenerato da `npm install` e non copiato a mano. Sul PC, prima del
  pull, vanno scartate le due modifiche locali, che su `main` sono già
  presenti:
  `git restore sismo-worker/package.json sismo-worker/package-lock.json`.
  Dopo il pull va lanciato `npm ci` in `sismo-worker`.
- [ ] Branch remoto `claude/happy-galileo-nicmru`: da cancellare. Il suo
  contenuto (pannello radiazione NOAA GOES) è già tutto su `main` via PR #16
  (squash, commit `b60b6af`), verificato riga per riga il 2026-09-24.
- Prima di cancellare qualsiasi cartella, verificare che non contenga lavoro
  unico: `git -C <cartella> remote -v`, `Test-Path <cartella>\.git`,
  `git -C <cartella> status`, `git -C <cartella> log origin/main..`.
- Niente cancellazioni senza la conferma esplicita di Gimmy.

### Workflow GRIB sospesi (PR #20, 2026-09-24)
- `fvg-grib-data.yml` e `fvg-gribmonitor.yml` cercano
  `Projects/coded/FVG-GribMonitor/`, rimossa dal repo il 2026-09-01: fallivano
  a ogni esecuzione (4 volte al giorno il primo, a ogni push su `main` il
  secondo). Tolti gli avvii automatici, resta `workflow_dispatch`; il blocco
  `on:` originale è in commento in testa a ciascun file.
- [ ] Decidere: spostarli nel repo dell'app FVG-GribMonitor (soprattutto
  `fvg-grib-data`, che pubblica il GRIB letto dal pulsante "Scarica ultimo
  GRIB") oppure eliminarli.
