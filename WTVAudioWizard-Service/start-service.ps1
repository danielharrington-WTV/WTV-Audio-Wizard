$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
# Environments and data live in <workspace>\work. Default: two folders above this one;
# set WTV_WORKSPACE to keep them somewhere else.
$workspaceRoot = if ($env:WTV_WORKSPACE) { $env:WTV_WORKSPACE } else { Split-Path (Split-Path $projectRoot -Parent) -Parent }
$servicePython = Join-Path $workspaceRoot 'work\service-env\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $servicePython)) { throw "Service environment not found at $servicePython. See README.md." }
Set-Location -LiteralPath $projectRoot
& $servicePython -c "from service.app import TOKEN; print('Panel token: ' + TOKEN)"
& $servicePython -m uvicorn service.app:app --host 127.0.0.1 --port 8756 --workers 1
