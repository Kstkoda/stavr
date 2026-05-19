# v0.7 Phase 10a — spin-peer.ps1
#
# Convenience wrapper that starts a second stavR daemon instance with
# its own STAVR_HOME + port + peer id. Use it manually when you want
# to keep the second instance running interactively (the smoke script
# tears its instances down).
#
# Usage:
#   .\tmp\perf\spin-peer.ps1 -Port 7778 -PeerId peer-b
#   .\tmp\perf\spin-peer.ps1 -Port 7779 -PeerId peer-c -HomeDir tmp\perf\home-c
#
# Background note: spawning two daemons on the same Windows host means
# both will try to advertise themselves via mDNS on the same interfaces.
# bonjour-service handles this — each daemon gets a unique service name
# (its peer id) — but if the second one fails to publish, the smoke
# script's peers.yaml seeding still gives both sides mutual visibility.

param(
  [int]$Port = 7778,
  [string]$PeerId = 'peer-b',
  [string]$HomeDir = "tmp\perf\peer-spin-$PeerId",
  [switch]$NoBuild
)

$ErrorActionPreference = 'Stop'

$RootDir = (Get-Item (Join-Path $PSScriptRoot '..\..')).FullName
$AbsHome = Join-Path $RootDir $HomeDir
$DistCli = Join-Path $RootDir 'dist\cli.js'

if (-not $NoBuild) {
  Write-Host "[spin-peer] building (--NoBuild to skip)"
  Push-Location $RootDir
  try {
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "build failed" }
  } finally {
    Pop-Location
  }
}

if (-not (Test-Path $DistCli)) {
  throw "dist/cli.js missing; run npm run build first or omit -NoBuild"
}

if (Test-Path $AbsHome) {
  Write-Host "[spin-peer] cleaning prior home dir: $AbsHome"
  Remove-Item -Path $AbsHome -Recurse -Force
}
New-Item -ItemType Directory -Path $AbsHome -Force | Out-Null

# Seed a minimal peers.yaml so the spun peer knows its own id even
# without the operator editing the file.
$peersYaml = @"
self_id: $PeerId
self_display_name: $PeerId
peers: []
"@
Set-Content -Path (Join-Path $AbsHome 'peers.yaml') -Value $peersYaml -Encoding utf8

$env:STAVR_HOME = $AbsHome
$env:STAVR_PEER_ID = $PeerId
$env:PORT = $Port

Write-Host ""
Write-Host "[spin-peer] starting daemon"
Write-Host "  port:  $Port"
Write-Host "  home:  $AbsHome"
Write-Host "  id:    $PeerId"
Write-Host "  cli:   $DistCli"
Write-Host ""
Write-Host "  visit:  http://localhost:$Port/dashboard/family-mode"
Write-Host "  health: http://localhost:$Port/api/federation/health"
Write-Host ""
Write-Host "Press Ctrl+C to stop."
Write-Host ""

& node $DistCli daemon start --port $Port
