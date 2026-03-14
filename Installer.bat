@echo off
title SafariNAO - Installer & Builder
echo ======================================================
echo           SafariNAO: PROUDLY ITALIAN BROWSER
echo ======================================================
echo.

:: 1. Installazione librerie
echo [1/4] Installazione delle dipendenze (node_modules)...
call npm install
if %errorlevel% neq 0 (
    echo Errore durante npm install. Assicurati di avere Node.js installato!
    pause
    exit /b
)

:: 2. Creazione dell'eseguibile (.exe)
echo [2/4] Compilazione in corso (npm run make)...
echo Questo potrebbe richiedere un minuto...
call npm run make
if %errorlevel% neq 0 (
    echo Errore durante la creazione dell'eseguibile.
    pause
    exit /b
)

:: 3. Creazione scorciatoia sul Desktop via PowerShell
echo [3/4] Creazione scorciatoia sul desktop...
set "EXE_PATH=%~dp0out\safarinao-win32-x64\safarinao.exe"
set "SHORTCUT=%userprofile%\Desktop\SafariNAO.lnk"

powershell -Command "$s=(New-Object -COM WScript.Shell).CreateShortcut('%SHORTCUT%');$s.TargetPath='%EXE_PATH%';$s.Save()"

:: 4. Apertura per la prima volta
echo [4/4] Avvio di SafariNAO in corso...
start "" "%EXE_PATH%"

echo.
echo ======================================================
echo     INSTALLAZIONE COMPLETATA CON SUCCESSO!
echo   Puoi trovare SafariNAO sul tuo Desktop.
echo ======================================================
pause