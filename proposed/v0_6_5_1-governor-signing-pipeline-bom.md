# stavR · v0.6.5.1 — Governor binary signing pipeline (unblocks v0.6.5 on Windows SAC)

> Small focused PR. Implements ADR-038's Sigstore signing for the Governor binary specifically — unblocks operators on Windows 11 with Smart App Control (SAC) enabled, who can't run unsigned executables at all. Discovered 2026-05-17 ~21:00 GST when SAC killed the freshly-compiled Governor MVP binary on first launch. The broader ADR-038 SBOM + Sigstore + Renovate work for the daemon + npm is the larger v0.6.5.2+ BOM; this one is the narrow Governor-binary subset.

**Estimated wall-clock**: 3–4 hours CC sequential. Single PR.

**Sensitivity**: `high` per CLAUDE.md §9 — touches release pipeline, security primitives, GitHub Actions OIDC secrets, build artifacts that operators will trust on first launch.

**Stop conditions**: end of any phase if `npm test` regresses, `cargo build` regresses, the GitHub Actions workflow can't produce a verifiable signed artifact, or any test demonstrates the signature can be forged offline (Sigstore relies on transparency log; this should be impossible but verify).

**Do NOT pause for approval** between phases. Open PR at end of P4.

---

## Why this matters

The 2026-05-17 21:00 incident: operator built Governor MVP locally via `cargo build --release`. SAC (Win11 Smart App Control) killed the unsigned binary at launch. SAC is **stricter than Defender** — it blocks ANY unsigned executable without Microsoft cloud reputation, regardless of allowlisting. Once SAC is enabled, it can only be turned OFF (irreversible without OS reinstall). Operator correctly chose NOT to disable SAC — that's a real safety layer.

Without code signing, the Governor binary is unrunnable on:
- Windows 11 with SAC enabled (most consumer Win11 installs)
- macOS without Gatekeeper bypass + notarization
- Some Linux distros with strict signing policies (rare but exists)

This is structural — every distribution of the Governor needs to be signed to install. ADR-038 already specified the answer: **Sigstore cosign keyless via GitHub Actions OIDC**. This BOM implements that for the Governor binary.

Per ADR-038 §1-§4: SBOM generation + Sigstore signing + npm provenance + Renovate are the four supply-chain pillars. This BOM ships pillars 1 (SBOM for Governor) + 2 (signing for Governor). Pillars 3 (npm) + 4 (Renovate) and SBOM-for-daemon are separate BOMs.

---

## Reference reading

1. `CLAUDE.md` — invariants
2. `adr/038-supply-chain-integrity.md` — the parent architecture; this BOM is its first concrete implementation
3. `adr/033-stavr-tray-companion.md` — original Tauri tray sketch (Governor is its implementation)
4. `proposed/v0_6_5-governor-mvp-bom.md` — the Governor MVP whose binary needs signing
5. `governor/tauri.conf.json` — Tauri 2 build config (extend with signing section)
6. `.github/workflows/governor-build.yml` — existing cross-platform build matrix (this BOM extends to release flow)
7. Sigstore cosign docs: https://docs.sigstore.dev/cosign/system_config/keyless/
8. Tauri 2 code signing docs: https://v2.tauri.app/distribute/sign/

---

## Don't touch

- Governor source code (`governor/src/*`) — signing is build-time + release-time, not runtime
- ADR-038 itself — extend through implementation, don't amend
- Existing daemon (`src/*`) — signing for daemon is a separate BOM (v0.6.5.2+)
- PM2 ecosystem config — Governor signing doesn't change daemon supervision
- Trust scope / event taxonomy — no runtime changes
- npm package metadata — npm provenance is a separate ADR-038 pillar, separate BOM
- The existing `governor-build.yml` workflow's BUILD job — extend it; don't replace

---

## Hard rules

