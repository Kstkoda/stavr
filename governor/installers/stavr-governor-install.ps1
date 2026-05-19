# stavR Governor — Windows autostart installer
#
# Configures the Governor to launch at user login by writing a Run-key value
# under HKCU\Software\Microsoft\Windows\CurrentVersion\Run. Idempotent —
# running twice writes the same value; -Uninstall removes it.
#
# Pairs with `governor/scripts/install-from-release.ps1` (which downloads + Sigstore-
# verifies + stages the binary). This script is the autostart wiring only.
#
# Usage:
#   .\stavr-governor-install.ps1                    # use default binary path
#   .\stavr-governor-install.ps1 -BinaryPath C:\... # use a custom path
#   .\stavr-governor-install.ps1 -DashboardBase http://127.0.0.1:7778  # non-default port
#   .\stavr-governor-install.ps1 -Uninstall          # remove autostart entry
#
# After install: log out and back in, or run `Start-Process $BinaryPath` to
# launch immediately. Look for the Raido rune (ᚱ) in the system tray.

[CmdletBinding()]
param(
    [string]$BinaryPath = "$env:USERPROFILE\.stavr\governor\stavr-governor.exe",
    [string]$DashboardBase = "",
    [string]$LogPath = "",
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

$RunKey  = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$EntryName = 'stavR Governor'

function Test-WebView2 {
    # Tauri 2 needs WebView2 runtime on Windows. Pre-installed on Win10+
    # usually; older Win10 / fresh-install boxes may need it.
    $key = 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\ClientState\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    return Test-Path $key
}

if ($Uninstall) {
    Write-Host "Removing stavR Governor autostart entry…" -ForegroundColor Cyan
    if (Get-ItemProperty -Path $RunKey -Name $EntryName -ErrorAction SilentlyContinue) {
        Remove-ItemProperty -Path $RunKey -Name $EntryName
        Write-Host "  removed: $RunKey\$EntryName" -ForegroundColor Green
    } else {
        Write-Host "  no entry found (already uninstalled)" -ForegroundColor DarkGray
    }
    Write-Host "Done. Governor will not auto-launch on next login." -ForegroundColor Cyan
    Write-Host "Note: this does NOT stop a running Governor. If one is in the tray," -ForegroundColor DarkGray
    Write-Host "      right-click ᚱ → Quit Governor." -ForegroundColor DarkGray
    exit 0
}

Write-Host "stavR Governor autostart installer" -ForegroundColor Cyan
Write-Host "  binary:        $BinaryPath" -ForegroundColor DarkGray
Write-Host "  dashboard URL: $(if ($DashboardBase) { $DashboardBase } else { '(default: http://127.0.0.1:7777)' })" -ForegroundColor DarkGray
Write-Host "  log path:      $(if ($LogPath) { $LogPath } else { '(default: cwd/tmp/pm2-stavr.out.log)' })" -ForegroundColor DarkGray

if (-not (Test-Path $BinaryPath)) {
    Write-Error "Binary not found at $BinaryPath. Run install-from-release.ps1 first, or pass -BinaryPath to point at your local build (target/release/stavr-governor.exe)."
    exit 1
}

if (-not (Test-WebView2)) {
    Write-Warning "WebView2 runtime not detected. Tauri 2 requires it."
    Write-Warning "Install via: winget install Microsoft.EdgeWebView2Runtime"
    Write-Warning "  (Pre-installed on Windows 10 21H1+ usually; fresh installs may need it.)"
    Write-Host "Continuing anyway — the registry entry will land but Governor may fail to start." -ForegroundColor Yellow
}

# Build the command line. We don't pass env vars via the Run key (the
# registry value is just a command line; env vars come from the user's
# profile). Instead, write env vars to the user's environment block via
# [Environment]::SetEnvironmentVariable so they take effect on next login.

$cmdLine = "`"$BinaryPath`""

Write-Host ""
Write-Host "Writing autostart entry…" -ForegroundColor Cyan
New-ItemProperty -Path $RunKey -Name $EntryName -Value $cmdLine -PropertyType String -Force | Out-Null
Write-Host "  $RunKey\$EntryName = $cmdLine" -ForegroundColor Green

if ($DashboardBase) {
    [Environment]::SetEnvironmentVariable('STAVR_DASHBOARD_BASE', $DashboardBase, 'User')
    Write-Host "  User env: STAVR_DASHBOARD_BASE=$DashboardBase" -ForegroundColor Green
}
if ($LogPath) {
    [Environment]::SetEnvironmentVariable('STAVR_LOG_PATH', $LogPath, 'User')
    Write-Host "  User env: STAVR_LOG_PATH=$LogPath" -ForegroundColor Green
}

Write-Host ""
Write-Host "Done. Verify with:" -ForegroundColor Cyan
Write-Host "  Get-ItemProperty -Path '$RunKey' -Name '$EntryName'" -ForegroundColor DarkGray
Write-Host ""
Write-Host "Launch now without waiting for the next login:" -ForegroundColor Cyan
Write-Host "  Start-Process '$BinaryPath'" -ForegroundColor DarkGray
Write-Host ""
Write-Host "To uninstall later:" -ForegroundColor Cyan
Write-Host "  .\stavr-governor-install.ps1 -Uninstall" -ForegroundColor DarkGray
