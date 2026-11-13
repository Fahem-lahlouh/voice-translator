@echo off
setlocal EnableExtensions
chcp 65001 >nul
title Doublage vocal local - tests
cd /d "%~dp0\.."

if not exist "server\.venv\Scripts\python.exe" (
    echo ERREUR : lancez d'abord scripts\installer.bat
    echo.
    pause
    exit /b 1
)
set "VENV_PY=%CD%\server\.venv\Scripts\python.exe"

echo ==========================================================
echo   1. Tests unitaires du serveur
echo ==========================================================
echo.
pushd server
"%VENV_PY%" -m unittest discover -s tests -t . -v
set "RC1=%ERRORLEVEL%"
popd

echo.
echo ==========================================================
echo   2. Chaine complete hors navigateur
echo      (extrait anglais -^> transcription -^> traduction -^> voix)
echo ==========================================================
echo.
if not exist "test\out" mkdir "test\out"
pushd server
"%VENV_PY%" -m vt_server --self-test "..\test\audio\tibco_demo_en.ogg" --out "..\test\out\voix-francaise.wav"
set "RC2=%ERRORLEVEL%"
popd

echo.
echo ==========================================================
if "%RC1%"=="0" (echo   Tests unitaires : OK) else (echo   Tests unitaires : ECHEC)
if "%RC2%"=="0" (echo   Chaine complete : OK) else (echo   Chaine complete : ECHEC)
echo.
echo   Ecoutez test\out\voix-francaise.wav pour juger la voix.
echo ==========================================================
echo.
echo Les tests dans un vrai navigateur (test\browser) demandent un
echo environnement Linux avec un affichage X : voir docs\tests.md.
echo Sur Windows, utilisez la procedure manuelle de docs\udemy.md.
echo.
pause
