<#
.SYNOPSIS
    Download, verify, and install a signed stavR Governor release on Windows.

.DESCRIPTION
    Verify-then-trust install flow per BOM v0.6.5.1 P4. Downloads the release
    zip from GitHub, expands to %USERPROFILE%\.stavr\governor, verifies the
    binary signature against Sigstore Rekor BEFORE running it. This is the
    flow that lets SAC trust the binary on first launch — once
    Sigstore-verified, the operator is voucher-of-record that this artifact
    matches a public, immutable transparency log entry.

.PARAMETER Version
    Release tag to install. Defaults to `latest`.

.PARAMETER Arch
    Architecture: x86_64 or aarch64. Defaults to the host CPU architecture.

.PARAMETER InstallDir
    Where to expand the binary. Defaults to `$env:USERPROFILE\.stavr\governor`.

.PARAMETER SkipVerify
    Skip Sigstore verification. NOT RECOMMENDED. The whole point of the
    Sigstore pipeline (per ADR-038 §2) is that the operator verifies before
    running. Use only when troubleshooting the verify step itself.

.EXAMPLE
    .\install-from-release.ps1
    .\install-from-release.ps1 -Version v0.6.5
    .\install-from-release.ps1 -Version v0.6.5 -Arch aarch64

.NOTES
    Requires `cosign` on PATH for verification (unless -SkipVerify).
    Install via: winget install --id Sigstore.Cosign
#>
[CmdletBinding()]
param(
    [string]$Version = 'latest',
    [ValidateSet('x86_64', 'aarch64', 'auto')]
    [string]$Arch = 'auto',
    [string]$InstallDir = (Join-Path $env:USERPROFILE '.stavr\governor'),
    [switch]$SkipVerify,
    [string]$Repo = 'Kstkoda/stavr'
)

$ErrorActionPreference = 'Stop'

function Fail($msg) {
    Write-Host "[install] FAIL: $msg" -ForegroundColor Red
    exit 1
}

if ($Arch -eq 'auto') {
    $procArch = $env:PROCESSOR_ARCHITECTURE
    switch ($procArch) {
        'AMD64' { $Arch = 'x86_64' }
        'ARM64' { $Arch = 'aarch64' }
        default { Fail "unsupported PROCESSOR_ARCHITECTURE: $procArch" }
    }
}
$assetName = "stavr-governor.exe"
Write-Host "[install] target arch: $Arch" -ForegroundColor Cyan

# Resolve the actual tag if 'latest'
if ($Version -eq 'latest') {
    Write-Host "[install] resolving latest release"
    $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" `
                             -Headers @{ 'User-Agent' = 'stavr-installer'; 'Accept' = 'application/vnd.github+json' }
    $Version = $rel.tag_name
    Write-Host "[install] latest = $Version"
}

# v0.6.5* tag pattern — anything else is the daemon, not Governor
if ($Version -notmatch '^v0\.6\.5') {
    Fail "tag '$Version' does not match Governor release pattern v0.6.5*. The daemon ships under different tags."
}

$base = "https://github.com/$Repo/releases/download/$Version"
$binUrl = "$base/$assetName"
$sigUrl = "$base/$assetName.sig"
$crtUrl = "$base/$assetName.crt"
$sbomUrl = "$base/stavr-governor.sbom.cdx.json"
$sumsUrl = "$base/SHA256SUMS.txt"

if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}

function Download($url, $dest) {
    Write-Host "[install] GET $url"
    Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
}

$binPath  = Join-Path $InstallDir $assetName
$sigPath  = "$binPath.sig"
$crtPath  = "$binPath.crt"
$sbomPath = Join-Path $InstallDir 'stavr-governor.sbom.cdx.json'
$sumsPath = Join-Path $InstallDir 'SHA256SUMS.txt'

Download $binUrl  $binPath
Download $sigUrl  $sigPath
Download $crtUrl  $crtPath
Download $sbomUrl $sbomPath
Download $sumsUrl $sumsPath

# SHA256 cross-check (cheap second line of defense — Sigstore proves
# provenance, SHA256 proves end-to-end transport integrity).
Write-Host "[install] checking SHA256 against SHA256SUMS.txt"
$expected = (Get-Content $sumsPath | Where-Object { $_ -match [regex]::Escape($assetName) }) `
            -replace '^([0-9a-f]+)\s+.*', '$1'
$actual = (Get-FileHash -Algorithm SHA256 -Path $binPath).Hash.ToLower()
if ($expected -and ($expected -ne $actual)) {
    Fail "SHA256 mismatch — expected $expected, got $actual"
}

if ($SkipVerify) {
    Write-Host "[install] WARNING: skipping Sigstore verification per -SkipVerify" -ForegroundColor Yellow
} else {
    $verify = Join-Path $PSScriptRoot 'verify-release.ps1'
    if (-not (Test-Path $verify)) {
        Fail "verify-release.ps1 not found next to installer. Re-run from a stavR checkout that includes governor/scripts/."
    }
    & $verify -BinaryPath $binPath
    if ($LASTEXITCODE -ne 0) { Fail "Sigstore verification failed (exit $LASTEXITCODE)" }
}

Write-Host ""
Write-Host "[install] OK: $binPath" -ForegroundColor Green
Write-Host "[install] verify the SBOM at $sbomPath if you want a full dep inventory" -ForegroundColor Cyan
Write-Host "[install] launch: & '$binPath'" -ForegroundColor Cyan
