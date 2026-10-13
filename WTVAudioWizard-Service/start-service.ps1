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
# Pass the choice on, so the service's data folder comes from the same workspace.
$env:WTV_WORKSPACE = $workspaceRoot
# Listening address: WTV_HOST if set, otherwise 127.0.0.1 (this computer only).
# Set it to this PC's LAN IPv4 address to serve other machines. No pairing token:
# the service accepts only loopback and private-LAN clients.
$listenHost = if ($env:WTV_HOST) { $env:WTV_HOST } else { '127.0.0.1' }
if ($listenHost -notmatch '^\d{1,3}(\.\d{1,3}){3}$') { throw "WTV_HOST must be an IPv4 address (got '$listenHost')." }
Write-Host "Workspace: $workspaceRoot"
Write-Host "Service URL for the panel: http://${listenHost}:8756 (no token needed)"
Set-Location -LiteralPath $projectRoot
& $servicePython -m uvicorn service.app:app --host $listenHost --port 8756 --workers 1 --no-proxy-headers
