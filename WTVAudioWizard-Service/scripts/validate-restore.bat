@echo off
rem One-off check of Restore Speech's service path on this GPU. Safe while the service runs.
cd /d "%~dp0.."
set "WS=%WTV_WORKSPACE%"
if not defined WS set "WS=%~dp0..\..\.."
set "PY=%WS%\work\service-env\Scripts\python.exe"
"%PY%" scripts\validate_restore.py %*
pause
