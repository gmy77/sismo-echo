@echo off
REM ===========================================================================
REM  FVG GRIB Monitor - build su Windows.
REM  Doppio-click, oppure eseguilo da un prompt dei comandi.
REM  Prova prima MSVC (cl.exe, se hai Visual Studio), poi MinGW (g++).
REM ===========================================================================
setlocal
cd /d "%~dp0"

where cl >nul 2>nul
if %errorlevel%==0 goto :msvc

where g++ >nul 2>nul
if %errorlevel%==0 goto :mingw

echo.
echo  Nessun compilatore trovato.
echo  Installa UNA di queste opzioni:
echo    - Visual Studio (Desktop C++)  ->  apri "x64 Native Tools Command Prompt" e rilancia build.bat
echo    - MSYS2/MinGW-w64              ->  pacman -S mingw-w64-x86_64-gcc, poi rilancia
echo.
pause
exit /b 1

:msvc
echo [MSVC] Compilazione in corso...
rc /nologo /fo src\app.res src\app.rc
cl /nologo /EHsc /O2 /std:c++17 /DUNICODE /D_UNICODE ^
   src\app.cpp src\grib2.cpp src\net.cpp src\app.res ^
   /Fe:FVG-GribMonitor.exe ^
   /link /SUBSYSTEM:WINDOWS gdiplus.lib comctl32.lib comdlg32.lib winhttp.lib shell32.lib gdi32.lib user32.lib ole32.lib
if %errorlevel% neq 0 ( echo Errore di compilazione. & pause & exit /b 1 )
del /q *.obj src\app.res 2>nul
goto :done

:mingw
echo [MinGW] Compilazione in corso...
windres src\app.rc -O coff -o src\app.res.o
g++ -std=c++17 -O2 -municode -mwindows -static -static-libgcc -static-libstdc++ ^
    src\app.cpp src\grib2.cpp src\net.cpp src\app.res.o ^
    -o FVG-GribMonitor.exe ^
    -lgdiplus -lcomctl32 -lcomdlg32 -lwinhttp -lshell32 -lgdi32 -luser32 -lole32
if %errorlevel% neq 0 ( echo Errore di compilazione. & pause & exit /b 1 )
del /q src\app.res.o 2>nul
goto :done

:done
copy /y test\sample_FVG_CAPE.grib2 sample_FVG_CAPE.grib2 >nul 2>nul
echo.
echo  Fatto!  ->  FVG-GribMonitor.exe
echo  (config.ini e sample_FVG_CAPE.grib2 sono accanto all'eseguibile)
echo.
pause
