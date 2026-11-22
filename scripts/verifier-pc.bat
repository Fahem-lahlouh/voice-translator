@echo off
setlocal EnableExtensions
chcp 65001 >nul
title Doublage vocal local - verification complete du PC
cd /d "%~dp0\.."

if not exist "server\.venv\Scripts\python.exe" (
    echo ERREUR : lancez d'abord scripts\installer.bat
    echo.
    pause
    exit /b 1
)

echo ==========================================================
echo   Verification complete de ce PC (10 a 20 minutes)
echo.
echo   Fermez la fenetre du serveur pendant la mesure si elle
echo   est ouverte : les chiffres seront plus justes.
echo   A la fin, envoyez le fichier rapport-pc.txt (il s'ouvre
echo   tout seul). Il ne contient ni votre nom ni vos dossiers.
echo ==========================================================
echo.

set "PYTHONIOENCODING=utf-8"
pushd server
".venv\Scripts\python.exe" -m vt_server --diagnostic "..\rapport-pc.txt"
popd

if exist "rapport-pc.txt" start "" notepad "rapport-pc.txt"
echo.
pause
