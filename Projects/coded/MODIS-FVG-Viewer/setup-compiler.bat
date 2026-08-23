@echo off
REM ===========================================================================
REM  MODIS FVG Viewer - installa un compilatore C++ e compila, in un colpo solo.
REM
REM  Doppio-click e basta. Lo script:
REM    1. controlla se un compilatore c'e' gia' (MSVC o MinGW) -> compila
REM    2. altrimenti installa MinGW-w64 con winget (incluso in Windows 10/11)
REM    3. aggiorna il PATH di questa sessione e lancia build.bat
REM
REM  MinGW-w64 e' ~500 MB contro i ~6 GB dei Build Tools di Visual Studio, non
REM  tocca le installazioni esistenti e basta e avanza per questo progetto.
REM ===========================================================================
setlocal EnableDelayedExpansion
cd /d "%~dp0"

echo.
echo  === MODIS FVG Viewer - preparazione compilatore ===
echo.

REM --- 1. gia' presente? -----------------------------------------------------
where cl >nul 2>nul  && echo  Trovato MSVC (cl.exe).  && goto :build
where g++ >nul 2>nul && echo  Trovato MinGW (g++).    && goto :build

REM --- 2. winget disponibile? ------------------------------------------------
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

echo  Nessun compilatore trovato: installo MinGW-w64 con winget.
echo  (una tantum, qualche minuto; puo' chiedere conferma UAC)
echo.

REM WinLibs = build standalone di MinGW-w64, senza ambiente MSYS2 da gestire.
set "PKG=BrechtSanders.WinLibs.POSIX.UCRT.LLVM"
winget install -e --id %PKG% --accept-package-agreements --accept-source-agreements
if %errorlevel% neq 0 (
  echo.
  echo  Provo il pacchetto alternativo senza LLVM...
  set "PKG=BrechtSanders.WinLibs.POSIX.UCRT"
  winget install -e --id !PKG! --accept-package-agreements --accept-source-agreements
)

REM --- 3. rendi g++ visibile SUBITO, senza riavviare il terminale -------------
REM winget aggiorna il PATH di sistema, ma non quello di questo processo.
for /f "usebackq tokens=2,*" %%A in (`reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul`) do set "SYSPATH=%%B"
for /f "usebackq tokens=2,*" %%A in (`reg query "HKCU\Environment" /v Path 2^>nul`) do set "USRPATH=%%B"
set "PATH=%SYSPATH%;%USRPATH%;%PATH%"

where g++ >nul 2>nul
if %errorlevel% neq 0 (
  echo.
  echo  Installazione completata, ma g++ non e' ancora nel PATH di questa finestra.
  echo  CHIUDI questa finestra, aprine una nuova e lancia build.bat: funzionera'.
  echo.
  pause
  exit /b 0
)

echo.
echo  Compilatore pronto.
echo.

:build
call build.bat
