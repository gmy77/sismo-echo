# MODIS-FVG Viewer — contesto per Claude Code

Visualizzatore MODIS/HLS per il Friuli Venezia Giulia. **C++ Win32 + GDI+, zero
dipendenze esterne** (niente GDAL, HDF, ffmpeg, vcpkg). Versione **1.0.1**.
Autori: Anthropic · PIGNOLO GIMMY.

Branch di lavoro: `claude/modis-fvg-viewer-winui-2fnm3y` — PR **#15** (pronta,
non più bozza dal 12/09/2026).

---

## Come è fatto

**Nucleo portabile e testato** (`modis` / `image` / `colormap`): decodifica e
compositing, senza una riga di Windows dentro. Gira e si testa su Linux con
CTest — è quello che permette di verificare le correzioni senza un PC Windows.

**Parte Windows** (`app` / `gibs` / `mf_encoder`): GUI, download WinHTTP,
decodifica GDI+, encoding MP4 con Media Foundation.

**Worker Cloudflare** (`sismo-worker/index.js`, rotta `/modis`): proxy e cache
edge verso NASA GIBS. Nessun DB richiesto. Va **ridistribuito** ogni volta che
si aggiunge un prodotto, altrimenti risponde `400 prodotto sconosciuto`.

Deploy: `cd sismo-worker && npx wrangler deploy` (se il token OAuth è scaduto:
`npx wrangler logout && npx wrangler login`).

## Ambiente di sviluppo

- Il repo dell'utente è clonato **direttamente in `C:\Users\gimmy`** (la home
  *è* la radice del repo), non in una sottocartella.
- L'utente compila con **MSYS2 / MinGW GCC 15.1.0**; qui si compila in
  cross con `x86_64-w64-mingw32-g++`. Stesso risultato, dimensioni diverse.
- **NASA GIBS e `*.workers.dev` sono bloccati in uscita da questo ambiente**:
  i nomi dei layer non sono verificabili da qui, solo dall'utente.

---

## Fatto in v1.0.1 (19/09/2026)

Segnalato dall'utente: cancellando una miniatura dalla filmstrip (×), al
riavvio riappariva — sembrava che il cestino non cancellasse davvero il PNG
in cache. **Causa reale**: non era un bug di cancellazione — `removeIndex()`
cancellava correttamente il file giusto. Il problema era che **la stessa data
scaricata in più prodotti** (es. True Color e poi Bande 7-2-1) produce due
file di cache diversi, ma la filmstrip li etichettava entrambi allo stesso
modo ("2026-09-03 (blocco)"): cancellandone uno restava l'altro, visivamente
quasi identico, dando l'impressione che la cancellazione non avesse
funzionato.

- **Etichetta filmstrip disambiguata**: ora include l'id del prodotto
  (`vFilmLabel()`), es. "bands721 · 2026-09-03 (blocco)" invece del solo
  "2026-09-03 (blocco)" — miniature diverse hanno ora etichette diverse.
- **Cancellazione più robusta**: se `DeleteFileW` fallisce (es. attributo
  sola-lettura impostato momentaneamente da un antivirus), un secondo
  tentativo dopo `SetFileAttributesW(FILE_ATTRIBUTE_NORMAL)` copre il caso.
