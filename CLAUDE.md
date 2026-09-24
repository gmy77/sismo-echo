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
   Eventi: `lightning/connect|heartbeat(5 min)|disconnect|error`,
   `metop/upstream_timeout|upstream_error|legend_timeout`, `cron/run|error`.
2. **Sonda HTTP via GitHub Actions**: workflow `worker-probe.yml`
   (`workflow_dispatch`, input opzionale `path`). Si lancia con
   `actions_run_trigger run_workflow` e si leggono i log con `get_job_logs`.
   Interroga `/lightning/status`, `/metop/layers?q=li`, `/api/stats`, `/polar`.
3. **`/lightning/status`** (pubblico) espone: `version`, `connected`,
   `connectedSince`, `clients`, `strikeCount`, `lastStrikes` (ultime 20),
   `reconnects`, `lastError`, `subscription.tiles` (le tessere geohash
   sottoscritte DAVVERO, non quelle nel commit).
4. **Deploy da Actions**: `sismo-worker-ci.yml` ha il job "Deploy worker"
   (`workflow_dispatch` con `deploy=true`), già usato con successo il
   2026-07-30, quindi i segreti Cloudflare ci sono. Claude lo usa SOLO con
   l'ok esplicito di Gimmy per quel deploy: di norma il deploy lo fa Gimmy
   dal PC.

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
4. **Una sonda** che Claude può lanciare e leggere (qui il workflow
   `worker-probe.yml`), per vedere le risposte HTTP vere quando la rete del
   cloud non arriva al servizio.

### Controllo periodico (la "sentinella")

Una sessione Claude dedicata viene svegliata da una Routine due volte a
settimana e segue questa checklist, in sola lettura. Non modifica codice, non
fa merge, non fa deploy: riferisce. Se tutto è a posto lo dice in una riga;
se qualcosa non va, dice cosa, da quando e con quale prova (la query o il log).

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
5. **Sonda HTTP**: lanciare `worker-probe.yml` e leggerne i log. Allarmi:
   risposte diverse da 200, `/lightning/status` senza `subscription`.
6. **GitHub Actions**: ultimi run di ogni workflow su `main`. Allarmi: rossi
   nuovi. Quelli sospesi di proposito sono elencati sotto.
7. **Deploy allineato**: `workers_list` su Cloudflare, confrontare il
   `modified_on` di `sismo-fvg` con la data dell'ultimo merge su `main` che
   tocca `sismo-worker/`. Se `main` è più nuovo da giorni: deploy dimenticato.
8. **Pulizia**: la tabella `diagnostica` non deve avere righe più vecchie di
   14 giorni (altrimenti la pulizia del cron non gira).

Adozione:
- [x] sismo-echo / Worker `sismo-fvg` (relay fulmini, proxy METOP, cron)
- [ ] SatView_preview (pipeline FCI su PC Windows, Python): da progettare il
  canale di lettura
- [ ] StormShift (bridge METEOHUB + Worker `stormshift`)
- [ ] newtab-worker e gli altri Worker Cloudflare (stesso schema D1)

## Fulmini live: stato attuale

- `LightningRelay` (Durable Object in `sismo-worker/index.js`): relay MQTT
  (broker comunitario `blitzortung.ha.sed.pl:1883`) → WebSocket per il viewer.
- Copertura: `NORTH_ITALY_BOUNDS` (44.2–46.9°N, 7.3–14.0°E), 15 tessere
  geohash di precisione 3 (PR #18). Verificato in produzione il 2026-09-24
  alle 11:59 UTC dopo il deploy: `connected:true`, `clients:1`, nessun errore.
- Non si è ancora visto arrivare un fulmine reale: durante i test non c'erano
  temporali in zona (controllato su lightningmaps.org).

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
- [ ] Sul PC di Gimmy esistono modifiche locali non committate a
  `sismo-worker/package.json` e `package-lock.json` (probabile aggiornamento
  di wrangler): vedere il diff e, se è quello, portarlo su `main` con una PR.
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
