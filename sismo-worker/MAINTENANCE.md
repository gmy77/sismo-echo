# ECHO Maintenance Policy

Questo documento definisce le regole operative per la manutenzione del Worker Cloudflare `sismo-fvg`.

## Regole operative

- Tutte le modifiche al codice devono passare da branch dedicato e Pull Request.
- Il deploy e' consentito solo dopo test riusciti.
- Non cancellare database D1 o namespace KV senza approvazione esplicita.
- Non cambiare dominio, route, DNS o segreti senza approvazione esplicita.
- Non ruotare token, secret o chiavi senza approvazione esplicita.
- Ogni modifica deve essere reversibile tramite Git.

## Test minimi prima del deploy

Eseguire dalla directory `sismo-worker/`:

```bash
npm install
node --check index.js
npx wrangler deploy --dry-run
```

Se `wrangler deploy --dry-run` richiede autenticazione o account Cloudflare non configurato, fermarsi e verificare il token Cloudflare prima di procedere.

## Aree di intervento prioritarie

1. Cache edge controllata per dashboard e API pubbliche.
2. Miglioramento SEO con meta tag, Open Graph e JSON-LD.
3. Riduzione chiamate esterne verso INGV e NOAA.
4. Monitoraggio errori INGV/NOAA e stato ultimo aggiornamento.
5. Separazione progressiva tra logica dati, rendering HTML e funzioni accessorie.

## Variabili/secret attesi

Per deploy automatizzato tramite GitHub Actions servono secret GitHub o variabili ambiente equivalenti:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Il token deve avere permessi minimi e revocabili. Non salvare mai token nel codice sorgente.

Secret del Worker (Cloudflare, `npx wrangler secret put <NOME>` da questa cartella):

- `UPDATE_SECRET` — **obbligatorio**. Protegge `/update`, `/update-solar`, `/diag/ingest` (`?token=`). Se manca, `getUpdateSecret()` restituisce `""` e un `?token=` vuoto passa: va sempre impostato. Rigenerato il 2026-11-07 (copia cartacea + Documenti + OneDrive del proprietario).
- `PIXELDRAIN_KEY` — non più usato (Pixeldrain dismesso); la rotta relativa risponde con errore.

## Cartella di deploy

Il deploy si fa **solo** da `C:\ph\sismo-echo\sismo-worker` (questo repo). Sul PC esistono altre cartelle con `name = "sismo-fvg"` nel `wrangler.toml` (copie vecchie e un progetto diverso, `repos\Cloudflare-MCP-Worker`): un `wrangler deploy` lanciato da lì sovrascrive il sito.

## Incidenti

### 2026-11-07 — errore 1101 su tutte le pagine

**Sintomo.** Ogni indirizzo di `sismo-fvg.gimmy077.workers.dev` rispondeva `500 — error code: 1101` ("il Worker ha lanciato un'eccezione"). `wrangler tail` non mostrava nessun log: il codice non arrivava nemmeno a partire. Il problema è emerso subito dopo il passaggio al piano Workers Paid, ma il pagamento non c'entrava.

**Diagnosi (cosa è stato escluso, provandolo).**

- Il codice era sano: girava sia con `wrangler dev` in locale sia con `wrangler dev --remote` sui server Cloudflare.
- Non erano `[limits] cpu_ms`, `[cache]`, le traces, l'issue detection, il binding del Durable Object `LightningRelay`, né l'account (un Worker nuovo con la stessa identica configurazione funzionava).
- Prova decisiva: un Worker di una riga (`return new Response("ciao")`) pubblicato **con il nome `sismo-fvg`** dava ugualmente 1101. Il guasto era quindi nell'entità "script sismo-fvg" registrata su Cloudflare, non visibile dalle API.
- Cancellare 3 secret con nomi anomali (chiavi incollate per sbaglio nel campo nome) non è bastato.

**Soluzione.** Eliminare lo script e ricrearlo con lo stesso nome:

```bash
npx wrangler delete --name sismo-fvg --force
npx wrangler deploy
```

URL, database D1, KV e cron sono rimasti intatti (sono risorse separate). Si sono persi i secret (reimpostato solo `UPDATE_SECRET`, l'unico usato), la cronologia delle versioni e i dati del Durable Object del relay fulmini (già spento).

**Lezione.** Se il Worker dà 1101 senza nessun log e anche un "hello world" pubblicato col suo nome fallisce, non cercare nel codice: ricreare lo script. Prima di farlo, annotare l'elenco dei secret (`npx wrangler secret list`) e avere a portata di mano i loro valori.
