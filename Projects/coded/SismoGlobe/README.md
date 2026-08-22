# 🌍 SismoGlobe

Monitoraggio dei terremoti di tutto il pianeta in tempo reale, su un globo 3D interattivo suddiviso per nazioni.

## Funzionalità

- **Globo 3D** (WebGL, [globe.gl](https://globe.gl)) con texture notturna, atmosfera e confini nazionali (world-atlas TopoJSON, disegnati come singola mesh di linee per non pesare sul rendering).
- **Feed live USGS**: polling ogni 60 secondi del feed `all_day` / `all_week` / `all_month`.
- **Avvisi in tempo reale**: ogni nuovo terremoto genera un toast con magnitudo, località, profondità e ora; opzionale segnale acustico (tono più grave per magnitudo più alte) e "volo" della camera sull'epicentro per M ≥ 4.5.
- **Cerchi proporzionali alla magnitudo**: ogni sisma è un cerchio colorato la cui dimensione cresce con la magnitudo; gli eventi delle ultime 3 ore emettono anelli animati (onde sismiche) con raggio e velocità proporzionali alla magnitudo.
- **Istogramma giornaliero (30 giorni)**: barre colorate in base alla magnitudo massima del giorno; click su una barra per vedere sul globo solo i sismi di quel giorno.
- **Statistiche**: eventi oggi, eventi nell'ultima ora, magnitudo massima 24h, energia sismica rilasciata nelle ultime 24h (equivalente TNT).
- **Filtri**: finestra temporale (24h / 7g / 30g) e magnitudo minima.
- **Lista eventi** cliccabile (vola sull'epicentro), tooltip dettagliato al passaggio del mouse, indicazione allerta tsunami.

## Prestazioni

La rotazione gira a 60 FPS anche nella vista a 30 giorni (~11.000 eventi). Accorgimenti adottati:

- confini nazionali resi come **una sola** mesh `LineSegments` invece del layer poligoni di globe.gl (da ~1.400 a ~1 draw call);
- punti fusi in un'unica geometria (`pointsMerge`) quando gli eventi visibili superano i 600. Con i punti fusi globe.gl non distingue più i singoli eventi, quindi tooltip e clic sull'epicentro sono gestiti da un puntamento scritto a mano: si interseca il raggio del mouse con la sfera del globo e si cerca il terremoto più vicino al punto colpito, scorrendo un `Float32Array` di posizioni precalcolate. Costa ~0,1 ms per movimento del mouse con 11.000 eventi e non tocca la GPU; i sismi dell'emisfero opposto vengono esclusi, così non si punta "attraverso" il globo;
- anelli animati limitati ai 20 sismi più forti e geometria dei punti semplificata (`pointResolution`);
- pixel ratio del renderer limitato a 1,25 (sugli schermi ad alta densità il costo cresce col quadrato);
- **raycasting**: il test "cosa sta puntando il mouse" gira a ogni frame e contro la sfera del globo three.js provava tutti i suoi ~11.000 triangoli (~2,8 ms a frame per sfera, il globo scattava solo col puntatore sopra e tornava fluido sullo sfondo). Sostituito con l'intersezione analitica sfera-raggio, rispettando `material.side` perché l'atmosfera è `BackSide` e la sua faccia vicina non deve contare, altrimenti coprirebbe i terremoti. Graticolo e confini sono esclusi dal test. Da ~6,9 ms a ~0,33 ms per frame.

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
