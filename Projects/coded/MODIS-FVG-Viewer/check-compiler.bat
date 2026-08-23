@echo off
REM ===========================================================================
REM  MODIS FVG Viewer - diagnostica dell'ambiente di compilazione.
REM  Non installa e non modifica nulla: guarda e basta.
REM
REM  Se build.bat non trova il compilatore, lancia questo e incolla l'output:
REM  dice in un colpo solo cosa c'e' sulla macchina e cosa manca.
REM ===========================================================================
setlocal EnableDelayedExpansion
cd /d "%~dp0"

echo ============================================================
echo  DIAGNOSTICA COMPILATORE - MODIS FVG Viewer
echo ============================================================
echo.

echo [1] Compilatori nel PATH
echo ------------------------------------------------------------
where cl 2>nul       || echo    cl.exe   : NON nel PATH
where g++ 2>nul      || echo    g++.exe  : NON nel PATH
where windres 2>nul  || echo    windres  : NON nel PATH
where cmake 2>nul    || echo    cmake    : NON nel PATH
where winget 2>nul   || echo    winget   : NON nel PATH
echo.

echo [2] Visual Studio ^(via vswhere^)
echo ------------------------------------------------------------
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" set "VSWHERE=%ProgramFiles%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" (
  echo    vswhere non trovato: nessun Visual Studio 2017+ installato.
) else (
  echo    vswhere: %VSWHERE%
  echo.
  echo    -- Tutte le installazioni VS --
  "%VSWHERE%" -latest -products * -property installationPath 2>nul
  echo.
  echo    -- Installazioni CON i tool C++ x64 --
  set "VSPATH="
  for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2^>nul`) do set "VSPATH=%%i"
  if defined VSPATH (
    echo    !VSPATH!
    if exist "!VSPATH!\VC\Auxiliary\Build\vcvars64.bat" (
      echo    vcvars64.bat presente: build.bat lo carichera' da solo. OK
    ) else (
      echo    ATTENZIONE: vcvars64.bat NON trovato in questa installazione.
    )
  ) else (
    echo    NESSUNA. Visual Studio c'e' ma senza il workload C++.
    echo    Rimedio: Visual Studio Installer ^> Modifica ^>
    echo             "Sviluppo di applicazioni desktop con C++"
  )
)
echo.

echo [3] MinGW-w64 nelle posizioni note
echo ------------------------------------------------------------
set "FOUND="
for %%D in (
  "C:\msys64\ucrt64\bin"
  "C:\msys64\mingw64\bin"
  "C:\mingw64\bin"
  "C:\ProgramData\chocolatey\bin"
  "%ProgramFiles%\mingw64\bin"
) do (
  if exist "%%~D\g++.exe" ( echo    TROVATO: %%~D & set "FOUND=1" )
)
if exist "%LOCALAPPDATA%\Microsoft\WinGet\Packages" (
  for /d %%P in ("%LOCALAPPDATA%\Microsoft\WinGet\Packages\*") do (
    for %%S in ("mingw64\bin" "ucrt64\bin" "bin") do (
      if exist "%%~P\%%~S\g++.exe" ( echo    TROVATO: %%~P\%%~S & set "FOUND=1" )
    )
  )
)
if not defined FOUND echo    Nessun MinGW nelle posizioni note.
echo.

echo [4] Esito
echo ------------------------------------------------------------
where cl >nul 2>nul  && ( echo    OK: cl.exe utilizzabile subito.        & goto :fine )
where g++ >nul 2>nul && ( echo    OK: g++.exe utilizzabile subito.       & goto :fine )
if defined VSPATH    ( echo    OK: build.bat carichera' Visual Studio.   & goto :fine )
if defined FOUND     ( echo    OK: build.bat usera' il MinGW trovato.    & goto :fine )
echo    Nessun compilatore utilizzabile.
echo    Lancia setup-compiler.bat per installarne uno.

:fine
echo.
echo ============================================================
pause
