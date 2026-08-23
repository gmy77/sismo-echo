@echo off
REM ===========================================================================
REM  MODIS FVG Viewer - installa un compilatore C++ e compila, in un colpo solo.
REM
REM  Doppio-click e basta. Prima prova a compilare (build.bat sa gia' trovare
REM  Visual Studio o un MinGW installato); solo se non c'e' niente installa
REM  MSYS2 + MinGW-w64 con winget.
REM
REM  Perche' MSYS2 e non altri pacchetti: si installa sempre in C:\msys64, un
REM  percorso noto. Cosi' non dipendiamo dal PATH, che winget aggiorna per le
REM  nuove finestre ma non per quella in corso.
REM ===========================================================================
setlocal EnableDelayedExpansion
cd /d "%~dp0"

echo.
echo  === MODIS FVG Viewer - preparazione compilatore ===
echo.

REM --- Un compilatore c'e' gia'? build.bat lo cerca ovunque, VS incluso. ------
where cl  >nul 2>nul && goto :build
where g++ >nul 2>nul && goto :build
if exist "C:\msys64\ucrt64\bin\g++.exe"  goto :build
if exist "C:\msys64\mingw64\bin\g++.exe" goto :build

set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" set "VSWHERE=%ProgramFiles%\Microsoft Visual Studio\Installer\vswhere.exe"
if exist "%VSWHERE%" (
  set "VSPATH="
  for /f "usebackq tokens=*" %%i in (`"!VSWHERE!" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2^>nul`) do set "VSPATH=%%i"
  if defined VSPATH (
    echo  Visual Studio con i tool C++ e' gia' installato: uso quello.
    goto :build
  )
  echo  Visual Studio c'e', ma senza il workload C++.
  echo  Puoi aggiungerlo da: Visual Studio Installer ^> Modifica ^>
  echo    "Sviluppo di applicazioni desktop con C++"
  echo  Oppure lascio fare a me qui sotto, con MinGW ^(piu' leggero^).
  echo.
)

REM --- winget disponibile? ---------------------------------------------------
where winget >nul 2>nul
if %errorlevel% neq 0 (
  echo  winget non e' disponibile su questo sistema.
  echo.
  echo  Installa a mano UNA di queste, poi rilancia build.bat:
  echo    - MSYS2           https://www.msys2.org/
  echo      poi:  pacman -S mingw-w64-ucrt-x86_64-gcc
  echo    - Visual Studio   https://visualstudio.microsoft.com/downloads/
  echo      workload "Sviluppo di applicazioni desktop con C++"
  echo.
  pause
  exit /b 1
)

echo  Nessun compilatore trovato: installo MSYS2 + MinGW-w64.
echo  (una tantum, qualche minuto; puo' chiedere conferma UAC)
echo.

winget install -e --id MSYS2.MSYS2 --accept-package-agreements --accept-source-agreements
if not exist "C:\msys64\usr\bin\bash.exe" (
  echo.
  echo  MSYS2 non risulta installato in C:\msys64.
  echo  Se winget l'ha messo altrove, apri la sua shell e lancia:
  echo     pacman -S mingw-w64-ucrt-x86_64-gcc
  echo  poi torna qui e lancia build.bat.
  echo.
  pause
  exit /b 1
)

echo.
echo  Installo il compilatore dentro MSYS2 ^(gcc + binutils^)...
"C:\msys64\usr\bin\bash.exe" -lc "pacman -Sy --noconfirm && pacman -S --noconfirm --needed mingw-w64-ucrt-x86_64-gcc"

if not exist "C:\msys64\ucrt64\bin\g++.exe" (
  echo.
  echo  L'installazione di gcc non e' riuscita.
  echo  Prova a mano: apri "MSYS2 UCRT64" dal menu Start e lancia
  echo     pacman -S mingw-w64-ucrt-x86_64-gcc
  echo.
  pause
  exit /b 1
)

echo.
echo  Compilatore pronto: C:\msys64\ucrt64\bin
set "PATH=C:\msys64\ucrt64\bin;%PATH%"
echo.

:build
call build.bat
