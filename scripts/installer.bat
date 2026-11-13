@echo off
setlocal EnableExtensions
chcp 65001 >nul
title Doublage vocal local - installation
cd /d "%~dp0\.."

echo ==========================================================
echo   Doublage vocal local (anglais vers francais)
echo   Installation du serveur local
echo ==========================================================
echo.
echo Cette installation va :
echo   1. creer un environnement Python isole dans server\.venv
echo   2. installer les bibliotheques necessaires (environ 550 Mo)
echo   3. telecharger les modeles d'IA choisis (voir ci-dessous)
echo.
echo Tout reste sur ce PC. Aucun abonnement, aucune cle d'API.
echo.

call :trouver_python
if errorlevel 1 goto :fin_erreur

echo [1/4] Python detecte : %PY_DESC%
echo.

echo [2/4] Creation de l'environnement Python (server\.venv)...
if exist "server\.venv\Scripts\python.exe" (
    echo       Environnement deja present : reutilise.
) else (
    %PY_CMD% -m venv "server\.venv"
    if errorlevel 1 (
        echo.
        echo ERREUR : impossible de creer l'environnement Python.
        echo Verifiez que Python est complet ^(module "venv" inclus^).
        goto :fin_erreur
    )
)
set "VENV_PY=%CD%\server\.venv\Scripts\python.exe"
echo.

echo [3/4] Installation des bibliotheques...
"%VENV_PY%" -m pip install --upgrade pip --quiet
"%VENV_PY%" -m pip install -r "server\requirements.txt"
if errorlevel 1 (
    echo.
    echo ERREUR : l'installation des bibliotheques a echoue.
    echo Causes frequentes : pas de connexion Internet, ou un proxy d'entreprise.
    echo Consultez docs\depannage.md.
    goto :fin_erreur
)
echo.

echo [4/4] Choix du profil et telechargement des modeles
echo.
echo   1. prudent    ^(recommande au depart^) Whisper base.en + OPUS-MT      ~360 Mo
echo   2. equilibre  Whisper small.en + OPUS-MT                            ~700 Mo
echo   3. qualite    Whisper small.en + OPUS-MT tc-big                     ~790 Mo
echo.
set "PROFIL=prudent"
set /p CHOIX="Votre choix [1-3, Entree = 1] : "
if "%CHOIX%"=="2" set "PROFIL=equilibre"
if "%CHOIX%"=="3" set "PROFIL=qualite"
echo.
echo Profil retenu : %PROFIL%
echo Telechargement depuis huggingface.co ^(verification SHA-256^)...
echo.

pushd server
"%VENV_PY%" -m vt_server --download-only --profile %PROFIL%
set "RC=%ERRORLEVEL%"
popd
if not "%RC%"=="0" (
    echo.
    echo ERREUR : le telechargement des modeles a echoue.
    echo Relancez ce script : les fichiers deja recus sont conserves.
    goto :fin_erreur
)

> "server\config.json" echo {
>> "server\config.json" echo   "profile": "%PROFIL%"
>> "server\config.json" echo }

echo.
echo ==========================================================
echo   Installation terminee.
echo.
echo   Etape suivante :
echo     1. lancez scripts\demarrer-serveur.bat ^(laissez la fenetre ouverte^)
echo     2. chargez l'extension dans Chrome : voir docs\installation.md
echo ==========================================================
echo.
pause
exit /b 0

:trouver_python
set "PY_CMD="
for %%V in (3.13 3.12 3.11) do (
    if not defined PY_CMD (
        py -%%V -c "import sys" >nul 2>&1 && set "PY_CMD=py -%%V" && set "PY_DESC=Python %%V (lanceur py)"
    )
)
if not defined PY_CMD (
    python -c "import sys; raise SystemExit(0 if (3,11) <= sys.version_info < (3,14) else 1)" >nul 2>&1 ^
        && set "PY_CMD=python" && set "PY_DESC=python (dans le PATH)"
)
if not defined PY_CMD (
    echo.
    echo ERREUR : aucun Python 3.11, 3.12 ou 3.13 ^(64 bits^) n'a ete trouve.
    echo.
    echo Installez Python depuis https://www.python.org/downloads/windows/
    echo en cochant "Add python.exe to PATH" pendant l'installation,
    echo puis relancez ce script.
    exit /b 1
)
exit /b 0

:fin_erreur
echo.
pause
exit /b 1
