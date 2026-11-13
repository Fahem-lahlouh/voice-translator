@echo off
setlocal EnableExtensions
chcp 65001 >nul
title Doublage vocal local - serveur (laisser ouvert)
cd /d "%~dp0\.."

if not exist "server\.venv\Scripts\python.exe" (
    echo ERREUR : le serveur n'est pas installe.
    echo Lancez d'abord scripts\installer.bat
    echo.
    pause
    exit /b 1
)

echo Demarrage du serveur local de doublage...
echo Laissez cette fenetre ouverte pendant toute la formation.
echo Fermer cette fenetre ^(ou Ctrl+C^) arrete la traduction.
echo.

pushd server
".venv\Scripts\python.exe" -m vt_server %*
set "RC=%ERRORLEVEL%"
popd

if not "%RC%"=="0" (
    echo.
    echo Le serveur s'est arrete avec le code %RC%.
    echo Consultez docs\depannage.md.
    echo.
    pause
)
exit /b %RC%
