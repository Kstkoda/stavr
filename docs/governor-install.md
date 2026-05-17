# Installing a signed Governor release

> Per BOM v0.6.5.1 and ADR-038 §2. This is the operator-facing install
> guide; it intentionally pushes verification to the front of the flow.

Every distributed Governor binary is signed via Sigstore keyless
signing (GitHub Actions OIDC → Fulcio → Rekor transparency log). The
signature, certificate, and a CycloneDX SBOM ship alongside the binary
on the GitHub Release page. **Verify before you run** — that's what
lets Smart App Control / Gatekeeper trust the artifact on first launch
without disabling OS-level safety features.

## Quickstart

### Windows (PowerShell)

```powershell
# From a stavR checkout (or download just the scripts):
cd C:\dev\cowire\governor\scripts
.\install-from-release.ps1
# Downloads, SHA256-checks, Sigstore-verifies, and stages the binary in
# %USERPROFILE%\.stavr\governor.
```

You'll need `cosign` on PATH:

```powershell
winget install --id Sigstore.Cosign
```

### macOS / Linux

```bash
cd ~/dev/cowire/governor/scripts
./install-from-release.sh
```

You'll need `cosign` on PATH:

```bash
brew install cosign            # macOS
sudo apt-get install cosign    # Debian/Ubuntu (24.04+)
```

## What just happened

The installer:

1. Resolved the latest `v0.6.5*` release tag (or used `$VERSION` /
   `-Version` if you specified one).
2. Downloaded five files into `$INSTALL_DIR`:
   * `stavr-governor[.exe]` — the binary
   * `stavr-governor[.exe].sig` — cosign signature
   * `stavr-governor[.exe].crt` — Fulcio-issued ephemeral certificate
   * `stavr-governor.sbom.cdx.json` — CycloneDX SBOM
   * `SHA256SUMS.txt` — checksums for everything in the release
3. Cross-checked the binary's SHA256 against `SHA256SUMS.txt`
   (transport-integrity guard, complementary to Sigstore's
   provenance proof).
4. Invoked `verify-release.{ps1,sh}` which wraps `cosign verify-blob`
   with the stavR repo's identity regexp + GitHub Actions OIDC issuer.
   That step proves the binary came from a real workflow run in this
   repo, recorded in the public Rekor log.

Only after all four checks pass is the binary considered installed.

## Manual verify (without the installer)

If you downloaded artifacts manually:

```powershell
.\verify-release.ps1 -BinaryPath .\stavr-governor.exe
```

```bash
./verify-release.sh ./stavr-governor
```

Or invoke cosign directly:

```bash
cosign verify-blob \
  --certificate-identity-regexp 'https://github.com/Kstkoda/stavr/.*' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
  --signature stavr-governor.sig \
  --certificate stavr-governor.crt \
  stavr-governor
```

A successful verify means:

* The signature was produced by a GitHub Actions workflow in
  `Kstkoda/stavr`.
* The signing event was recorded in the Sigstore Rekor transparency
  log — publicly attestable, immutable.
* The artifact has not been tampered with since signing.

It does **not** mean:

* The signing workflow's secrets are uncompromised. (Trust the repo
  itself.)
* The transitive dependencies inside the binary are uncompromised.
  Audit the SBOM (`stavr-governor.sbom.cdx.json`) for that — feed it
  to Grype, Dependency-Track, Snyk, etc.

## Auditing the SBOM

```bash
# List all dependencies + versions
jq '.components[] | {name, version, licenses: [.licenses[]?.license.id]}' \
  stavr-governor.sbom.cdx.json

# Vulnerability scan with Grype (https://github.com/anchore/grype)
grype sbom:stavr-governor.sbom.cdx.json
```

The SBOM is itself signed (`stavr-governor.sbom.sig` +
`stavr-governor.sbom.crt`); verify it the same way as the binary if
you want belt-and-braces.

## Troubleshooting

### "cosign verify-blob: certificate identity mismatch"

The release was built from a fork or a different repo. Pass
`-IdentityRegexp` (PowerShell) or `IDENTITY_REGEXP=...` (bash) to
override.

### "cosign not on PATH"

Install per the Quickstart instructions, then re-open the shell so
PATH is refreshed.

### SAC still blocks the binary after a successful verify

Sigstore-signed does NOT mean SAC-trusted. SAC reputation is primarily
Microsoft cloud reputation; on a freshly-published artifact, you may
need to:

1. Click through SAC's "Run anyway" prompt (if exposed) — once is
   enough, the local machine remembers.
2. Confirm via Windows Security → App & Browser control → Smart App
   Control → "Reputation-based protection" panel.
3. Reputation typically builds over weeks. EV code-signing is the
   short-circuit (BOM open question §1 — deferred to v0.6.5.2+).

### "verify-release.ps1 not found"

The installer expects the verify helper next to itself. Either run
from a stavR checkout (so `governor/scripts/` is intact) or pass
`-SkipVerify` (NOT recommended) and verify manually using the cosign
command shown above.

## Why bother

The 2026-05-17 21:00 incident: a `cargo build --release` output was
killed by SAC on the operator's machine. The fix is not "disable SAC"
— SAC is a real safety layer — but rather "give the OS a signed
artifact it can validate against a public, immutable log." That is
exactly what this pipeline provides.

Every install run that uses the verify path leaves an auditable
record: the operator chose to trust this specific Sigstore log entry,
not a vague "the install button looked legit." For a personal tool
that holds GitHub credentials, OAuth tokens, and the operator's
signing key (per ADR-036), that's a meaningful difference.