1. **Tests are derivative** — if existing CI tests assert "build artifact is `stavr-governor.exe`", update to assert presence of `.sig` + `.crt` alongside
2. **Never lose files** — `stat -c %s` + `tail -5` for any file >15KB
3. **Status-check before every git op** (CLAUDE.md §8)
4. **Sigstore keyless ONLY in CI** — never check private keys into repo, never use long-lived signing keys. Sigstore Fulcio + Rekor + OIDC is the only signing path for releases
5. **Local-build self-signed cert is OPERATOR-ONLY** — a helper script (PowerShell + bash) for operator's own dev builds; never used in CI; signature embeds operator's identity, not stavR project identity
6. **Verifiability**: every released signed binary MUST be verifiable via the public `cosign verify-blob` command using only the Sigstore Rekor public log — no private trust state required by the operator's verification machine
7. **No SBOM-skip path** — every signed artifact ships with a CycloneDX SBOM next to it. Operator can audit what's inside the binary.
8. **DCO -s, per-phase commits, push at end of each phase. Single PR.**

---

## P0 · Pre-flight (Kenneth, before CC kicks off)

~3 min:
1. `git status` clean on `main`; PR #34 (Governor MVP PR #1) status: unmerged but content is on `feat/v0.6.5-governor-mvp-pr1`. This BOM lands a SEPARATE branch `feat/v0.6.5.1-signing-pipeline` from main (NOT from the Governor branch — keeps signing pipeline independent so it can merge before or after Governor MVP)
2. `npm test --run` baseline = current passing count
3. Confirm GitHub repo settings: Actions enabled, OIDC permissions enabled (Settings → Actions → General → Workflow permissions → "Read and write permissions" + "Allow GitHub Actions to create and approve pull requests")
4. Dispatch CC with this brief

---

## P1 · GitHub Actions release workflow with cosign signing (1.5h)

**Files**:
- `.github/workflows/governor-release.yml` (new) — separate from existing `governor-build.yml`; triggers on tag push (`v*`)
- `governor/scripts/verify-release.ps1` + `verify-release.sh` (operator-side verification helpers)
- `tests/release/signing-smoke.test.ts` (new) — verifies the workflow produces signed artifacts

### Workflow shape

Trigger: push of tag matching `v0.6.5*` (governor releases tagged separately from daemon)

```yaml
name: Governor release (signed)
on:
  push:
    tags: ['v0.6.5*']

permissions:
  id-token: write    # OIDC for cosign keyless
  contents: write    # GitHub Release upload
  attestations: write  # attestation API

jobs:
  build-and-sign:
    strategy:
      matrix:
        include:
          - { os: windows-2025, target: x86_64-pc-windows-msvc }
          - { os: windows-2025, target: aarch64-pc-windows-msvc }
          - { os: macos-14, target: x86_64-apple-darwin }
          - { os: macos-14, target: aarch64-apple-darwin }
          - { os: ubuntu-24.04, target: x86_64-unknown-linux-gnu }
    runs-on: ${{ matrix.os }}
    steps:
      - checkout
      - install Rust + target
      - cargo build --release --target ${{ matrix.target }} (in governor/)
      - install cosign + cyclonedx
      - generate SBOM: cyclonedx-cli output → governor-${{ matrix.target }}.sbom.cdx.json
      - sign binary: cosign sign-blob --yes --output-signature stavr-governor.sig --output-certificate stavr-governor.crt stavr-governor[.exe]
      - sign SBOM: cosign sign-blob --yes --output-signature governor.sbom.sig --output-certificate governor.sbom.crt governor.sbom.cdx.json
      - upload artifacts to release
```

### Release artifact layout (per platform)

For `v0.6.5-windows-x86_64`:
- `stavr-governor.exe` (the binary)
- `stavr-governor.exe.sig` (cosign signature)
- `stavr-governor.exe.crt` (Fulcio-issued certificate)
- `stavr-governor.sbom.cdx.json` (CycloneDX SBOM)
- `stavr-governor.sbom.sig` + `stavr-governor.sbom.crt` (SBOM also signed)
- `SHA256SUMS.txt` (checksums for everything)

### Operator-side verify helper

`governor/scripts/verify-release.ps1`:

