# install-windows-service.ps1 — render the stavR WinSW XML config and
# print operator next-steps. CC writes the XML; the operator runs
# `StavrDaemon.exe install` and `StavrDaemon.exe start`.
#
# Per the os-native-governor BOM: the install script must NOT run
# StavrDaemon.exe install / start / sc.exe / Set-Service itself.
# System-modifying actions stay operator-run.
#
# Prerequisite: the WinSW binary must be present at
# bin\winsw\StavrDaemon.exe. See bin\winsw\README.md for the pinned
# WinSW version + SHA256 hash + obtain instructions.
#
# Usage:
#   .\bin\install-windows-service.ps1
#
# Idempotent: re-running overwrites the XML with freshly-resolved values.
# After re-install the operator should re-register:
#   .\bin\winsw\StavrDaemon.exe stop
#   .\bin\winsw\StavrDaemon.exe uninstall
#   .\bin\winsw\StavrDaemon.exe install
#   .\bin\winsw\StavrDaemon.exe start

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

# ---- Resolve paths ----

$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$InstallDir  = (Get-Item (Join-Path $ScriptDir '..')).FullName
$WinSwDir    = Join-Path $ScriptDir 'winsw'
$WinSwExe    = Join-Path $WinSwDir 'StavrDaemon.exe'
$WinSwXml    = Join-Path $WinSwDir 'StavrDaemon.xml'
$Template    = Join-Path $ScriptDir 'StavrDaemon.xml.template'

# ---- Sanity checks before writing anything ----

if (-not $IsWindows -and -not ($env:OS -eq 'Windows_NT')) {
    Write-Error 'install-windows-service.ps1: this script is Windows-only.'
    exit 1
}

if (-not (Test-Path $Template)) {
    Write-Error "install-windows-service.ps1: template missing at $Template"
    exit 1
}

$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $NodeCmd) {
    Write-Error 'install-windows-service.ps1: node not found on PATH. Install Node >= 20 first.'
    exit 1
}
$NodeBin = $NodeCmd.Source

$DistCli = Join-Path $InstallDir 'dist\cli.js'
if (-not (Test-Path $DistCli)) {
    Write-Error "install-windows-service.ps1: $DistCli not found. Run 'npm run build' from $InstallDir first."
    exit 1
}

# The WinSW binary itself — operator places it per bin\winsw\README.md.
if (-not (Test-Path $WinSwExe)) {
    Write-Error @"
install-windows-service.ps1: WinSW binary missing at $WinSwExe.

The WinSW (Windows Service Wrapper) binary is required to register the
daemon as a Windows Service. We do not commit binary blobs to the
repository — see $WinSwDir\README.md for:
  - the pinned WinSW version
  - the SHA256 hash you must verify after download
  - the upstream URL to download from

Once placed at $WinSwExe, re-run this script.
"@
    exit 1
}

# ---- Resolve placeholders ----

$StavrHome = $env:STAVR_HOME
if ([string]::IsNullOrEmpty($StavrHome)) {
    $StavrHome = Join-Path $env:USERPROFILE '.stavr'
}
$HomeDir   = $env:USERPROFILE
$PathValue = $env:PATH

# Create directories the service will reference before it tries to start.
$LogsDir   = Join-Path $InstallDir 'logs'
$DiagDir   = Join-Path $InstallDir 'tmp\diag-reports'
foreach ($d in @($StavrHome, $LogsDir, $DiagDir, $WinSwDir)) {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
}

# ---- Render the XML ----
#
# Simple string replacement (no regex metacharacter issues — placeholders
# are a well-known shape, values are file paths that can contain regex
# specials like \).
$xml = Get-Content -Raw -LiteralPath $Template
$xml = $xml.Replace('@NODE_BIN@',    $NodeBin)
$xml = $xml.Replace('@INSTALL_DIR@', $InstallDir)
$xml = $xml.Replace('@STAVR_HOME@',  $StavrHome)
$xml = $xml.Replace('@HOME_DIR@',    $HomeDir)
$xml = $xml.Replace('@PATH_VALUE@',  $PathValue)

# Refuse to confirm install if any @PLACEHOLDER@ survived.
if ($xml -match '@[A-Z_]+@') {
    Write-Error @"
install-windows-service.ps1: unsubstituted placeholders in rendered XML:
$($Matches[0])

This means the template has a placeholder the install script doesn't know about.
"@
    exit 1
}

Set-Content -LiteralPath $WinSwXml -Value $xml -Encoding utf8 -NoNewline

# ---- Operator next-steps ----

Write-Host @"
[OK] Wrote $WinSwXml
     install dir: $InstallDir
     node:        $NodeBin
     STAVR_HOME:  $StavrHome
     logs:        $LogsDir

Next steps (the install script does NOT run these — they modify your
system and are operator-owned, must be run from an elevated PowerShell):

  $WinSwExe install
  $WinSwExe start

Verify:
  Get-Service StavrDaemon
  $WinSwExe status
  Get-Content -Wait -Tail 30 (Join-Path $LogsDir 'StavrDaemon.err.log')
  curl.exe -s http://127.0.0.1:7777/healthz

Crash-loop guard: 3 escalating restart attempts (30s / 1min / 5min) then
halt. Failure counter resets after 1 hour of healthy uptime. If the
service flaps and lands in the 'stopped' state, inspect the logs and run:
  $WinSwExe start

To uninstall:
  .\bin\uninstall-windows-service.ps1
"@
