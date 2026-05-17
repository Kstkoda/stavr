<#
.SYNOPSIS
    Self-sign a local Governor dev build so Windows SAC will run it.

.DESCRIPTION
    The 2026-05-17 21:00 incident: Smart App Control (SAC) on the operator's
    Win11 killed the unsigned Governor binary on first launch. Sigstore
    keyless signing requires GitHub Actions OIDC, which is not available
    locally during dev work.

    This script generates (or reuses) a self-signed code-signing certificate
    in the operator's CurrentUser\My store, then signs the local build with
    signtool. The resulting signature embeds the OPERATOR'S identity — it is
    NOT a stavR project signature and MUST NOT be redistributed.

    Whether SAC actually accepts the self-signed binary depends on the
    operator's SAC trust profile. SAC reputation is primarily Microsoft
    cloud-based; a self-signed local cert gives Windows defender + SmartScreen
    something to identify the binary, but SAC may still block. The fallback
    is to disable SAC (irreversible) or wait for a Sigstore-signed release
    (per ADR-038 §2).

.PARAMETER BinaryPath
    Path to the local-built Governor binary. Defaults to the conventional
    cargo --release output for the host triple.

.PARAMETER CertSubject
    Subject CN for the self-signed cert. Defaults to
    "stavR Governor Dev — <username>@<machine>".

.PARAMETER InstallToTrustedRoot
    If set, prompt the operator to install the dev cert to Trusted Root.
    Per BOM open question §3: default is to PROMPT, never silent install.

.EXAMPLE
    .\dev-sign.ps1
    .\dev-sign.ps1 -BinaryPath .\target\release\stavr-governor.exe
    .\dev-sign.ps1 -InstallToTrustedRoot

.NOTES
    Per BOM v0.6.5.1 P3. Requires Windows SDK (signtool.exe) — bundled with
    VS Build Tools. The operator already installed VS Build Tools on
    2026-05-17 for the Governor MVP toolchain.

    Dev signature != release signature. NEVER distribute a dev-signed binary.
#>
[CmdletBinding()]
param(
    [string]$BinaryPath,
    [string]$CertSubject,
    [switch]$InstallToTrustedRoot
)

$ErrorActionPreference = 'Stop'

function Fail($msg) {
    Write-Host "[dev-sign] FAIL: $msg" -ForegroundColor Red
    exit 1
}

if (-not $BinaryPath) {
    $hostTriple = (& rustc -vV 2>&1 | Select-String '^host:' | ForEach-Object { ($_ -replace '^host:\s*', '').Trim() })
    $BinaryPath = Join-Path $PSScriptRoot ".." | Join-Path -ChildPath "target\$hostTriple\release\stavr-governor.exe"
    if (-not (Test-Path $BinaryPath)) {
        # Fallback to default cargo target/release/ path
        $BinaryPath = Join-Path $PSScriptRoot ".." | Join-Path -ChildPath "target\release\stavr-governor.exe"
    }
}
if (-not (Test-Path $BinaryPath)) {
    Fail "Binary not found: $BinaryPath. Run 'cargo build --release' from governor/ first."
}
$BinaryPath = (Resolve-Path $BinaryPath).Path

if (-not $CertSubject) {
    $who = "${env:USERNAME}@${env:COMPUTERNAME}"
    $CertSubject = "CN=stavR Governor Dev - $who"
}

# Locate signtool
$signtool = Get-Command signtool.exe -ErrorAction SilentlyContinue
if (-not $signtool) {
    # Try the standard VS Build Tools location
    $candidates = @(
        "${env:ProgramFiles(x86)}\Windows Kits\10\bin\10.0.22621.0\x64\signtool.exe",
        "${env:ProgramFiles(x86)}\Windows Kits\10\bin\x64\signtool.exe",
        "${env:ProgramFiles}\Windows Kits\10\bin\10.0.22621.0\x64\signtool.exe"
    )
    foreach ($c in $candidates) {
        if (Test-Path $c) { $signtool = @{ Source = $c }; break }
    }
}
if (-not $signtool) {
    Fail "signtool.exe not found. Install Windows SDK via VS Build Tools and retry."
}

# Reuse or create the dev cert
Write-Host "[dev-sign] looking for existing dev cert with subject: $CertSubject"
$existing = Get-ChildItem -Path Cert:\CurrentUser\My | Where-Object { $_.Subject -eq $CertSubject -and $_.HasPrivateKey }
if ($existing) {
    $cert = $existing | Sort-Object -Property NotAfter -Descending | Select-Object -First 1
    Write-Host "[dev-sign] reusing cert thumbprint $($cert.Thumbprint), expires $($cert.NotAfter)"
} else {
    Write-Host "[dev-sign] creating new self-signed cert"
    $cert = New-SelfSignedCertificate `
        -Subject $CertSubject `
        -Type CodeSigningCert `
        -KeyUsage DigitalSignature `
        -KeyAlgorithm RSA `
        -KeyLength 3072 `
        -CertStoreLocation Cert:\CurrentUser\My `
        -NotAfter (Get-Date).AddYears(1) `
        -FriendlyName "stavR Governor dev (local-only, do not distribute)"
    Write-Host "[dev-sign] created cert thumbprint $($cert.Thumbprint)"
}

# Per BOM open question §3: never silent install to Trusted Root.
if ($InstallToTrustedRoot) {
    Write-Host ""
    Write-Host "[dev-sign] -InstallToTrustedRoot was specified." -ForegroundColor Yellow
    Write-Host "[dev-sign] Installing your dev cert to Trusted Root will let Windows trust" -ForegroundColor Yellow
    Write-Host "[dev-sign] any binary you sign with it, INCLUDING binaries signed by anything" -ForegroundColor Yellow
    Write-Host "[dev-sign] else that uses the same subject. This is YOUR machine; the impact" -ForegroundColor Yellow
    Write-Host "[dev-sign] is local-only. Recommended only on dev machines." -ForegroundColor Yellow
    $confirm = Read-Host "Proceed with install to CurrentUser\Root? (yes/no)"
    if ($confirm -eq 'yes') {
        $store = New-Object System.Security.Cryptography.X509Certificates.X509Store('Root', 'CurrentUser')
        $store.Open('ReadWrite')
        $store.Add($cert)
        $store.Close()
        Write-Host "[dev-sign] cert installed to CurrentUser\Root"
    } else {
        Write-Host "[dev-sign] skipped Trusted Root install"
    }
}

# Sign the binary with timestamp authority
$tsaUrl = 'http://timestamp.digicert.com'
Write-Host "[dev-sign] signing $BinaryPath"
& $signtool.Source sign `
    /sha1 $cert.Thumbprint `
    /fd SHA256 `
    /tr $tsaUrl `
    /td SHA256 `
    /d "stavR Governor (dev build)" `
    $BinaryPath
if ($LASTEXITCODE -ne 0) { Fail "signtool sign failed: $LASTEXITCODE" }

Write-Host ""
Write-Host "[dev-sign] verifying signature"
& $signtool.Source verify /pa /v $BinaryPath
$verifyExit = $LASTEXITCODE
if ($verifyExit -ne 0) {
    Write-Host "[dev-sign] note: verify returned $verifyExit — expected if cert is not in Trusted Root yet." -ForegroundColor Yellow
    Write-Host "[dev-sign] Re-run with -InstallToTrustedRoot to fix, or trust the cert manually." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "[dev-sign] OK: $BinaryPath signed with dev cert $($cert.Thumbprint)" -ForegroundColor Green
Write-Host "[dev-sign] REMINDER: dev signatures are local-only. Do not distribute." -ForegroundColor Cyan
