# ADR-038 — Supply-chain integrity: SBOM, signing, provenance, automated updates

**Status:** Proposed
**Date:** 2026-05-17
**Related:** ADR-033 (stavr-tray companion / auto-update), ADR-036 (audit integrity), memory `project_stavr_team_repositioning_decision.md`

## Context

stavR runs with broad privileges on the operator's machine: shell access via host_exec (with allowlist), GitHub credentials, OAuth tokens to AI providers, the operator's Ed25519 signing key (per ADR-036), the credential vault. The "trust scopes" model assumes the operator trusts the daemon to enforce them faithfully.

That trust extends transitively to every npm dependency pulled in via `package.json` — and those number in the hundreds. `npm install` today gives no provenance signal: it just downloads tarballs from npm.js's CDN, trusts the registry metadata, and runs the resulting code. Recent supply-chain incidents (event-stream, ua-parser-js, colors.js, faker.js, the 2024 XZ backdoor) prove the threat model is real and ongoing.

For a single-operator personal tool, "I trust my own laptop" is a reasonable posture — but it doesn't extend to "I trust every transitive npm maintainer to never have their account compromised." For team mode (multiple operators sharing one stavR instance), the trust extends to "every transitive maintainer of every shared instance's deps." That's untenable without provenance.

Specific gaps:
- **No SBOM** — operator has no machine-readable inventory of what's actually installed
- **No release signing** — published binaries / npm packages have no cryptographic provenance proving Anthropic-or-Kenneth produced them
- **No npm provenance attestations** — even though npm now supports `--provenance` in `npm publish`, stavR's releases don't use it
- **No automated dep monitoring** — operator manually decides when to bump deps; security updates can lag
- **No vulnerability gating** — `npm audit` exists but isn't enforced in CI
- **Auto-update is unbuilt** — ADR-033 (Tauri 2 tray companion) sketches it; without supply-chain integrity, auto-update would AMPLIFY the threat by automatically pulling new code

## Decision

Adopt a four-layer supply-chain integrity baseline: **SBOM at build → Sigstore signing at release → npm provenance at publish → automated monitoring with policy gates**.

**1. SBOM at build (CycloneDX format).**

Add `@cyclonedx/cdxgen` as a dev-dep; run in CI on every PR and on every release:

```yaml
- name: Generate SBOM
  run: npx @cyclonedx/cdxgen -t nodejs -o sbom.cdx.json
- name: Upload SBOM artifact
  uses: actions/upload-artifact@v4
  with: { name: sbom, path: sbom.cdx.json }
```

Release artifacts include `sbom.cdx.json` alongside the binary. Format is CycloneDX 1.5 (industry standard, OWASP-maintained, supported by Dependency-Track, Snyk, GitHub, and most enterprise vulnerability scanners).

**2. Sigstore signing at release (cosign).**

GitHub Actions release workflow signs every artifact via cosign keyless signing (uses GitHub Actions OIDC token → Sigstore Fulcio → certificate → signature → Rekor transparency log). Operator verifies before install:

```bash
cosign verify-blob \
  --certificate-identity-regexp 'https://github.com/Kstkoda/stavr/.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --signature stavr-v0.X.Y.exe.sig \
  --certificate stavr-v0.X.Y.exe.crt \
  stavr-v0.X.Y.exe
```

Tauri 2 governor (ADR-033) does this verification automatically on auto-update. Manual install docs include the verify command.

Public Sigstore Rekor log entry means the signature is publicly attestable forever — even if the GitHub repo is deleted, the signature record persists.

**3. npm provenance at publish.**

If/when stavR publishes any npm packages (e.g., a `@stavr/sdk` for connector authors), use `npm publish --provenance`. This generates an attestation linking the published tarball to the exact GitHub Actions workflow run that built it (commit SHA, build env, etc.). Consumers can verify with `npm audit signatures`.

Not load-bearing today (no published packages), but mandatory before any first publish.

**4. Automated monitoring with policy gates.**

- **Renovate** (renovatebot.com — free for open source) — config in `.github/renovate.json` for grouped weekly PR runs, automerge on `patch` for known-safe libs (lodash, types, etc.), human review for `minor`/`major`
- **Dependabot** for npm security advisories — auto-files PRs for vulnerabilities, gated by CI before merge
- **npm audit** gate in CI: `npm audit --audit-level=high --production` blocks merge if any high/critical advisory exists in production deps
- **Sigstore policy-controller** (or simpler: a shell script in CI) — verifies that every release artifact has a valid Sigstore signature before publication

