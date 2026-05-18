<#
.SYNOPSIS
    Verify a signed stavR Governor release binary against Sigstore Rekor.

.DESCRIPTION
    Wraps `cosign verify-blob` with the identity/issuer expected for stavR
    Governor releases produced by `.github/workflows/governor-release.yml`.

    The verification proves that the binary was built and signed by the
    stavR repository's GitHub Actions workflow, with the signature recorded
    in the public Sigstore Rekor transparency log.

.PARAMETER BinaryPath
    Path to the downloaded `stavr-governor.exe` (or matching `.sig`/`.crt`).

.PARAMETER IdentityRegexp
    Override the certificate-identity regexp. Defaults to the stavR repo.
    Useful if you fork the repo and run your own signed releases.

.EXAMPLE
    .\verify-release.ps1 -BinaryPath $env:USERPROFILE\.stavr\governor\stavr-governor.exe

.NOTES
    Requires `cosign` on PATH. Install on Windows via:
        winget install --id Sigstore.Cosign

    Per BOM v0.6.5.1, this is the operator-side verification flow.
    Per ADR-038 §2, Sigstore keyless signing is the only release-time signing path.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$BinaryPath,

    [string]$IdentityRegexp = 'https://github.com/Kstkoda/stavr/.*',

    [string]$OidcIssuer = 'https://token.actions.githubusercontent.com'
)

$ErrorActionPreference = 'Stop'

function Fail($msg) {
    Write-Host "[verify-release] FAIL: $msg" -ForegroundColor Red
    exit 1
}

if (-not (Test-Path $BinaryPath)) { Fail "Binary not found: $BinaryPath" }

$sigPath = "$BinaryPath.sig"
$crtPath = "$BinaryPath.crt"
if (-not (Test-Path $sigPath)) { Fail "Signature file missing: $sigPath" }
if (-not (Test-Path $crtPath)) { Fail "Certificate file missing: $crtPath" }

$cosign = Get-Command cosign -ErrorAction SilentlyContinue
if (-not $cosign) {
    Fail "cosign is not on PATH. Install via 'winget install --id Sigstore.Cosign' and retry."
}

Write-Host "[verify-release] Verifying $BinaryPath" -ForegroundColor Cyan
Write-Host "[verify-release]   identity-regexp = $IdentityRegexp"
Write-Host "[verify-release]   oidc-issuer     = $OidcIssuer"

& cosign verify-blob `
    --certificate-identity-regexp $IdentityRegexp `
    --certificate-oidc-issuer $OidcIssuer `
    --signature $sigPath `
    --certificate $crtPath `
    $BinaryPath

if ($LASTEXITCODE -eq 0) {
    Write-Host "[verify-release] OK: signature valid (Sigstore Rekor)" -ForegroundColor Green
    exit 0
} else {
    Fail "cosign verify-blob returned exit code $LASTEXITCODE"
}
