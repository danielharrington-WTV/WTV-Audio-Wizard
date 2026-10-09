@echo off
setlocal
rem One-off check of Rebuild Speech's service path on this GPU. Safe while the service runs.
rem Finds the workspace like start-service.ps1: WTV_WORKSPACE, else the nearest folder
rem above the service folder that has work\service-env.
cd /d "%~dp0.."
set "WS=%WTV_WORKSPACE%"
if not defined WS for %%D in ("%~dp0..\.." "%~dp0..\..\.." "%~dp0..\..\..\.." "%~dp0..\..\..\..\..") do (
  if not defined WS if exist "%%~fD\work\service-env\Scripts\python.exe" set "WS=%%~fD"
)
if not defined WS (
  echo Service environment not found. Set WTV_WORKSPACE to the folder that contains work\service-env.
  pause
  exit /b 1
)
set "WTV_WORKSPACE=%WS%"
"%WS%\work\service-env\Scripts\python.exe" scripts\validate_restore.py %*
pause
