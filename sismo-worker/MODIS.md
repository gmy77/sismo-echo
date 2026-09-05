# MODIS Europa

Visualizzatore web di MODIS Terra e Aqua True Color, servito dal Worker
Cloudflare su `https://sismo-fvg.gimmy077.workers.dev/modis-europa`.

## Caratteristiche

- Mosaico NASA GIBS del giorno UTC precedente, per usare una composizione
  completa invece di una scena parziale in aggiornamento.
- Selezione automatica Terra con fallback ad Aqua se la prima sorgente non e'
  disponibile.
- Zoom e trascinamento richiedono sempre un nuovo ritaglio alla risoluzione del
  display, fino a 4096 px per lato.
- Aree rapide Europa, Italia e FVG; esportazione della vista in PNG.

## Versione 1.1.0

- Confronto selezionabile fra Terra e Aqua, con fallback automatico.
- True Color e falsi colori MODIS 721/367 per leggere meglio superficie,
  vegetazione, nubi e polvere.
- Luminosita', contrasto e saturazione locali, coordinate del cursore,
  schermo intero ed esportazione PNG.
