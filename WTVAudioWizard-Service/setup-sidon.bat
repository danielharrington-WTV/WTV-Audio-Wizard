@echo off
setlocal
rem Installs Sidon (Restore Speech) for the WTVAudioWizard service. Needs an NVIDIA GPU.
rem Safe to run again. Afterwards restart the service and reconnect the panel.
cd /d "%~dp0"
set "PY="
for %%V in (3.12 3.11 3.10 3.13) do (
  if not defined PY (
    py -%%V -c "import sys" >nul 2>&1 && set "PY=py -%%V"
  )
)
if not defined PY (
  python -c "import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)" >nul 2>&1 && set "PY=python"
)
if not defined PY (
  echo Python 3.10 - 3.13 was not found. Install it from https://www.python.org/downloads/ and run this again.
  pause
  exit /b 1
)
%PY% "%~dp0scripts\setup_sidon.py" %*
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" (echo Sidon is installed. Restart the service, then click Connect in the panel.) else (echo Setup did not finish - see the messages above.)
pause
exit /b %RC%
