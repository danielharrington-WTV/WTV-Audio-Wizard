$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
# Environments and data live in <workspace>\work. The workspace is WTV_WORKSPACE if set,
# otherwise the nearest folder above this one that has work\service-env (so this folder
# can sit beside the plugin or inside it), otherwise two folders up. Same rule as
# service\workspace.py, which the service itself uses for its data folder.
$workspaceRoot = $env:WTV_WORKSPACE
if (-not $workspaceRoot) {
  $folder = Split-Path $projectRoot -Parent
  while ($folder) {
    if (Test-Path -LiteralPath (Join-Path $folder 'work\service-env\Scripts\python.exe')) { $workspaceRoot = $folder; break }
    $parent = Split-Path $folder -Parent
    if ($parent -eq $folder) { break }
    $folder = $parent
  }
}
if (-not $workspaceRoot) { $workspaceRoot = Split-Path (Split-Path $projectRoot -Parent) -Parent }
$servicePython = Join-Path $workspaceRoot 'work\service-env\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $servicePython)) { throw "Service environment not found at $servicePython. See README.md." }
# Pass the choice on, so the service's data folder and pairing token come from the same workspace.
$env:WTV_WORKSPACE = $workspaceRoot
Write-Host "Workspace: $workspaceRoot"
Set-Location -LiteralPath $projectRoot
& $servicePython -c "from service.app import TOKEN; print('Panel token: ' + TOKEN)"
& $servicePython -m uvicorn service.app:app --host 127.0.0.1 --port 8756 --workers 1
