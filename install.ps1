# Run from a clone: .\install.ps1  (local copy only, no download)
$ErrorActionPreference = "Stop"
$src = Join-Path $PSScriptRoot "extension\omo-where"
$agent = @($env:OMO_CODING_AGENT_DIR, $env:SENPI_CODING_AGENT_DIR, $env:PI_CODING_AGENT_DIR) | Where-Object { $_ } | Select-Object -First 1
if (-not $agent) { $agent = Join-Path $HOME ".omo\agent" }
if (-not (Test-Path $src)) { throw "missing $src" }
$ext = Join-Path $agent "extensions"
$dst = Join-Path $ext "omo-where"
$tmp = Join-Path $ext "omo-where.tmp-$PID"
New-Item -ItemType Directory -Force $ext | Out-Null
if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
Copy-Item $src $tmp -Recurse
if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
Rename-Item $tmp "omo-where"
Write-Host "installed -> $dst"
Write-Host "Type /reload in running omo sessions."
