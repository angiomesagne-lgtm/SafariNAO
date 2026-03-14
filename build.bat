@echo off
cd /d "%~dp0"
echo [1/2] Build app...
call npm install
call npx electron-forge package
echo.
echo [2/2] Creazione SafariNAO-Installer.exe...
where makensis >nul 2>&1
if %errorlevel% neq 0 (
    echo NSIS non trovato. Scaricalo da https://nsis.sourceforge.io
    echo Poi riesegui questo file.
    pause
    exit /b 1
)
makensis installer.nsi
echo.
echo SafariNAO-Installer.exe pronto!
pause
