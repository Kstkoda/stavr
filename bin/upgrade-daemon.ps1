# bin/upgrade-daemon.ps1 — service-aware stavR daemon upgrade with rollback.
#
# Phase 4 of the operator-companion refactor
# (proposed/governor-observe-only-bom.md). The Tauri Governor's tray
# "Upgrade Daemon" item shells out to this script via
# `governor::service::spawn_upgrade`. The contract:
#
#   1. Capture OLD = git rev-parse HEAD
#   2. Stop the OS-native StavrDaemon service
#   3. git pull (fast-forward main)
#   4. npm ci
#   5. npm run build
#   6. Start the service; health-check /healthz (poll, ~60 s timeout)
#   7. On any failure in 3-6: git reset --hard $OLD → npm ci → npm run build
#      → start the service → exit non-zero with a clear reason
#   8. On success: report the new commit
#
# Rollback contract — ALWAYS leaves the daemon running the pre-upgrade
# commit when anything goes wrong. The OS-native service supervises both
# the upgraded and the rolled-back daemon; this script never spawns a
# detached daemon process directly.
#
# Test the rollback path with the --force-build-fail flag (no network /
# git operations actually need to fail — the script will skip the real
# build and emulate a non-zero exit so the rollback branch is exercised
# against the live service).

[CmdletBinding()]
param(
    # Skip git pull / npm ci and force the "build failed" branch so the
    # rollback path can be exercised on the operator's machine without
    # actually breaking anything.
    [switch] $ForceBuildFail,

    # Override the OS-native service name (default: StavrDaemon).
    [string] $ServiceName = 'StavrDaemon',

    # Override the daemon /healthz URL.
    [string] $HealthUrl = 'http://127.0.0.1:7777/healthz',

    # Max seconds to poll /healthz after starting the service.
    [int] $HealthTimeoutSec = 60
)

$ErrorActionPreference = 'Stop'
$script:UpgradeFailed = $false
$script:FailureReason = $null

function Write-Phase {
    param([string] $Msg)
    $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    Write-Host "[upgrade-daemon][$stamp] $Msg"
}

function Stop-StavrService {
    Write-Phase "stopping $ServiceName service"
    # Stop-Service requires admin; if the caller isn't elevated this will
    # surface a clear error and the rollback branch will run.
    Stop-Service -Name $ServiceName -Force -ErrorAction Stop
}

function Start-StavrService {
    Write-Phase "starting $ServiceName service"
    Start-Service -Name $ServiceName -ErrorAction Stop
}

function Wait-DaemonHealthy {
    Write-Phase "polling $HealthUrl (timeout ${HealthTimeoutSec}s)"
    $deadline = (Get-Date).AddSeconds($HealthTimeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            $resp = Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing `
                -TimeoutSec 3 -ErrorAction Stop
            if ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 300) {
                Write-Phase "/healthz returned $($resp.StatusCode) — daemon ready"
                return $true
            }
        } catch {
            # connection refused / timeout — daemon not ready yet; keep polling
        }
        Start-Sleep -Seconds 2
    }
    return $false
}

function Invoke-RollbackTo {
    param([string] $OldCommit)
    Write-Phase "ROLLBACK to $OldCommit"
    try {
        git reset --hard $OldCommit
        if ($LASTEXITCODE -ne 0) {
            throw "git reset --hard exited $LASTEXITCODE"
        }
        npm ci
        if ($LASTEXITCODE -ne 0) {
            throw "rollback npm ci exited $LASTEXITCODE"
        }
        npm run build
        if ($LASTEXITCODE -ne 0) {
            throw "rollback npm run build exited $LASTEXITCODE"
        }
        # Service is already stopped (we stopped it before the upgrade
        # attempt, and the upgrade failure may have left it stopped or in
        # an inconsistent state).
        try { Stop-StavrService } catch { }
        Start-StavrService
        $ok = Wait-DaemonHealthy
        if (-not $ok) {
            throw "post-rollback /healthz did not come back within ${HealthTimeoutSec}s"
        }
        Write-Phase "rollback complete — daemon on $OldCommit"
    } catch {
        Write-Phase "ROLLBACK FAILED: $_"
        Write-Phase "operator must intervene manually — daemon may not be running"
        throw
    }
}

# ---------------------------------------------------------------------------
# Main flow
# ---------------------------------------------------------------------------

try {
    # Resolve repo root — script lives in bin/, so the repo root is its parent.
    $RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
    Set-Location $RepoRoot
    Write-Phase "cwd = $RepoRoot"

    # Capture OLD before doing anything else — this is the rollback target.
    $OldCommit = (git rev-parse HEAD).Trim()
    if (-not $OldCommit) {
        throw "could not resolve current HEAD commit — is this a git checkout?"
    }
    Write-Phase "pre-upgrade commit = $OldCommit"

    # Stop the OS-native service BEFORE pulling. The upgraded daemon will
    # be brought up via the same service after the build completes, so the
    # service is the single source of truth for the daemon process.
    Stop-StavrService

    if ($ForceBuildFail) {
        Write-Phase "--ForceBuildFail set — emulating a build failure to exercise the rollback path"
        throw "forced build failure (test harness)"
    }

    Write-Phase "git pull (fast-forward main)"
    git pull --ff-only
    if ($LASTEXITCODE -ne 0) { throw "git pull exited $LASTEXITCODE" }

    Write-Phase "npm ci"
    npm ci
    if ($LASTEXITCODE -ne 0) { throw "npm ci exited $LASTEXITCODE" }

    Write-Phase "npm run build"
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build exited $LASTEXITCODE" }

    Start-StavrService

    $ok = Wait-DaemonHealthy
    if (-not $ok) {
        throw "post-upgrade /healthz did not come back within ${HealthTimeoutSec}s"
    }

    $NewCommit = (git rev-parse HEAD).Trim()
    Write-Phase "UPGRADE OK — daemon now on $NewCommit (was $OldCommit)"
    exit 0

} catch {
    $script:UpgradeFailed = $true
    $script:FailureReason = "$_"
    Write-Phase "UPGRADE FAILED: $script:FailureReason"
    if ($OldCommit) {
        try {
            Invoke-RollbackTo -OldCommit $OldCommit
            exit 2  # 2 = upgrade failed but rollback succeeded
        } catch {
            exit 3  # 3 = upgrade failed AND rollback failed (operator-only)
        }
    } else {
        exit 4  # 4 = couldn't even capture OLD; nothing was attempted
    }
}
