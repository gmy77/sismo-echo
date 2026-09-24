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

## Da fare: riordino cartelle (segnalato da Gimmy il 2026-09-24)

- [ ] In `C:\Users\gimmy\repos` c'è anche una cartella `sismo-worker` allo
  stesso livello di `sismo-echo`. Probabilmente è un avanzo del trasloco:
  `sismo-worker` è una sottocartella del repo, non un progetto a sé.
- [ ] Ricontrollare `C:\Users\gimmy` per avanzi della vecchia posizione di
  sismo-echo: copie, worktree, file sparsi.
- Prima di cancellare qualsiasi cartella, verificare che non contenga lavoro
  unico:
  - `git -C <cartella> remote -v` dice da quale repo viene;
  - `Test-Path <cartella>\.git` dice se è un repo git o una copia sciolta;
  - `git -C <cartella> status` mostra le modifiche non committate;
  - `git -C <cartella> log origin/main..` mostra i commit non pushati.
- Niente cancellazioni senza la conferma esplicita di Gimmy.

## Da fare: courtesy notice Blitzortung

- [ ] Aggiungere un commento alla issue di cortesia aperta da Gimmy su
  `mrk-its/homeassistant-blitzortung`: le tessere geohash sono passate da 9
  (attorno al FVG) a 15 (tutto il Nord Italia, PR #18). Nella issue avevamo
  scritto "≤9", quindi va aggiornata. Testo proposto:

  > Small update: I've widened the covered area from ~9 tiles around
  > Friuli-Venezia Giulia to 15 geohash tiles (precision 3) covering Northern
  > Italy, so storms can be seen approaching before they reach the area.
  > Everything else is unchanged: still a single connection, opened only while
  > a viewer is active, QoS 0, no publishes, backoff on reconnect. Happy to
  > scale it back if this is too much.

## Fulmini live: stato attuale

- `LightningRelay` (Durable Object in `sismo-worker/index.js`) è stato
  verificato in produzione il 2026-09-24 con la versione a 9 tessere (PR #17):
  `/lightning/status` rispondeva `connected:true`, `clients:1`, nessun errore.
- Copertura attuale (PR #18): `NORTH_ITALY_BOUNDS` (44.2–46.9°N, 7.3–14.0°E),
  15 tessere geohash di precisione 3. Dopo il deploy va riverificata.
- Debug: `https://sismo-fvg.gimmy077.workers.dev/lightning/status`.
- Non si è ancora visto arrivare un fulmine reale: durante i test non c'erano
  temporali in zona.
