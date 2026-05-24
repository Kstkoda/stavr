# uninstall-windows-service.ps1 — remove the stavR WinSW XML config.
# CC removes the file; the operator stops + uninstalls the service.
#
# Per the os-native-governor BOM: the uninstall script must NOT run
# StavrDaemon.exe stop / uninstall / sc.exe itself. System-modifying
# actions stay operator-run.
#
# Usage:
#   .\bin\uninstall-windows-service.ps1           # prints the steps, no removal
#   .\bin\uninstall-windows-service.ps1 -Force    # removes XML (operator must
#                                                 # have already stopped +
#                                                 # uninstalled the service)
#
# Idempotent: re-running with -Force when the file is already gone is a no-op.

[CmdletBinding()]
param(
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$WinSwDir  = Join-Path $ScriptDir 'winsw'
$WinSwXml  = Join-Path $WinSwDir 'StavrDaemon.xml'
$WinSwExe  = Join-Path $WinSwDir 'StavrDaemon.exe'

if (-not (Test-Path $WinSwXml)) {
    Write-Host "uninstall-windows-service.ps1: no XML at $WinSwXml — nothing to do."
    exit 0
}

if (-not $Force) {
    Write-Host @"
About to remove: $WinSwXml

Run these FIRST (we cannot for you — service stop + uninstall require
elevated PowerShell):

  $WinSwExe stop
  $WinSwExe uninstall

Then re-run this script with -Force to remove the XML file:

  .\bin\uninstall-windows-service.ps1 -Force

The WinSW binary at $WinSwExe is left in place — uninstall it manually
if desired.
"@
    exit 0
}

Remove-Item -LiteralPath $WinSwXml -Force

Write-Host @"
[OK] Removed $WinSwXml

If the service was still installed when -Force ran, the registered service
will remain in Windows Service Manager until the operator runs the
service-uninstall command above. Confirm:

  Get-Service StavrDaemon -ErrorAction SilentlyContinue
  # expect: $null (service no longer registered)
"@
