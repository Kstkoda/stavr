# Smoke test for spec 52 A1 - configurable bind + auth gate (Windows / pwsh).
#
# Same arms as scripts/smoke/a1-bind.sh:
#   1. Refusal: non-loopback bind without auth exits 1 with the documented msg.
#   2. Success: localhost bind comes up, /healthz returns 200.
#   3. stavr config show flags would_refuse=true for a risky bind.
#
# Run after npm run build. Idempotent. Pure-ASCII text; no Stop pref so that
# Node's stderr (where the refusal message lands) doesn't terminate the script.

$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$tmp = Join-Path $env:TEMP ("stavr-smoke-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$env:STAVR_HOME = Join-Path $tmp 'home'
New-Item -ItemType Directory -Force -Path $env:STAVR_HOME | Out-Null

$port = if ($env:PORT) { $env:PORT } else { '17777' }
$configPath = Join-Path $tmp 'stavr.yaml'
$dbPath = Join-Path $tmp 'runestone.db'

$cliJs = Join-Path $root 'dist\cli.js'
if (-not (Test-Path $cliJs)) {
    Write-Host "smoke: dist/cli.js missing - run 'npm run build' first"
    exit 2
}

$daemonProc = $null

function Invoke-Cleanup {
    if ($script:daemonProc -and -not $script:daemonProc.HasExited) {
        try { $script:daemonProc.Kill() } catch { }
        try { $script:daemonProc.WaitForExit(3000) | Out-Null } catch { }
    }
    if (Test-Path $tmp) {
        try { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue } catch { }
    }
}

function Run-Node {
    param(
        [string[]]$NodeArgs,
        [string]$OutFile,
        [string]$ErrFile
    )
    $proc = Start-Process -FilePath node -ArgumentList $NodeArgs `
        -NoNewWindow -Wait -PassThru `
        -RedirectStandardOutput $OutFile -RedirectStandardError $ErrFile
    return $proc.ExitCode
}

Write-Host '==> 1/3: refusal path (bind 0.0.0.0, require_auth true)'
$refuseConfig = "network:`n  bind: 0.0.0.0`n  require_auth_when_non_local: true`n"
Set-Content -Path $configPath -Value $refuseConfig -Encoding ascii

$refuseOutFile = Join-Path $tmp 'refuse.out'
$refuseErrFile = Join-Path $tmp 'refuse.err'
$refuseExit = Run-Node `
    -NodeArgs @($cliJs, 'daemon', 'start', '--port', $port, '--db', $dbPath, '--config', $configPath, '--log-format', 'json') `
    -OutFile $refuseOutFile -ErrFile $refuseErrFile
$refuseCombined = (Get-Content -Raw -Path $refuseOutFile -ErrorAction SilentlyContinue) + (Get-Content -Raw -Path $refuseErrFile -ErrorAction SilentlyContinue)
if ($refuseExit -eq 0) {
    Write-Host 'FAIL: daemon started when it should have refused'
    Write-Host $refuseCombined
    Invoke-Cleanup
    exit 1
}
if ($refuseCombined -notmatch 'refusing to bind non-local') {
    Write-Host 'FAIL: expected refusal message, got:'
    Write-Host $refuseCombined
    Invoke-Cleanup
    exit 1
}
Write-Host "    refused with exit $refuseExit as expected."

Write-Host '==> 2/3: success path (bind localhost)'
$okConfig = "network:`n  bind: localhost`n"
Set-Content -Path $configPath -Value $okConfig -Encoding ascii

$daemonProc = Start-Process -FilePath node `
    -ArgumentList @($cliJs, 'daemon', 'start', '--port', $port, '--db', $dbPath, '--config', $configPath, '--log-format', 'json') `
    -PassThru -NoNewWindow `
    -RedirectStandardOutput (Join-Path $tmp 'daemon.out.log') `
    -RedirectStandardError (Join-Path $tmp 'daemon.err.log')

$up = $false
for ($i = 0; $i -lt 100; $i++) {
    try {
        $r = Invoke-WebRequest -UseBasicParsing -Uri ("http://127.0.0.1:" + $port + "/healthz") -TimeoutSec 1 -ErrorAction Stop
        if ($r.StatusCode -eq 200) { $up = $true; break }
    } catch {
        Start-Sleep -Milliseconds 100
    }
}
if (-not $up) {
    Write-Host "FAIL: /healthz never came up on port $port"
    Invoke-Cleanup
    exit 1
}
Write-Host "    /healthz reachable on 127.0.0.1:$port"

Write-Host '==> 3/3: stavr config show reports auth-gate verdict'
$verdictOutFile = Join-Path $tmp 'verdict.out'
$verdictErrFile = Join-Path $tmp 'verdict.err'
$verdictExit = Run-Node `
    -NodeArgs @($cliJs, 'config', 'show', '--config', $configPath, '--bind-host', '0.0.0.0') `
    -OutFile $verdictOutFile -ErrFile $verdictErrFile
$verdict = Get-Content -Raw -Path $verdictOutFile -ErrorAction SilentlyContinue
if ($verdictExit -ne 0) {
    Write-Host "FAIL: config show exited $verdictExit"
    Write-Host (Get-Content -Raw -Path $verdictErrFile -ErrorAction SilentlyContinue)
    Invoke-Cleanup
    exit 1
}
if ($verdict -notmatch '"would_refuse": true') {
    Write-Host 'FAIL: config show did not flag 0.0.0.0 as would_refuse'
    Write-Host $verdict
    Invoke-Cleanup
    exit 1
}
Write-Host '    config show flagged would_refuse=true for 0.0.0.0'

Invoke-Cleanup
Write-Host 'SMOKE A1 OK'
