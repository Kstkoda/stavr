<#
.SYNOPSIS
    Generate a CycloneDX SBOM for the Governor crate for local builds.

.DESCRIPTION
    Wraps `cargo cyclonedx` with stavR's release conventions so an operator
    can produce the same SBOM shape locally that CI emits per the
    governor-release.yml workflow.

    This is a developer convenience: CI is the authoritative SBOM producer
    for distributed binaries (per ADR-038 §1, signed alongside the binary).
    Local SBOMs are useful for `cargo audit`-style local checks before push.

.PARAMETER Target
    Rust target triple (e.g. x86_64-pc-windows-msvc). Defaults to the
    host triple as reported by rustc.

.PARAMETER Output
    Output path for the SBOM JSON. Defaults to
    `governor\stavr-governor.sbom.cdx.json`.

.EXAMPLE
    .\gen-sbom.ps1
    .\gen-sbom.ps1 -Target aarch64-pc-windows-msvc -Output gov.cdx.json

.NOTES
    Per BOM v0.6.5.1 P2. Requires `cargo` and `cargo-cyclonedx` on PATH.
    Install via:
        cargo install cargo-cyclonedx --version 0.5.7 --locked
#>
[CmdletBinding()]
param(
    [string]$Target,
    [string]$Output = "stavr-governor.sbom.cdx.json"
)

$ErrorActionPreference = 'Stop'

function Fail($msg) {
    Write-Host "[gen-sbom] FAIL: $msg" -ForegroundColor Red
    exit 1
}

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    Fail "cargo not on PATH. Install Rust from https://rustup.rs/"
}

# Probe for cargo-cyclonedx (cargo subcommand presents as `cargo cyclonedx`).
$probe = & cargo cyclonedx --version 2>&1
if ($LASTEXITCODE -ne 0) {
    Fail "cargo-cyclonedx not installed. Run: cargo install cargo-cyclonedx --version 0.5.7 --locked"
}

if (-not $Target) {
    $rustcVerbose = & rustc -vV 2>&1
    $hostLine = $rustcVerbose | Select-String '^host:' | Select-Object -First 1
    if ($hostLine) {
        $Target = ($hostLine.ToString() -replace '^host:\s*', '').Trim()
    } else {
        Fail "Could not determine host target from rustc -vV"
    }
}

Push-Location (Join-Path $PSScriptRoot '..')
try {
    Write-Host "[gen-sbom] generating SBOM for target $Target" -ForegroundColor Cyan
    & cargo cyclonedx --target $Target --format json --output-pattern bom
    if ($LASTEXITCODE -ne 0) {
        Fail "cargo cyclonedx exited with code $LASTEXITCODE"
    }

    # cargo-cyclonedx emits <crate>.cdx.json next to Cargo.toml. Rename to
    # the conventional artifact name so the local SBOM is interchangeable
    # with the CI-published one.
    $emitted = Get-ChildItem -Filter '*.cdx.json' | Where-Object { $_.Name -notlike $Output } | Select-Object -First 1
    if ($emitted) {
        Move-Item -Force -Path $emitted.FullName -Destination $Output
    }

    if (-not (Test-Path $Output)) { Fail "SBOM output not produced at $Output" }
    $size = (Get-Item $Output).Length
    Write-Host "[gen-sbom] OK: $Output ($size bytes)" -ForegroundColor Green
} finally {
    Pop-Location
}
