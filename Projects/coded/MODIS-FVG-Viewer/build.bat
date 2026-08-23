@echo off
REM ===========================================================================
REM  MODIS FVG Viewer - build su Windows.
REM  Doppio-click, oppure eseguilo da un prompt qualsiasi.
REM
REM  Trova il compilatore da solo, in quest'ordine:
REM    1. cl.exe / g++.exe gia' nel PATH
REM    2. Visual Studio via vswhere -> carica vcvars64.bat  (NON serve aprire
REM       il "x64 Native Tools Command Prompt": ci pensa lo script)
REM    3. MinGW-w64 nelle posizioni note (MSYS2, chocolatey, winget, C:\mingw64)
REM  Se non trova nulla, rimanda a setup-compiler.bat che lo installa.
REM ===========================================================================
setlocal EnableDelayedExpansion
cd /d "%~dp0"

REM --- 0. i sorgenti ci sono tutti? ------------------------------------------
REM app.manifest e' gia' stato escluso una volta da una regola .gitignore
REM pensata per PyInstaller: senza, windres fallisce con un messaggio che
REM sembra un problema di percorsi e manda fuori strada. Meglio dirlo qui.
for %%F in (src\app.cpp src\app.rc src\app.manifest src\modis.cpp src\image.cpp src\gibs.cpp src\mf_encoder.cpp) do (
  if not exist "%%F" (
    echo.
    echo  MANCA UN FILE SORGENTE:  %%F
    echo.
    echo  Il checkout e' incompleto. Verifica che non sia escluso da .gitignore:
    echo     git check-ignore -v %%F
    echo  e riprendi il progetto dal branch:
    echo     git checkout origin/^<branch^> -- Projects/coded/MODIS-FVG-Viewer
    echo.
    pause
    exit /b 1
  )
)

REM --- 0b. l'eseguibile e' in esecuzione? ------------------------------------
REM Windows tiene bloccato un exe mentre gira, e il linker fallisce con
REM "cannot open output file: Permission denied" - un messaggio che sembra un
REM problema di permessi del disco. Meglio dirlo chiaramente adesso.
if exist MODIS-FVG-Viewer.exe (
  2>nul (>>MODIS-FVG-Viewer.exe echo.) || (
    echo.
    echo  MODIS-FVG-Viewer.exe e' in uso: l'app e' aperta.
    echo  Chiudila e rilancia questo file. Per forzare:
    echo     Get-Process MODIS-FVG-Viewer ^| Stop-Process -Force
    echo.
    pause
    exit /b 1
  )
)

REM --- 1. gia' nel PATH? -----------------------------------------------------
where cl  >nul 2>nul && goto :msvc
where g++ >nul 2>nul && goto :mingw

