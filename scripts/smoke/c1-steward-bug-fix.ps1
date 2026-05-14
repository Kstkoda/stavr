# Smoke test for stream C C1 - stavr steward bug-fix (Windows / pwsh).

$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$cliJs = Join-Path $root 'dist\cli.js'
if (-not (Test-Path $cliJs)) {
    Write-Host "smoke: dist/cli.js missing - run 'npm run build' first"
    exit 2
}

$tmp = Join-Path $env:TEMP ("stavr-c1-smoke-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$bin = Join-Path $tmp 'bin'
New-Item -ItemType Directory -Force -Path $bin | Out-Null

$ghJs = Join-Path $bin 'gh-fake.js'
@'
const args = process.argv.slice(2);
if (args[0] === 'issue' && args[1] === 'view') {
  process.stdout.write(JSON.stringify({
    number: 1,
    title: 'Smoke bug',
    body: 'Synthetic.',
    state: 'open',
    labels: [{ name: 'bug' }],
    url: 'https://github.com/stenlund/stavr-test-sandbox/issues/1',
  }));
  process.exit(0);
}
process.exit(1);
'@ | Set-Content -Path $ghJs -Encoding ascii

$ghCmd = Join-Path $bin 'gh.cmd'
$ghJsForCmd = $ghJs -replace '\\', '\\'
"@echo off`r`nnode `"$ghJsForCmd`" %*`r`n" | Set-Content -Path $ghCmd -Encoding ascii

$env:STAVR_GH_BIN = $ghCmd
$env:STAVR_HOME = Join-Path $tmp 'home'
New-Item -ItemType Directory -Force -Path $env:STAVR_HOME | Out-Null

function Run-CliCapture {
    param([string[]]$NodeArgs)
    $outFile = Join-Path $tmp ("out-" + [Guid]::NewGuid().ToString('N'))
    $errFile = Join-Path $tmp ("err-" + [Guid]::NewGuid().ToString('N'))
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
    Write-Host '==> 1/2: --dry-run with auto-approve set'
    $env:STAVR_AUTO_APPROVE_BUG_FIXES = '1'
    $r1 = Run-CliCapture @($cliJs, 'steward', 'bug-fix', '--issue', 'stenlund/stavr-test-sandbox#1', '--dry-run')
    if ($r1.ExitCode -ne 0) {
        Write-Host "FAIL: dry-run exit $($r1.ExitCode)"
        Write-Host $r1.Stderr
        exit 1
    }
    if ($r1.Stdout -notmatch '"dry_run": true') {
        Write-Host 'FAIL: missing dry_run flag'
        Write-Host $r1.Stdout
        exit 1
    }
    if ($r1.Stdout -notmatch '"granted": true') {
        Write-Host 'FAIL: auto-approval not granted'
        Write-Host $r1.Stdout
        exit 1
    }
    if ($r1.Stdout -notmatch '"github.create_pr"') {
        Write-Host 'FAIL: allowed_actions missing github.create_pr'
        Write-Host $r1.Stdout
        exit 1
    }
    Write-Host '    dry-run reports auto_approved=true, allowed_actions contain github.create_pr'

    Write-Host '==> 2/2: --dry-run without auto-approve env var'
    Remove-Item Env:\STAVR_AUTO_APPROVE_BUG_FIXES -ErrorAction SilentlyContinue
    $r2 = Run-CliCapture @($cliJs, 'steward', 'bug-fix', '--issue', 'stenlund/stavr-test-sandbox#1', '--dry-run')
    if ($r2.ExitCode -ne 0) {
        Write-Host "FAIL: dry-run exit $($r2.ExitCode)"
        Write-Host $r2.Stderr
        exit 1
    }
    if ($r2.Stdout -notmatch '"granted": false') {
        Write-Host 'FAIL: auto-approval should not be granted without env var'
        Write-Host $r2.Stdout
        exit 1
    }
    Write-Host '    dry-run reports auto_approved=false'

    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    Write-Host 'SMOKE C1 OK'
} catch {
    Write-Host "SMOKE C1 FAIL: $_"
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    exit 1
}
