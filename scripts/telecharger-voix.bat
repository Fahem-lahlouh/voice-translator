@echo off
setlocal EnableExtensions
chcp 65001 >nul
title Doublage vocal local - voix francaises
cd /d "%~dp0\.."

if not exist "server\.venv\Scripts\python.exe" (
    echo ERREUR : lancez d'abord scripts\installer.bat
    echo.
    pause
    exit /b 1
)

echo Telechargement de toutes les voix francaises disponibles
echo   - siwis  ^(feminine, CC-BY 4.0^)        ~63 Mo
echo   - upmc   ^(Jessica et Pierre, CC-BY-SA 4.0^) ~77 Mo
echo.

pushd server
".venv\Scripts\python.exe" -m vt_server --download-only --all-voices
popd

echo.
pause
