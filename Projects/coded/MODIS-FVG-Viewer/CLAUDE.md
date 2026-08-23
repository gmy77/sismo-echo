# MODIS-FVG Viewer — contesto per Claude Code

Visualizzatore MODIS/HLS per il Friuli Venezia Giulia. **C++ Win32 + GDI+, zero
dipendenze esterne** (niente GDAL, HDF, ffmpeg, vcpkg). Versione **1.0.0**.
Autori: Anthropic · PIGNOLO GIMMY.

Branch di lavoro: `claude/modis-fvg-viewer-winui-2fnm3y` — PR **#15** (bozza).

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

### Idee proposte all'utente
- Confronto **affiancato** di due date.
- **Serie storica** di un punto: clic su una città → andamento nei mesi.
- **Timelapse** con immagini reali (finora provato solo sui granuli sintetici).

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
stata applicata. La barra del titolo porta la versione apposta: se non dice
`1.0.0`, è vecchio.

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
