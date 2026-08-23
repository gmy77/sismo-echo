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
