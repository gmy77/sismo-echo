@echo off
REM ===========================================================================
REM  MODIS FVG Viewer - build su Windows.
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
windres src\app.rc -O coff -o src\app.res.o
g++ -std=c++17 -O2 -municode -mwindows -static -static-libgcc -static-libstdc++ ^
    src\app.cpp src\modis.cpp src\image.cpp src\gibs.cpp src\mf_encoder.cpp src\app.res.o ^
    -o MODIS-FVG-Viewer.exe ^
    -lgdiplus -lcomctl32 -lcomdlg32 -ldwmapi -lwinhttp -lshlwapi ^
    -lmfplat -lmfreadwrite -lmfuuid -lole32 -luuid -lgdi32 -luser32 -lshell32
if %errorlevel% neq 0 ( echo Errore di compilazione. & pause & exit /b 1 )
del /q src\app.res.o 2>nul
goto :done

:done
copy /y test\sample_MODIS_FVG.mgr      sample_MODIS_FVG.mgr      >nul 2>nul
copy /y test\sample_MODIS_FVG_1200.mgr sample_MODIS_FVG_1200.mgr >nul 2>nul
copy /y test\sample_MODIS_FVG_1345.mgr sample_MODIS_FVG_1345.mgr >nul 2>nul
echo.
echo  Fatto!  ->  MODIS-FVG-Viewer.exe
echo  (i 3 granuli di esempio .mgr sono accanto all'eseguibile)
echo.
pause
