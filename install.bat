@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul 2>&1
title SafariNAO — Installer

:: ═══════════════════════════════════════════════════════════════
::  SafariNAO Installer
::  Installa dipendenze, compila l'exe, avvia l'app,
::  crea scorciatoia sul Desktop.
:: ═══════════════════════════════════════════════════════════════

set "PROJ_DIR=%~dp0"
set "PROJ_DIR=%PROJ_DIR:~0,-1%"
set "EXE_NAME=SafariNAO.exe"
set "SHORTCUT_NAME=SafariNAO"
set "OUT_DIR=%PROJ_DIR%\out\SafariNAO-win32-x64"
set "EXE_PATH=%OUT_DIR%\%EXE_NAME%"

echo.
echo  ╔══════════════════════════════════════════════╗
echo  ║         SafariNAO  —  Installer              ║
echo  ║     Fast · Private · Ad-Free Browser         ║
echo  ╚══════════════════════════════════════════════╝
echo.

:: ── 1. Controlla se siamo nella cartella giusta ─────────────
if not exist "%PROJ_DIR%\package.json" (
    echo  [ERRORE] package.json non trovato.
    echo  Assicurati di aver messo questo file nella
    echo  stessa cartella del progetto SafariNAO.
    echo.
    pause
    exit /b 1
)

:: ── 2. Controlla Node.js ─────────────────────────────────────
echo  [1/6] Verifica Node.js...
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo  [!] Node.js non trovato. Apertura pagina download...
    echo      Installa Node.js LTS da: https://nodejs.org
    echo      Poi riavvia questo installer.
    echo.
    start https://nodejs.org/en/download
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version 2^>nul') do set NODE_VER=%%v
echo      Node.js %NODE_VER% trovato.

:: ── 3. Controlla npm ─────────────────────────────────────────
where npm >nul 2>&1
if %errorlevel% neq 0 (
    echo  [ERRORE] npm non trovato. Reinstalla Node.js.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('npm --version 2^>nul') do set NPM_VER=%%v
echo      npm %NPM_VER% trovato.

:: ── 4. Installa dipendenze npm ───────────────────────────────
echo.
echo  [2/6] Installazione dipendenze npm...
cd /d "%PROJ_DIR%"

if exist "%PROJ_DIR%\node_modules" (
    echo      node_modules esistente — aggiornamento...
    call npm install --prefer-offline 2>&1
) else (
    echo      Prima installazione — potrebbe richiedere alcuni minuti...
    call npm install 2>&1
)

if %errorlevel% neq 0 (
    echo.
    echo  [ERRORE] npm install fallito. Controlla la connessione internet.
    pause
    exit /b 1
)
echo      Dipendenze installate con successo.

:: ── 5. Verifica electron-forge ───────────────────────────────
echo.
echo  [3/6] Verifica electron-forge...
if not exist "%PROJ_DIR%\node_modules\.bin\electron-forge.cmd" (
    if not exist "%PROJ_DIR%\node_modules\.bin\electron-forge" (
        echo      electron-forge non trovato, installazione...
        call npm install --save-dev @electron-forge/cli 2>&1
    )
)
echo      electron-forge pronto.

:: ── 6. Build dell'applicazione ───────────────────────────────
echo.
echo  [4/6] Compilazione SafariNAO...
echo      (questa operazione richiede 1-3 minuti la prima volta)
echo.

cd /d "%PROJ_DIR%"
call npx electron-forge package 2>&1

if %errorlevel% neq 0 (
    echo.
    echo  [ERRORE] Build fallita.
    echo  Dettagli sopra. Prova a cancellare node_modules
    echo  ed eseguire di nuovo l'installer.
    echo.
    pause
    exit /b 1
)

:: Cerca l'exe nella cartella out (electron-forge può cambiare il path)
if not exist "%EXE_PATH%" (
    echo  Ricerca SafariNAO.exe in out\...
    for /r "%PROJ_DIR%\out" %%f in (%EXE_NAME%) do (
        set "EXE_PATH=%%f"
        set "OUT_DIR=%%~dpf"
        set "OUT_DIR=!OUT_DIR:~0,-1!"
    )
)

if not exist "%EXE_PATH%" (
    echo  [ERRORE] SafariNAO.exe non trovato dopo la build.
    echo  Controlla la cartella: %PROJ_DIR%\out
    pause
    exit /b 1
)

echo      Build completata: %EXE_PATH%

:: ── 7. Crea scorciatoia sul Desktop ─────────────────────────
echo.
echo  [5/6] Creazione scorciatoia sul Desktop...

set "DESKTOP=%USERPROFILE%\Desktop"
set "SHORTCUT_PATH=%DESKTOP%\%SHORTCUT_NAME%.lnk"

:: Usa PowerShell per creare la scorciatoia .lnk
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ws = New-Object -ComObject WScript.Shell; ^
   $s = $ws.CreateShortcut('%SHORTCUT_PATH%'); ^
   $s.TargetPath = '%EXE_PATH%'; ^
   $s.WorkingDirectory = '%OUT_DIR%'; ^
   $s.Description = 'SafariNAO Browser - Fast, Private, Ad-Free'; ^
   $s.IconLocation = '%EXE_PATH%,0'; ^
   $s.Save()" 2>&1

if exist "%SHORTCUT_PATH%" (
    echo      Scorciatoia creata: %SHORTCUT_PATH%
) else (
    echo  [!] Scorciatoia non creata ^(permessi Desktop?^)
    echo      Puoi avviare SafariNAO da: %EXE_PATH%
)

:: ── 8. Avvia l'applicazione ──────────────────────────────────
echo.
echo  [6/6] Avvio SafariNAO...
echo.
echo  ╔══════════════════════════════════════════════╗
echo  ║  ✓  Installazione completata!                ║
echo  ║                                              ║
echo  ║  Scorciatoia: Desktop\SafariNAO              ║
echo  ║  Eseguibile:  out\SafariNAO-win32-x64\       ║
echo  ╚══════════════════════════════════════════════╝
echo.

start "" "%EXE_PATH%"

echo  SafariNAO avviato. Puoi chiudere questa finestra.
echo.
timeout /t 3 /nobreak >nul
exit /b 0