```powershell
# Usage: .\verify-release.ps1 -BinaryPath .\stavr-governor.exe
param([string]$BinaryPath)
$dir = Split-Path $BinaryPath -Parent
$name = Split-Path $BinaryPath -Leaf
# Verify binary signature against Sigstore Rekor public log
cosign verify-blob `
  --certificate-identity-regexp 'https://github.com/Kstkoda/stavr/.*' `
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' `
  --signature "$dir\$name.sig" `
  --certificate "$dir\$name.crt" `
  "$BinaryPath"
if ($LASTEXITCODE -eq 0) { Write-Host "✓ Binary signature valid (Sigstore Rekor)" -ForegroundColor Green }
else { Write-Host "✗ Verification failed" -ForegroundColor Red; exit 1 }
```

### Acceptance

- `governor-release.yml` exists and validates as a workflow file
- Tag `v0.6.5-test` triggers a build + signing run on all 5 matrix targets
- Each artifact uploaded to GitHub Release page
- `cosign verify-blob` against the Rekor public log succeeds for every artifact
- Operator-side helper script verifies a downloaded binary in one command
- 4+ tests (mocked workflow run; one per matrix target's expected artifact layout)

### Commit
`feat(release): GitHub Actions cosign keyless signing for Governor binary (closes ADR-038 §2 for Governor)`

---

## P2 · CycloneDX SBOM generation (45 min)

**Files**:
- `governor/scripts/gen-sbom.ps1` + `gen-sbom.sh` (developer-side SBOM generation for local builds)
- `.github/workflows/governor-release.yml` — extend with SBOM step (per P1 outline)
- `tests/release/sbom-format.test.ts` — assert SBOM has expected metadata fields

### SBOM contents (CycloneDX 1.5 spec)

For Governor binary, the SBOM should declare:
- Component: `stavr-governor` version + license + author
- Dependencies: all Rust crates from `Cargo.lock` flattened (cargo-cyclonedx generates this)
- Hash digests per dependency (SHA-256)
- License per dependency
- Vulnerabilities (if any known per OSV database at build time)

Tool: `cargo-cyclonedx` (Rust crate) generates the SBOM directly from Cargo.lock — no separate dep analysis needed.

### Acceptance

- SBOM generated for each platform build (cargo deps differ per target due to platform-specific crates)
- SBOM signed alongside binary
- Operator can parse SBOM in standard tools (e.g., Dependency-Track, Grype)
- 3+ tests asserting SBOM presence + structure

### Commit
`feat(release): CycloneDX SBOM generation per platform target (closes ADR-038 §1 for Governor)`

---

## P3 · Local-build self-signing helper (operator dev workflow) (1h)

**Files**:
- `governor/scripts/dev-sign.ps1` — Windows self-sign helper
- `governor/scripts/dev-sign.sh` — macOS/Linux self-sign helper (uses operator's GPG or cosign with local key)
- `docs/governor-local-dev.md` — operator instructions for local dev builds

### Why this exists

Operator running `cargo build --release` locally for development gets an unsigned binary. SAC kills it. Sigstore keyless requires CI OIDC — not available locally.

For dev workflow: operator can self-sign their own dev builds with a self-generated cert. The signature:
- Embeds operator's identity (their CN, their key)
- Tells Windows "operator self-signed this for development use"
- May or may not satisfy SAC (operator-dependent on their Win11 SAC trust profile)

This is operator-only, not for distribution. The dev cert never goes near CI.

### Sub-tasks

1. `dev-sign.ps1`:
   - Generate or reuse operator's self-signed cert in CurrentUser\My
   - SignTool sign the binary with timestamp authority
   - Optionally install cert to Trusted Root (with operator consent prompt)
   - Print signature info

2. `dev-sign.sh` (macOS/Linux):
   - On macOS: use `codesign` with operator's developer cert (if any) OR ad-hoc signing
   - On Linux: use `gpg --detach-sign` for binary verification (Linux signing semantics are weaker)

3. `docs/governor-local-dev.md`:
   - Why local dev builds need signing (SAC context)
   - Step-by-step: generate cert → trust cert → sign → run
   - Warning: dev signature ≠ release signature; never distribute dev-signed binaries
   - How to clean up dev cert when done

### Acceptance

- Operator can self-sign a local dev build in one command
- Self-signed binary runs successfully when operator's cert is trusted (manual setup required, documented)
- Docs cover the dev workflow end-to-end
- 2+ smoke tests (Windows + Linux paths)

### Commit
`feat(release): local-build self-signing helpers + dev workflow docs`

---

## P4 · Smoke-test workflow + operator install docs (45 min)

**Files**:
- `governor/scripts/install-from-release.ps1` — download + verify + install signed release binary
- `governor/scripts/install-from-release.sh`
- `docs/governor-install.md` — operator install guide (verify-then-install flow)
- `CHANGELOG.md` v0.6.5.1 entry

### Smoke-test workflow

Push a test tag `v0.6.5-rc1` → workflow runs → verify artifacts exist → run `cosign verify-blob` against the actual published artifacts to confirm Sigstore round-trip works end-to-end.

### Operator install docs

The install flow (per platform):

```powershell
# Windows install (PowerShell, ~30 seconds):
# 1. Download the release zip from GitHub
$release = 'v0.6.5'
$arch = 'x86_64'  # or aarch64
Invoke-WebRequest "https://github.com/Kstkoda/stavr/releases/download/$release/stavr-governor-windows-$arch.zip" -OutFile $env:TEMP\gov.zip
Expand-Archive $env:TEMP\gov.zip $env:USERPROFILE\.stavr\governor -Force