- **Casella "CANALE / BANDA" non più morta per le immagini GIBS**: prima
  mostrava sempre la stessa frase fissa e disabilitata per ogni granulo
  remoto (la composizione per banda si applica solo a un `.mgr` locale, non
  a un'immagine GIBS già composita). Ora, per un granulo remoto, mostra
  prodotto, satellite, data/ora, area (FVG o blocco) e risoluzione reali —
  uno spazio prima inutilizzato ora dà informazioni vere.
- Verificato con cross-build MinGW completa (`MODIS-FVG-Viewer.exe`, 1.4 MB)
  e CTest sul nucleo portabile (2/2 verde) da un ambiente senza Windows.

## Fatto in v1.0.0

- Lettura granuli `.mgr` (formato MFVG, vedi `docs/MFVG-FORMAT.md`).
- Download reale da NASA GIBS, diretto o via Worker, con cache su disco
  ricaricata all'avvio.
- **11 prodotti**: true-color, 7-2-1, 3-6-7, LST, HLS Sentinel-2 e Landsat a
  30 m, incendi, aerosol, neve NDSI, NDVI, clorofilla.
- **Incendi sovrapposti al 7-2-1** (non al true-color): la banda 7 è SWIR e
  attraversa il fumo. Spunta *Solo strato* per vedere i punti nudi.
- **Ricerca automatica della data**: sonde da 256 px camminano indietro nel
  tempo finché non trovano dati, poi scarica alla risoluzione piena solo la
  data trovata.
- Modalità **blocco** (fascia FVG → equatore, ±12° di longitudine).
- Pan, zoom sul cursore (fino a 1/8 dell'inquadratura), barra di scala in km
  corretta per la latitudine, overlay confini e città FVG.
- Vista **differenza** fra granuli consecutivi, **timelapse MP4**.
- Salvataggio della vista in **PNG**, scorciatoie (`←` `→` `Home` `Fine` `F`
  `+` `−` `Ctrl+S`).
- Filmstrip con **×** che cancella il granulo *e* il suo file di cache.
- Apertura su una vera immagine MODIS (Terra true-color) se la cache è vuota.
- **Nuvole in grigio** (`img::mutedClouds`): riconosce la nuvola perché è
  chiara *e* senza dominante, e la appiattisce. Non nasconde e non inventa: fa
  risaltare il terreno ancora visibile e rende evidente dove il sensore è cieco.
- **Vista a griglia** (fino a 9 giornate affiancate, clic per aprirne una) e
  **fascia a riquadri** (la colonna FVG→equatore tagliata in 4 sezioni con la
  latitudine indicata). Sono un menu, non spunte: si escludono a vicenda.
- Confini disegnati con **guaina scura** sotto il tratto chiaro: un bianco pieno
  spariva sopra le nuvole, cioè su gran parte delle scene MODIS.
- `build.bat` trova da solo Visual Studio (vswhere + vcvars64) o MinGW;
  `setup-compiler.bat` installa MSYS2; `check-compiler.bat` diagnostica.

---

## TODO

### Da verificare (prioritario)
I **cinque prodotti aggiunti per ultimi** non sono mai stati provati:
`fires`, `aerosol`, `snow`, `ndvi`, `chlor`. I nomi dei layer GIBS sono scritti
a memoria e **non verificabili da questo ambiente**. Se uno fallisce, correggere
il nome in `src/gibs.h` **e** in `sismo-worker/index.js` (due posti, sempre).
Lo stesso vale per i due HLS a 30 m, provati solo parzialmente.

### Chiesto dall'utente (prossima sessione)

**Stack MODIS su mezzo pianeta, navigabile.** Una vista che parte da
un'inquadratura molto ampia — indicativamente lat -60..80, lon -180..180 — e
permette di scendere col mouse fino al Friuli: trascinare per spostarsi,
rotellina per zoomare, e un modo per **tornare indietro** ai livelli
precedenti.

Note di progetto per chi lo affronta:
- GIBS accetta qualunque bbox, quindi il mondo intero è una sola richiesta. Ma
  a 4096 px su 360° di longitudine si è a ~10 km/pixel: va bene come vista
  d'insieme, non per il dettaglio.
- Serve quindi **ri-scaricare la finestra visibile alla risoluzione giusta**
  quando si zooma, non ingrandire i pixel che si hanno. È la stessa logica di
  `requestWidthFor()`, ma applicata al riquadro visibile invece che a uno
  fisso: il bbox diventa una variabile di stato, non una costante.
- Il "tornare indietro" è una **pila di inquadrature** (bbox + zoom): ogni
  discesa impila, un tasto o il tasto destro disimpila. Da valutare se
  scorciatoia da tastiera (`Backspace`) o pulsante.
- La cache su disco va ripensata: oggi il nome file codifica satellite,
  prodotto e data perché il bbox è fisso. Con un bbox libero serve un'impronta
  del riquadro nel nome, altrimenti immagini di zone diverse si sovrascrivono.
- Attenzione a non ri-scaricare a ogni pixel di trascinamento: scaricare
  **quando il mouse si ferma**, non durante.

**Altro** — spazio per le prossime idee dell'utente.

### Idee gia' proposte, non ancora scelte
- Confronto **affiancato** di due date (la vista a griglia lo copre in parte).
- **Serie storica** di un punto: clic su una città → andamento nei mesi.
- **Timelapse** con immagini reali (finora provato solo sui granuli sintetici).
- Pulsante **"giornata più limpida"**: sonde da 256 px sugli ultimi 10-15
  giorni, misura della nuvolosità, carica solo la migliore.

> Nota: "mettere una X sulle miniature per cancellarle" era in lista ed **è
> già fatto** in v1.0.0 — cancella anche il PNG dalla cache.

### Aperto
- PR #15 è ancora in **bozza**: l'utente deciderà quando renderla pronta e
  unirla in `main`.
- Larghezza della fascia "blocco" fissa a ±12°; si può parametrizzare.

---

## Trappole già pagate — non ricascarci

**`.gitignore` mangia `app.manifest`.** La regola `*.manifest` viene dal modello
PyInstaller e cattura il manifest Win32 per omonimia. C'è un'eccezione esplicita
per `Projects/coded/*/src/app.manifest`. Il sintomo era `windres: can't open
file app.manifest`, che sembra un problema di percorsi: ho corretto due volte il
posto sbagliato prima di accorgermene.

**Verificare da un checkout pulito, non dalla propria copia di lavoro.** Il file
mancante c'era in locale come non tracciato: qui compilava, sull'altra macchina
no. `git archive HEAD | tar -x -C /tmp/...` e compilare da lì.

**In batch, `>` in un `echo` è una redirezione.** `echo Fatto! -> app.exe`
scriveva "Fatto!  -" *dentro* l'eseguibile, lasciandolo di 11 byte. Va scritto
`-^>`. `build.bat` ora verifica che l'exe superi i 100 KB prima di dichiarare
successo.

**`windres` non onora `-I` per i file di dati** citati nel `.rc`, malgrado la
documentazione dica il contrario. Il compilatore di risorse va eseguito **con
`src/` come cartella di lavoro**: in `build.bat` con `pushd`, in CMake con un
comando esplicito e `WORKING_DIRECTORY`.

**Un `BUTTON` con stile visivo ignora i colori restituiti da
`WM_CTLCOLORSTATIC`** e disegna l'etichetta col colore del tema di sistema: su
pannello scuro usciva nero su nero. Pulsanti e caselle sono owner-drawn, con lo
stato delle caselle in `checkStateFor()` — un posto solo, così disegno e clic
non divergono.

**MODIS risolve 250 m.** Il FVG è ~124 km, cioè ~500 pixel nativi: chiedere di
più *interpola soltanto*, ed è quello che lo faceva sembrare sfocato. Vedi
`requestWidthFor()`. Per il dettaglio vero servono i layer HLS a 30 m.

**GIBS segnala "nessun passaggio" con la trasparenza, non con un errore.** I
pixel trasparenti diventano `img::NODATA`, e `img::coverage()` distingue una
tessera vuota da una scena scura reale. Le tessere vuote **non vanno in cache**.

**L'app aperta blocca il proprio eseguibile.** Il linker fallisce con
"cannot open output file: Permission denied", che sembra un problema di
permessi del disco. `build.bat` ora lo verifica e lo dice.

**Attenzione a quale exe si sta lanciando.** L'utente ne aveva tre copie sparse
e per ore ha guardato una build vecchia, credendo che una correzione non fosse
stata applicata. La barra del titolo porta la versione apposta: se non dice la
versione corrente (vedi cima file), è vecchio. **Ricapitato il 19/09/2026**:
un `MODIS-FVG-VIEWER-nuovo.exe` (nome fuorviante — era vecchissimo) mostrava
ancora "1.0" e il suo log usava lo schema di cache pre-storico `g_T_0_2.png`/
`s_T_0_2.png` (senza data), abbandonato da tempo in favore di
`gibs_T_0_<data>.png`/`strip_T_0_<data>.png`. L'unico modo sicuro: compilare
ed **avviare dall'IDE** (F5), mai un `.exe` trovato per caso sul disco.

**`gen-sln.bat` può generare un `.slnx`, non un `.sln`.** Con CMake e Visual
Studio recenti il generatore Visual Studio produce il nuovo formato XML
"slim" `.slnx` invece del vecchio `.sln` — stesso contenuto, si apre allo
stesso modo in VS. Se l'utente cerca un `.sln` e non lo trova, è probabile
che ci sia un `.slnx` dentro `build\` che ha semplicemente ignorato perché
cercava l'estensione sbagliata (o il filtro "Apri file" di VS non lo mostra
finché non si sceglie "Tutti i file").

**Cambiare un prodotto richiede due file**: `src/gibs.h` (app) e
`sismo-worker/index.js` (Worker). Dimenticare il secondo dà `400 prodotto
sconosciuto` — che è voluto: prima ripiegava in silenzio sul true-color,
spacciandolo per il prodotto richiesto.

---

## Convenzioni

- Commenti e messaggi di commit **in italiano**, come il resto del repo.
- Ogni modifica va verificata compilando davvero: cross-build MinGW +
  `ctest --test-dir <build>` per il nucleo portabile.
- Nessuna dipendenza esterna nuova senza discuterne: è il vincolo di progetto.
