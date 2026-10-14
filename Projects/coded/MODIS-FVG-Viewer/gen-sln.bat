@echo off
REM ===========================================================================
REM  Genera la soluzione Visual Studio (MODIS-FVG-Viewer.sln) con CMake.
REM  Per chi preferisce il flusso classico col .SLN invece di "Apri cartella".
REM
REM  Doppio-click, oppure lancialo dal "Developer Command Prompt for VS".
REM  Richiede cmake nel PATH.
REM ===========================================================================
setlocal
cd /d "%~dp0"

where cmake >nul 2>nul
if %errorlevel% neq 0 (
    echo.
    echo  'cmake' non trovato nel PATH.
    echo  Lancia questo file dal "Developer Command Prompt for VS",
    echo  oppure installa CMake ^(https://cmake.org/download^).
    echo.
    pause
    exit /b 1
)

echo Genero la soluzione Visual Studio ^(x64^)...
cmake -B build -A x64
if %errorlevel% neq 0 ( echo Errore nella generazione. & pause & exit /b 1 )

echo.
echo  Fatto!  Apri:  build\MODIS-FVG-Viewer.sln
echo  (in VS scegli la configurazione Release, poi premi Avvia)
echo.
pause