# 2. Verify signature before running (this is critical — SAC will trust it once Sigstore-verified)
.\verify-release.ps1 -BinaryPath $env:USERPROFILE\.stavr\governor\stavr-governor.exe
# Expected: "✓ Binary signature valid (Sigstore Rekor)"

# 3. First run (Governor sets up its own autostart later via v0.6.5 PR #2)
& $env:USERPROFILE\.stavr\governor\stavr-governor.exe
```

### Acceptance

- Operator can install + verify in <60 seconds
- Verification succeeds against actually-published binary
- CHANGELOG entry comprehensive

### Commit
`docs(release): operator install guide + smoke-test workflow tag`

### Open PR

`feat(release): Governor binary signing pipeline (Sigstore + SBOM + dev helpers) — closes ADR-038 §1+§2 for Governor (closes v0.6.5.1)`

---

## Budget

- **Time**: 3–4h CC, single PR
- **API cost**: ~$5–8
- **LOC change**: ~600–900 (mostly YAML workflow + PowerShell/Bash scripts + small TS test files)
- **Token cap**: 500k
- **New deps**: `cargo-cyclonedx` (Rust dev dep, CI-only), `cosign` (CI-side via `sigstore/cosign-installer@v3` action)
- **Schema change**: none

---

## Footgun appendix

1. **SAC reputation lag** — even with Sigstore-signed binary, SAC may initially block on first download because Microsoft's cloud reputation hasn't seen the artifact. Common reputation gain: 100-1000 downloads from Microsoft user base, takes days-to-weeks. EV code-signing cert from a recognized CA short-circuits this but costs $300-500/year — separate decision.
2. **Cosign keyless requires GitHub Actions OIDC** — workflow MUST have `id-token: write` permission. Easy to miss; verify in workflow file + test the OIDC handshake explicitly.
3. **Tag-trigger discipline** — release workflow fires on tag push; ensure tag pattern matches narrowly (`v0.6.5*` not `v*` — last thing you want is a daemon tag triggering a Governor build).
4. **macOS notarization is separate from cosign** — Sigstore-signed macOS binary still needs `xcrun notarytool submit` for Gatekeeper trust. Out of scope for v0.6.5.1 (operator can `xattr -d com.apple.quarantine` for dev; full notarization is v0.6.5.2+).
5. **Linux signing is weaker semantically** — no equivalent of SAC. Verify-blob via cosign works but distribution-level trust depends on operator's package manager + their config. Document as "verify-then-trust" rather than "trust by default."
6. **Rekor log retention** — Sigstore Rekor logs are public and immutable. Once a binary is signed-and-logged, that signature is permanent. Don't sign something embarrassing in CI; revocation isn't really a concept.
7. **SBOM accuracy depends on Cargo.lock** — `cargo-cyclonedx` reads Cargo.lock. If lockfile is stale or operator hand-edits dependencies, SBOM lies. CI should always do `cargo build --frozen` or `--locked` before SBOM gen.
8. **Self-signed dev cert is per-operator** — if you share dev-signed binaries with a colleague, their machine doesn't trust YOUR cert. Not a distribution path.
9. **SignTool requires Windows SDK** — bundled with VS Build Tools (which the operator already installed today). Mention in dev-sign.ps1 prerequisites.
10. **Cosign verify-blob is paranoid about Subject** — the `--certificate-identity-regexp` must match the actual OIDC subject the GitHub Actions OIDC token has. If repo path changes (rename, fork), regenerate the regex.

---

## Open questions (FLAGGED — do not pre-answer)

### §1 — Should we also obtain a real EV/OV code-signing certificate to give SAC immediate trust?

EV cert ($300-500/year from DigiCert/Sectigo) gives immediate SAC compatibility without waiting for Microsoft reputation. The trade-off is annual cost + cert management overhead.

**Default**: NO in v0.6.5.1. Sigstore keyless is the right primitive; let Microsoft reputation build naturally. Revisit if operator + small team find themselves frequently waiting for first-install SAC-trust.

### §2 — Should the workflow run on every push to main (continuous release-bot style) or only on tag push?

Default: tag push only. Continuous release would spam GitHub Releases. Tagging is intentional + operator-controlled.

### §3 — Should the dev-sign helper auto-install operator's cert to Trusted Root?

Adding to Trusted Root is a sensitive operation (browser HTTPS trust, etc). Default: prompt operator with explicit confirmation. Never silent.

### §4 — Should SBOM be a required-or-optional release asset?

Default: REQUIRED. SBOM is small (~5-50KB JSON). Always shipping it makes operator audit trivial. No reason to make it opt-in.

### §5 — Should we mirror release artifacts to a stavR-controlled CDN for download reliability if GitHub is down?

Default: NO in v0.6.5.1. GitHub Releases CDN is reliable enough for stavR's scale. Operator can always rebuild from source via the workflow file. Mirror is a v0.9+ federation-era concern.

---

## Run prompt for CC (paste at start)

```
Read CLAUDE.md first. Then read proposed/v0_6_5_1-governor-signing-pipeline-bom.md and execute P0-P4 sequentially.

