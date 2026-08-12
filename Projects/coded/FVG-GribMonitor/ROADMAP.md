# FVG GRIB Monitor — Roadmap & idee

Idee per i prossimi giri, guardando cosa fanno i reader affermati
(**XyGrib/zyGrib** per la parte meteo-nautica, **Panoply** per la parte
scientifica, **Windy/QGIS** per UX e layer, **eccodes/wgrib2/GDAL** per il
formato). Ordinate per priorità e con una stima grossolana dell'impegno.

Legenda: 🟢 quick win · 🟡 medio · 🔴 grosso · ⭐ ad alto impatto

---

## P0 — Sbloccare i file "veri" (senza questo, l'app legge solo i nostri estratti)

### 1. ⭐🔴 Packing GRIB2 oltre al "simple" (template 5.0)
Oggi il parser decodifica **solo** il *simple packing* (5.0). Ecco perché il
nostro `FVG_CAPE` funziona ma un file **grezzo di GFS/ICON/ECMWF** quasi
sicuramente **non si aprirebbe**: quelli usano di solito
- **5.3** complex packing + spatial differencing (GFS)
- **5.40** JPEG2000, **5.41** PNG (molti prodotti operativi)
- 5.2 complex packing

Da fare:
- Implementare 5.2/5.3 (complex + spatial differencing) — solo matematica, portabile.
- 5.41 (PNG): su Windows si può decodificare con **WIC** (già presente nell'OS) o
  con una piccola libreria; il PNG è "solo" zlib+filtri.
- 5.40 (JPEG2000): serve un decoder (OpenJPEG) — è il più pesante, valutare se
  vale la pena o se ci limitiamo a PNG/complex.
- Messaggio d'errore chiaro quando incontra un packing non supportato (oggi il
  campo viene semplicemente saltato in silenzio).

### 2. ⭐🔴 Griglie diverse dalla lat/lon regolare
Oggi supportiamo solo il **template griglia 3.0** (lat/lon regolare). I modelli
regionali che coprono meglio il FVG usano spesso:
- **rotated lat/lon** (3.1) — es. ICON-D2 / COSMO
- **Lambert conformal** (3.30) — es. alcuni modelli ad area limitata

Serve implementare la proiezione inversa di questi grigliati per posizionare i
punti correttamente sulla mappa.

### 3. ⭐🟡 Selettore di sorgenti per il download
Al posto del singolo `grib_url`, un menù di sorgenti pronte, con **ritaglio sul
riquadro FVG** fatto lato server dove possibile:
- **Open-Meteo** (API GRIB/JSON, semplice, gratuita)
- **DWD ICON open-data** (ICON-D2 copre bene le Alpi orientali)
- **NOMADS GFS** con subset lat/lon (`subregion` → prende solo 12–14E / 45–47N)
- **OSMER / ARPA FVG** se espongono GRIB
Utile anche perché il nostro estratto attuale è "simple packing" apposta; le
sorgenti vere richiedono prima il punto 1.

---

## P1 — Funzioni che allineano l'app a XyGrib/Windy

### 4. ⭐🔴 Animazione temporale (time slider)
File con **più scadenze** (t+0, t+3, t+6…): slider + play/pausa per far
"scorrere" la previsione. È *la* funzione che manca di più rispetto a
XyGrib/Windy. Richiede che il file/scaricamento porti più istanti.

### 5. ⭐🟡 Meteogramma sul punto
Click su un punto → grafico dell'andamento temporale della variabile in quel
punto (come il "Meteotable" di XyGrib). Dipende dai dati multi-tempo (punto 4).

### 6. 🟡 Barbe del vento "vere" (oltre alle frecce)
Opzione per disegnare le **barbe** meteorologiche: mezza barba = 5 kt, barba
intera = 10 kt, gagliardetto = 50 kt. Più toggle unità **m/s ↔ km/h ↔ nodi**.

### 7. 🟡 Isolinee con etichette
Isobare (con **H/L** sui centri di alta/bassa), isoterme, ecc., sovrapposte al
colore. Algoritmo marching squares + etichette.

### 8. 🟡 Composizione a livelli
Scegliere **campo base a colori + barbe vento + isolinee** contemporaneamente
(oggi le frecce già si sovrappongono al CAPE: generalizzare a più overlay
selezionabili con checkbox indipendenti).

