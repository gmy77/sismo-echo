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