Sensitivity: HIGH. Touches release pipeline + Sigstore + GitHub Actions OIDC. Status-check before every mutating git op (CLAUDE.md §8).

Work on a NEW branch: `git checkout -b feat/v0.6.5.1-signing-pipeline` from latest main. NOT from the Governor branch — keep signing pipeline independent. Never commit to main.

Rules:
- One commit per phase, DCO -s
- Don't pause for approval between phases
- For any file >15KB after edit, `stat -c %s file` + `tail -5 file` BEFORE git add
- `npm test` must pass after every commit (no Engine-side changes; verify)
- After P4 opens PR, output final delta report and STOP. Don't auto-merge.

Reference context:
- 2026-05-17 ~21:00 GST: SAC killed unsigned Governor binary on operator's Win11. Validates ADR-038 as required, not optional.
- ADR-038 §1+§2 are the parent architecture; this BOM implements them for Governor specifically. ADR-038 §3 (npm provenance) + §4 (Renovate) are SEPARATE BOMs (v0.6.5.2+).
- Open questions §1-§5 flagged — pick conservative default during implementation.

Smoke-test acceptance: tag `v0.6.5-rc1` on the merged main MUST trigger workflow + produce signed artifacts that operator can `cosign verify-blob` successfully. If this end-to-end works, BOM is complete.

Go.
```

---

## End of brief
