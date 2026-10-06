@echo off
setlocal
rem GAP-URGENet GPU test - double-click, or run from a terminal with extra options, e.g.
rem   run_gpu_test.bat --from-dir "D:\GAP-URGENet\checkpoints"
rem   run_gpu_test.bat --seconds 1 --channels 1
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
  echo.
  echo Python 3.10 - 3.13 was not found.
  echo Install it from https://www.python.org/downloads/ ^(tick "Add python.exe to PATH"^) and run this again.
  echo.
  pause
  exit /b 1
)

%PY% "%~dp0gpu_test.py" %*
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" (echo Done. Your results JSON is in the "results" folder.) else (echo The test did not finish - see the messages above.)
pause
exit /b %RC%
