@echo off
setlocal EnableExtensions
chcp 65001 >nul
title Doublage vocal local - mesure du PC
cd /d "%~dp0\.."

if not exist "server\.venv\Scripts\python.exe" (
    echo ERREUR : lancez d'abord scripts\installer.bat
    echo.
    pause
    exit /b 1
)

echo ==========================================================
echo   Caracteristiques de ce PC
echo ==========================================================
echo.
echo Processeur :
wmic cpu get Name,NumberOfCores,NumberOfLogicalProcessors /format:list 2>nul | findstr "=" || ^
  powershell -NoProfile -Command "Get-CimInstance Win32_Processor | Select-Object Name,NumberOfCores,NumberOfLogicalProcessors | Format-List"
echo.
echo Memoire vive installee :
powershell -NoProfile -Command "'{0:N1} Go' -f ((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory/1GB)"
echo.
echo Espace disque libre sur ce lecteur :
powershell -NoProfile -Command "$d=Get-PSDrive ((Get-Location).Drive.Name); '{0:N1} Go libres' -f ($d.Free/1GB)"
echo.
echo Carte graphique :
powershell -NoProfile -Command "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name"
echo.
echo ==========================================================
echo   Mesure des moteurs installes (quelques minutes)
echo ==========================================================
echo.

pushd server
".venv\Scripts\python.exe" -m vt_server --bench
popd

echo.
pause
