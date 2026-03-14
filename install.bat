@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul 2>&1

:: Forza apertura in una nuova finestra cmd che resta aperta
:: Se viene eseguito con doppio click (no argomento), si rilancia in una nuova finestra
if "%~1"=="" (
    start "SafariNAO Installer" cmd /k ""%~f0" RUNNING & echo. & echo Premi un tasto per chiudere... & pause >nul"
    exit /b
)

title SafariNAO — Installer
color 0F

echo.
echo  =====================================================
echo   SafariNAO  -  Installer
echo   Fast . Private . Ad-Free Browser
echo  =====================================================
echo.
echo  Cartella progetto: %~dp0
echo.

cd /d "%~dp0"

:: ── Controlla package.json ────────────────────────────────────
if not exist "package.json" (
    echo  [ERRORE] package.json non trovato!
    echo.
    echo  Assicurati che install.bat sia nella stessa cartella
    echo  del progetto ^(dove ci sono main.js, index.html, ecc.^)
    echo.
    pause
    exit /b 1
)
echo  [OK] package.json trovato.

:: ── Controlla Node.js ─────────────────────────────────────────
echo  [..] Controllo Node.js...
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo  [ERRORE] Node.js non e' installato!
    echo.
    echo  1. Vai su: https://nodejs.org
    echo  2. Scarica la versione LTS
    echo  3. Installala con le opzioni di default
    echo  4. Riapri install.bat
    echo.
    start https://nodejs.org/en/download
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version 2^>nul') do set "NODE_VER=%%v"
echo  [OK] Node.js %NODE_VER%

:: ── Controlla npm ─────────────────────────────────────────────
where npm >nul 2>&1
if %errorlevel% neq 0 (
    echo  [ERRORE] npm non trovato. Reinstalla Node.js.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('npm --version 2^>nul') do set "NPM_VER=%%v"
echo  [OK] npm %NPM_VER%
echo.

:: ── npm install ───────────────────────────────────────────────
echo  [1/4] Installazione dipendenze npm...
echo        (potrebbe richiedere qualche minuto)
echo.

if exist "node_modules" (
    echo        node_modules gia' presente, aggiornamento...
)

call npm install
set "NPM_ERR=%errorlevel%"
if %NPM_ERR% neq 0 (
    echo.
    echo  [ERRORE] npm install fallito ^(codice: %NPM_ERR%^)
    echo.
    echo  Possibili cause:
    echo  - Nessuna connessione internet
    echo  - Permessi insufficienti ^(prova "Esegui come amministratore"^)
    echo  - Cartella node_modules corrotta ^(cancellala e riprova^)
    echo.
    pause
    exit /b 1
)
echo.
echo  [OK] Dipendenze installate.
echo.

:: ── Build con electron-forge ──────────────────────────────────
echo  [2/4] Compilazione SafariNAO.exe...
echo        ^(la prima volta ci vogliono 2-5 minuti^)
echo.

call npx electron-forge package
set "FORGE_ERR=%errorlevel%"
if %FORGE_ERR% neq 0 (
    echo.
    echo  [ERRORE] Build fallita ^(codice: %FORGE_ERR%^)
    echo.
    echo  Prova:
    echo  1. Cancella la cartella "out" se esiste
    echo  2. Cancella "node_modules" e riesegui
    echo  3. Esegui come amministratore
    echo.
    pause
    exit /b 1
)
echo.
echo  [OK] Build completata.
echo.

:: ── Trova l'exe ───────────────────────────────────────────────
echo  [3/4] Ricerca SafariNAO.exe...

set "EXE_PATH="
for /r "%~dp0out" %%f in (SafariNAO.exe) do (
    if not defined EXE_PATH (
        set "EXE_PATH=%%f"
        set "EXE_DIR=%%~dpf"
    )
)

:: Rimuovi backslash finale da EXE_DIR
if defined EXE_DIR (
    set "EXE_DIR=!EXE_DIR:~0,-1!"
)

if not defined EXE_PATH (
    echo  [ERRORE] SafariNAO.exe non trovato nella cartella out\
    echo.
    echo  Controlla manualmente: %~dp0out\
    pause
    exit /b 1
)
echo  [OK] Trovato: !EXE_PATH!
echo.

:: ── Scorciatoia Desktop ───────────────────────────────────────
echo  [4/4] Creazione scorciatoia Desktop...

set "DESKTOP=%USERPROFILE%\Desktop"
set "LNK=%DESKTOP%\SafariNAO.lnk"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut('!LNK!'); $s.TargetPath = '!EXE_PATH!'; $s.WorkingDirectory = '!EXE_DIR!'; $s.Description = 'SafariNAO Browser'; $s.IconLocation = '!EXE_PATH!,0'; $s.Save()" 2>nul

if exist "!LNK!" (
    echo  [OK] Scorciatoia creata sul Desktop.
) else (
    echo  [!] Scorciatoia non creata ^(problema permessi Desktop^)
    echo      Puoi avviare l'app da: !EXE_PATH!
)
echo.

:: ── Riepilogo e avvio ─────────────────────────────────────────
echo  =====================================================
echo   Installazione completata con successo!
echo  =====================================================
echo.
echo   Exe:          !EXE_PATH!
echo   Desktop:      %DESKTOP%\SafariNAO.lnk
echo.
echo  Avvio SafariNAO in corso...
echo.

start "" "!EXE_PATH!"

echo  Fatto! Puoi chiudere questa finestra.
echo.
pause
exit /b 0
