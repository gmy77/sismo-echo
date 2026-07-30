# 🌍 SismoGlobe

Monitoraggio dei terremoti di tutto il pianeta in tempo reale, su un globo 3D interattivo suddiviso per nazioni.

## Funzionalità

- **Globo 3D** (WebGL, [globe.gl](https://globe.gl)) con texture notturna, atmosfera e confini nazionali (world-atlas TopoJSON); hover su una nazione ne mostra il nome.
- **Feed live USGS**: polling ogni 60 secondi del feed `all_day` / `all_week` / `all_month`.
- **Avvisi in tempo reale**: ogni nuovo terremoto genera un toast con magnitudo, località, profondità e ora; opzionale segnale acustico (tono più grave per magnitudo più alte) e "volo" della camera sull'epicentro per M ≥ 4.5.
- **Cerchi proporzionali alla magnitudo**: ogni sisma è un cerchio colorato la cui dimensione cresce con la magnitudo; gli eventi delle ultime 3 ore emettono anelli animati (onde sismiche) con raggio e velocità proporzionali alla magnitudo.
- **Istogramma giornaliero (30 giorni)**: barre colorate in base alla magnitudo massima del giorno; click su una barra per vedere sul globo solo i sismi di quel giorno.
- **Statistiche**: eventi oggi, eventi nell'ultima ora, magnitudo massima 24h, energia sismica rilasciata nelle ultime 24h (equivalente TNT).
- **Filtri**: finestra temporale (24h / 7g / 30g) e magnitudo minima.
- **Lista eventi** cliccabile (vola sull'epicentro), tooltip dettagliato al passaggio del mouse, indicazione allerta tsunami.

## Avvio

È un sito statico: serve solo un web server nella cartella del progetto, ad esempio:

```bash
python -m http.server 8642
```

poi aprire <http://localhost:8642>.

## Fonti dati

- Terremoti: [USGS Earthquake Hazards Program – GeoJSON feeds](https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php)
- Confini: [world-atlas](https://github.com/topojson/world-atlas) (Natural Earth 110m)
- Rendering: [globe.gl](https://globe.gl) (three.js)
