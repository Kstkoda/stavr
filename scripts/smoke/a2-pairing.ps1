# Smoke test for spec 52 A2 - pairing-code authentication (Windows / pwsh).
#
# Same arms as scripts/smoke/a2-pairing.sh:
#   1. Daemon comes up on loopback.
#   2. pair bootstrap returns a 6-digit code.
#   3. pair remote-host exchanges it for a token + writes devices.json.
#   4. devices list shows the device, revoke removes it from active listing.

$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$cliJs = Join-Path $root 'dist\cli.js'
if (-not (Test-Path $cliJs)) {
    Write-Host "smoke: dist/cli.js missing - run 'npm run build' first"
    exit 2
}

$tmp = Join-Path $env:TEMP ("cowire-a2-smoke-" + [Guid]::NewGuid().ToString('N'))
$nasHome = Join-Path $tmp 'nas'
$devHome = Join-Path $tmp 'device'
$nasDb = Join-Path $tmp 'nas.db'
New-Item -ItemType Directory -Force -Path $nasHome | Out-Null
New-Item -ItemType Directory -Force -Path $devHome | Out-Null

$port = if ($env:PORT) { $env:PORT } else { '17777' }
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

function Run-CliJson {
    param([string[]]$NodeArgs, [hashtable]$Env)
    $outFile = Join-Path $tmp ("cli-" + [Guid]::NewGuid().ToString('N') + '.out')
    $errFile = Join-Path $tmp ("cli-" + [Guid]::NewGuid().ToString('N') + '.err')
    foreach ($k in $Env.Keys) { Set-Item -Path "Env:$k" -Value $Env[$k] }
    $proc = Start-Process -FilePath node -ArgumentList $NodeArgs `
        -NoNewWindow -Wait -PassThru `
        -RedirectStandardOutput $outFile -RedirectStandardError $errFile
    return [pscustomobject]@{
        ExitCode = $proc.ExitCode
        Stdout = (Get-Content -Raw -Path $outFile -ErrorAction SilentlyContinue)
        Stderr = (Get-Content -Raw -Path $errFile -ErrorAction SilentlyContinue)
    }
}

try {
    Write-Host '==> 1/4: start daemon (loopback, no auth yet)'
    $env:COWIRE_HOME = $nasHome
    $daemonProc = Start-Process -FilePath node `
        -ArgumentList @($cliJs, 'daemon', 'start', '--port', $port, '--db', $nasDb, '--log-format', 'json') `
        -PassThru -NoNewWindow `
        -RedirectStandardOutput (Join-Path $tmp 'daemon.out') `
        -RedirectStandardError (Join-Path $tmp 'daemon.err')

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
        Write-Host "FAIL: healthz never came up on port $port"
        Invoke-Cleanup
        exit 1
    }
    Write-Host "    healthz reachable on 127.0.0.1:$port"

    Write-Host '==> 2/4: pair bootstrap returns a 6-digit code'
    $bootstrap = Run-CliJson `
        -NodeArgs @($cliJs, 'pair', 'bootstrap', '--daemon-url', ("http://127.0.0.1:" + $port)) `
        -Env @{ COWIRE_HOME = $nasHome }
    if ($bootstrap.ExitCode -ne 0) {
        Write-Host "FAIL: pair bootstrap exit $($bootstrap.ExitCode)"
        Write-Host $bootstrap.Stderr
        Invoke-Cleanup
        exit 1
    }
    $bootstrapJson = $bootstrap.Stdout | ConvertFrom-Json
    if ($bootstrapJson.code -notmatch '^\d{6}$') {
        Write-Host "FAIL: bootstrap did not return a 6-digit code (got: $($bootstrapJson.code))"
        Invoke-Cleanup
        exit 1
    }
    Write-Host "    received code $($bootstrapJson.code)"

    Write-Host '==> 3/4: pair remote-host -> token + devices.json'
    $remote = Run-CliJson `
        -NodeArgs @($cliJs, 'pair', 'remote-host', '--daemon-url', ("http://127.0.0.1:" + $port), '--code', $bootstrapJson.code, '--name', 'smoke-device') `
        -Env @{ COWIRE_HOME = $devHome }
    if ($remote.ExitCode -ne 0) {
        Write-Host "FAIL: pair remote-host exit $($remote.ExitCode)"
        Write-Host $remote.Stderr
        Invoke-Cleanup
        exit 1
    }
    $devicesJsonPath = Join-Path $devHome 'devices.json'
    if (-not (Test-Path $devicesJsonPath)) {
        Write-Host 'FAIL: devices.json not written'
        Invoke-Cleanup
        exit 1
    }
    $devicesFile = Get-Content -Raw -Path $devicesJsonPath | ConvertFrom-Json
    if (-not $devicesFile.pairings -or $devicesFile.pairings.Count -ne 1) {
        Write-Host 'FAIL: devices.json should contain exactly one pairing'
        Invoke-Cleanup
        exit 1
    }
    Write-Host "    token persisted to $devicesJsonPath"

    Write-Host '==> 4/4: devices list, then revoke, then verify gone'
    $list = Run-CliJson `
        -NodeArgs @($cliJs, 'devices', 'list', '--db', $nasDb) `
        -Env @{ COWIRE_HOME = $nasHome }
    $listJson = $list.Stdout | ConvertFrom-Json
    if ($listJson.devices.Count -ne 1 -or $listJson.devices[0].name -ne 'smoke-device') {
        Write-Host 'FAIL: devices list did not show smoke-device'
        Write-Host $list.Stdout
        Invoke-Cleanup
        exit 1
    }
    $deviceId = $listJson.devices[0].id
    $revoke = Run-CliJson `
        -NodeArgs @($cliJs, 'devices', 'revoke', $deviceId, '--db', $nasDb) `
        -Env @{ COWIRE_HOME = $nasHome }
    if ($revoke.ExitCode -ne 0) {
        Write-Host "FAIL: devices revoke exit $($revoke.ExitCode)"
        Write-Host $revoke.Stderr
        Invoke-Cleanup
        exit 1
    }
    $listAfter = Run-CliJson `
        -NodeArgs @($cliJs, 'devices', 'list', '--db', $nasDb) `
        -Env @{ COWIRE_HOME = $nasHome }
    $listAfterJson = $listAfter.Stdout | ConvertFrom-Json
    if ($listAfterJson.devices.Count -ne 0) {
        Write-Host 'FAIL: device still active after revoke'
        Write-Host $listAfter.Stdout
        Invoke-Cleanup
        exit 1
    }
    Write-Host "    revoked $deviceId; active list no longer shows it"

    Invoke-Cleanup
    Write-Host 'SMOKE A2 OK'
} catch {
    Write-Host "SMOKE A2 FAIL: $_"
    Invoke-Cleanup
    exit 1
}