**5. Auto-update integrates the above.**

Tauri 2 governor (per ADR-033) updates daemon binaries. Update flow becomes:

1. Tray polls GitHub releases (or self-hosted release index) every N hours
2. Update found → tray downloads bundle + Sigstore signature + SBOM
3. Tray verifies signature via cosign (embedded in tray binary)
4. Tray displays diff to operator: version delta, changelog, SBOM diff (new/removed deps), CVE count change
5. Operator clicks "Update now" (or auto-applied if operator enabled and update is patch-level)
6. Tray stops daemon, swaps binary, restarts, health-checks, rolls back on failure

The SBOM diff in step 4 is what makes auto-update operator-meaningful: "this update adds 3 transitive deps, removes 1, no new CVEs."

## Consequences

**Positive:**
- Operator can answer "what's actually running?" at any time (SBOM)
- Operator can prove "this binary was built by the stavR GitHub Actions workflow on date X" without trusting GitHub (Sigstore Rekor is the trust anchor)
- Vulnerability patches reach the operator within hours (Renovate + Dependabot pipeline) instead of weeks
- Auto-update is safe — every update is cryptographically verified before swap
- Team mode operators can independently verify the same binary is running on all their machines (compare cosign attestations)
- External auditors / future enterprise pilots can demonstrate compliance posture with off-the-shelf SBOM tooling

**Negative we accept:**
- CI build time +30s for SBOM generation + signing — negligible
- CI may block merges on `npm audit` findings the operator considers low-risk; the workaround is documented (manual override commit with justification)
- Cosign verification dependency on the operator's machine (single binary, MIT licensed, widely deployed — but a dep nonetheless)
- Auto-update infrastructure (release index, GitHub Actions OIDC, Sigstore connectivity) adds a few moving parts to the release process — but standard, well-trodden
- Renovate noise — weekly PR digest can be 5-15 PRs; operator triages. Mitigated by auto-merge on safe patch-level changes
- If Sigstore Rekor goes offline (rare), verification falls back to the embedded certificate. Documented in operator docs.

## Alternatives considered

- **Status quo (no provenance)** — abdicates the trust question. Unacceptable for team direction.
- **GPG signing instead of Sigstore** — Sigstore is the 2026 standard; GPG ergonomics are notoriously poor (key management, expiry, web-of-trust). Reject.
- **Self-hosted signing infrastructure** — operator-controlled keys instead of GitHub OIDC. More operator burden, less auditability (no public Rekor entry). Reject for v1; reconsider if Sigstore Rekor becomes unavailable or for explicit air-gapped deployments.
- **SPDX SBOM format** — equivalent functionally; CycloneDX is more widely tooled in the 2026 npm ecosystem. Either works; pick one and stick.
- **Manual vulnerability monitoring** — Renovate + Dependabot are essentially free and well-tested. No reason to do this manually.
- **Reproducible builds** — would let third parties verify by re-building. Strong primitive but high complexity (deterministic Node build is hard). Future ADR if needed.

## Implementation notes (not part of decision)

- Initial CycloneDX run will reveal ~300 transitive deps; that number is the baseline. Subsequent SBOMs report deltas.
- Cosign keyless signing requires no key management (uses GitHub OIDC ephemeral keys via Fulcio) — much simpler than running a long-lived signing key.
- Renovate config should EXCLUDE breaking-change automerge — `major` always needs human review.
- The auto-update flow in step 6 needs a kill-switch: if Tauri governor itself is compromised, operator needs a way to disable auto-update from outside the governor (e.g., a flag file `~/.stavr/no-auto-update` that any process can create).
- npm packages published with `--provenance` show a green checkmark on npm.js with the workflow link. Good marketing signal once published.
- For team mode: each operator independently verifies signatures; no shared key material needed (Sigstore's design).

## Acceptance for moving Status to Accepted

This ADR moves to "Accepted" when:
1. CI produces a CycloneDX SBOM on every PR and release
2. GitHub Actions release workflow signs artifacts via cosign keyless
3. Operator docs include the verify-before-install instructions
4. Renovate config exists and has produced at least one round of dep updates that merged successfully
5. `npm audit --audit-level=high --production` runs as a CI gate
6. Tauri governor (per ADR-033) verifies signatures before applying updates — OR if governor not yet built, operator docs make manual verification the documented path