### 9. 🟢🟡 Scala colori configurabile
- min/max fissi (per confrontare mappe diverse) oppure automatici
- **soglie/bin discreti** (es. CAPE: 0/300/1000/2500 J/kg con colori netti)
- più palette selezionabili, default per-variabile
- legenda con tacche e valori dei bin

### 10. 🟡 Export
- Salva la vista corrente come **PNG** (un bottone; il codice di rendering
  offline in `tools/preview_render.cpp` è già l'80% del lavoro)
- Export **animazione** GIF/MP4 (dopo il punto 4)

### 11. 🟢 Finestra Impostazioni + persistenza
- Dialog GUI per URL/sorgenti/opzioni invece di editare `config.ini`
- Ricordare dimensione finestra, ultima cartella, opzioni, ultimo campo scelto

---

## P2 — Rifiniture, performance, distribuzione

### 12. 🟢 Icona + installer
- **Icona** vera dell'app (`.ico`) al posto di quella di default
- **Installer** (Inno Setup) + zip portabile; opzionale firma del codice
  (togliere l'avviso SmartScreen)

### 13. 🟡 Performance del rendering
Per la griglia 9×9 va benissimo così, ma per grigliati grandi:
- **cache** del bitmap overlay: ricalcolare solo quando cambiano
  vista/opzioni/dimensione, non a ogni `WM_PAINT`
- parallelizzare il ciclo per-pixel (std::thread / OpenMP)
- per griglie molto grandi: downsampling + tिling

### 14. ⭐🟡 Auto-update "completo"
Oggi il pulsante apre la pagina di download. Migliorabile:
- scaricare l'exe della nuova Release e **sostituirsi da solo** al riavvio
- iniettare la **versione dal tag** in `APP_VERSION` in fase di build (così la
  versione dell'exe combacia sempre col tag della Release)

### 15. 🟢 Più campi + palette intelligenti
Precipitazione, T a 2 m (in °C), umidità, MSLP, raffiche, neve, onde… ognuna con
palette e unità adatte. (Il motore è già pronto: basta mappare
categoria/numero → nome/unità/palette.)

### 16. 🟢 Rifiniture mappa
- **graticola** lat/lon e **scale bar**
- più località (montagne, stazioni OSMER), fiumi/coste opzionali
- crosshair + lettura di **tutti** i campi nel punto (non solo quello attivo)

### 17. 🟢 i18n IT/EN
Interfaccia commutabile Italiano/Inglese (utile se vuoi condividerla).

### 18. 🟡 Robustezza & test
- file di esempio per ogni packing (5.2/5.3/5.40/5.41) nei test
- supporto **GRIB1** (vecchi file)
- fuzzing del parser su input malformati

### 19. 🟢 Accessibilità
Le palette attuali (tipo viridis) sono già abbastanza *colorblind-safe*;
aggiungere una palette esplicitamente sicura e un tema chiaro/scuro.

---

## Debito tecnico noto (piccole cose)
- Il parser **salta in silenzio** i campi con packing non supportato → almeno
  loggarli / mostrarli in una lista "campi non decodificati".
- `config.ini` va copiato a mano accanto all'exe con alcuni flussi di build → la
  finestra Impostazioni (punto 11) risolverebbe.
- Nessuna gestione fuso/UTC esplicita in UI oltre alla data di emissione.

---

## Ordine consigliato per il prossimo giro
1. **Packing complex 5.2/5.3** (sblocca GFS) + messaggio d'errore sui packing non supportati → P0.1
2. **Selettore sorgenti** con Open-Meteo/ICON e subset FVG → P0.3
3. **Time slider + animazione** → P1.4 (è la funzione "wow")
4. **Export PNG** della vista → P1.10 (rapido, riusa `tools/preview_render.cpp`)
5. **Scala colori a soglie** per il CAPE → P1.9

> Nota: i punti 1–3 sono quelli che trasformano l'app da "visualizzatore dei
> nostri estratti" a "vero GRIB reader per il FVG".

---

## Riferimenti
- XyGrib (OpenGribs) — barbe vento, isobare H/L, meteotable: https://opengribs.org/en/xygrib
- GRIB2 data representation templates (5.0/5.2/5.3/5.40/5.41): https://www.nco.ncep.noaa.gov/pmb/docs/grib2/grib2_doc/
- GDAL GRIB driver (packing/proiezioni supportate): https://gdal.org/en/latest/drivers/raster/grib.html
- eccodes (ECMWF) — riferimento del formato: https://confluence.ecmwf.int/display/ECC