REM --- 2. Visual Studio installato ma ambiente non caricato -------------------
REM vswhere e' installato con qualsiasi VS 2017+ e sta sempre in questo percorso.
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" set "VSWHERE=%ProgramFiles%\Microsoft Visual Studio\Installer\vswhere.exe"
REM Struttura piatta, senza blocchi fra parentesi: vcvars64.bat manipola
REM l'ambiente e chiamarlo dentro un blocco e' una fonte nota di guai.
if not exist "%VSWHERE%" goto :trymingw
echo  Cerco Visual Studio...
set "VSPATH="
REM Una riga sola: dentro un for /f la continuazione con ^ e' inaffidabile.
for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2^>nul`) do set "VSPATH=%%i"
if not defined VSPATH goto :trymingw
if not exist "%VSPATH%\VC\Auxiliary\Build\vcvars64.bat" goto :trymingw
echo  Trovato: %VSPATH%
echo  Carico l'ambiente C++ x64...
call "%VSPATH%\VC\Auxiliary\Build\vcvars64.bat" >nul
where cl >nul 2>nul && goto :msvc

:trymingw

REM --- 3. MinGW-w64 nelle posizioni note -------------------------------------
for %%D in (
  "C:\msys64\ucrt64\bin"
  "C:\msys64\mingw64\bin"
  "C:\mingw64\bin"
  "C:\ProgramData\chocolatey\bin"
  "%ProgramFiles%\mingw64\bin"
) do (
  if exist "%%~D\g++.exe" (
    echo  Trovato MinGW in %%~D
    set "PATH=%%~D;!PATH!"
    goto :mingw
  )
)
REM winget installa i pacchetti portabili qui sotto, in sottocartelle variabili.
if exist "%LOCALAPPDATA%\Microsoft\WinGet\Packages" (
  for /d %%P in ("%LOCALAPPDATA%\Microsoft\WinGet\Packages\*") do (
    for %%S in ("mingw64\bin" "ucrt64\bin" "bin") do (
      if exist "%%~P\%%~S\g++.exe" (
        echo  Trovato MinGW in %%~P\%%~S
        set "PATH=%%~P\%%~S;!PATH!"
        goto :mingw
      )
    )
  )
)

echo.
echo  Nessun compilatore trovato.
echo.
echo  ==^> Doppio-click su  setup-compiler.bat  : installa MinGW-w64 e compila.
echo.
echo  In alternativa, a mano:
echo    - Visual Studio: Programmi ^> Visual Studio Installer ^> Modifica ^>
echo      spunta "Sviluppo di applicazioni desktop con C++", poi rilancia questo file.
echo    - MSYS2 (https://www.msys2.org/): pacman -S mingw-w64-ucrt-x86_64-gcc
echo.
pause
exit /b 1

:msvc
echo [MSVC] Compilazione in corso...
REM Il .rc incorpora "app.manifest" con un nome nudo, che il compilatore di
REM risorse risolve rispetto alla cartella di lavoro. -I non basta: alcune
REM versioni non lo consultano per i file di dati. Entriamo in src, dove il
REM nome nudo non puo' sbagliare.
pushd src
rc /nologo /fo app.res app.rc
if %errorlevel% neq 0 ( popd & echo Errore nelle risorse ^(rc^). & pause & exit /b 1 )
popd
cl /nologo /EHsc /O2 /std:c++17 /DUNICODE /D_UNICODE ^
   src\app.cpp src\modis.cpp src\image.cpp src\gibs.cpp src\mf_encoder.cpp src\app.res ^
   /Fe:MODIS-FVG-Viewer.exe ^
   /link /SUBSYSTEM:WINDOWS /MANIFEST:NO ^
   gdiplus.lib comctl32.lib comdlg32.lib dwmapi.lib winhttp.lib shlwapi.lib ^
   mfplat.lib mfreadwrite.lib mfuuid.lib ole32.lib gdi32.lib user32.lib shell32.lib
if %errorlevel% neq 0 ( echo Errore di compilazione. & pause & exit /b 1 )
del /q *.obj src\app.res 2>nul
goto :done

:mingw
echo [MinGW] Compilazione in corso...
REM Vedi il commento in :msvc. windres 15.x ignora -I per i file di dati
REM referenziati dal .rc, quindi ci spostiamo in src invece di indicarglielo.
pushd src
windres -O coff app.rc -o app.res.o
if %errorlevel% neq 0 ( popd & echo Errore nelle risorse ^(windres^). & pause & exit /b 1 )
popd
REM -s toglie i simboli di debug: con le librerie statiche di GCC 15 la
REM differenza e' di parecchi MB, e in una build di rilascio non servono.
g++ -std=c++17 -O2 -s -municode -mwindows -static -static-libgcc -static-libstdc++ ^
    src\app.cpp src\modis.cpp src\image.cpp src\gibs.cpp src\mf_encoder.cpp src\app.res.o ^
    -o MODIS-FVG-Viewer.exe ^
    -lgdiplus -lcomctl32 -lcomdlg32 -ldwmapi -lwinhttp -lshlwapi ^
    -lmfplat -lmfreadwrite -lmfuuid -lole32 -luuid -lgdi32 -luser32 -lshell32
if %errorlevel% neq 0 ( echo Errore di compilazione. & pause & exit /b 1 )
del /q src\app.res.o 2>nul
goto :done

:done
REM L'eseguibile e' davvero un eseguibile? Il linker puo' riuscire e lasciare
REM comunque un file rotto: e' bastata una riga di echo con un '>' non protetto
REM per sovrascriverlo con 11 byte di testo. Meglio accorgersene qui che
REM davanti a "Impossibile eseguire questa app nel tuo PC".
if not exist MODIS-FVG-Viewer.exe (
  echo.
  echo  ERRORE: la compilazione e' finita ma MODIS-FVG-Viewer.exe non c'e'.
  echo.
  pause
  exit /b 1
)
set "EXESZ=0"
for %%A in (MODIS-FVG-Viewer.exe) do set "EXESZ=%%~zA"
if !EXESZ! LSS 100000 (
  echo.
  echo  ERRORE: MODIS-FVG-Viewer.exe e' di soli !EXESZ! byte: non e' un eseguibile.
  echo  Qualcosa l'ha sovrascritto dopo il link ^(tipicamente una redirezione
  echo  accidentale in questo script^). Non lanciarlo: Windows lo rifiuterebbe.
  echo.
  pause
  exit /b 1
)

echo.
REM ATTENZIONE: la freccia va scritta -^^> . Senza l'accento circonflesso
REM batch legge '>' come redirezione e scrive "Fatto!  -" DENTRO
REM MODIS-FVG-Viewer.exe, distruggendo l'eseguibile appena compilato
REM e lasciandolo di 11 byte.
echo  Fatto!  -^> MODIS-FVG-Viewer.exe  ^(!EXESZ! byte^)
echo  I granuli di prova restano in test\ e si aprono con "Apri file".
echo.
pause
