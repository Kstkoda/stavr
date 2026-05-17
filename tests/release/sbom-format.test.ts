/**
 * tests/release/sbom-format.test.ts
 *
 * Acceptance tests for the SBOM generation step (BOM v0.6.5.1 P2,
 * ADR-038 §1).
 *
 * Like signing-smoke.test.ts we can't run cargo cyclonedx in the unit
 * suite — that needs a Rust toolchain on every test runner — so we
 * guard the *shape* of:
 *
 *   - The workflow step that generates + signs the SBOM
 *   - The local helper scripts (gen-sbom.{ps1,sh}) so they stay
 *     pinned to the same cargo-cyclonedx version + output shape CI uses
 *
 * Pinning matters: a floating cargo-cyclonedx is a supply-chain
 * regression in itself (the very thing the SBOM is supposed to protect
 * against).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..');
const WORKFLOW_PATH = join(REPO_ROOT, '.github', 'workflows', 'governor-release.yml');
const GEN_SBOM_PS1 = join(REPO_ROOT, 'governor', 'scripts', 'gen-sbom.ps1');
const GEN_SBOM_SH = join(REPO_ROOT, 'governor', 'scripts', 'gen-sbom.sh');

// All three places must use the same pinned version. If you bump
// cargo-cyclonedx, bump all three and bump this constant in sync.
const PINNED_CYCLONEDX_VERSION = '0.5.7';

describe('SBOM generation in workflow', () => {
  const workflow = readFileSync(WORKFLOW_PATH, 'utf8');

  it('installs cargo-cyclonedx at the pinned version', () => {
    expect(workflow).toMatch(
      new RegExp(`cargo install cargo-cyclonedx --version ${PINNED_CYCLONEDX_VERSION.replace(/\./g, '\\.')}`),
    );
    expect(workflow).toMatch(/--locked/); // refuses to update Cargo.lock during install
  });

  it('emits SBOM in CycloneDX JSON format', () => {
    expect(workflow).toMatch(/cargo cyclonedx[^\n]*--format json/);
  });

  it('produces SBOM per target (not a single host-only SBOM)', () => {
    // Per-target SBOM matters: platform-specific crates (e.g.
    // winapi vs core-foundation-sys) differ across triples.
    expect(workflow).toMatch(/cargo cyclonedx[^\n]*--target/);
  });

  it('ships the SBOM as a release artifact named stavr-governor.sbom.cdx.json', () => {
    expect(workflow).toContain('stavr-governor.sbom.cdx.json');
  });

  it('signs the SBOM alongside the binary (no SBOM-skip path)', () => {
    // BOM hard rule #7: every signed artifact ships with a signed SBOM.
    expect(workflow).toMatch(/cosign sign-blob[^]*stavr-governor\.sbom\.cdx\.json/);
  });
});

describe('local SBOM helpers stay in sync with CI', () => {
  it('PowerShell helper pins cargo-cyclonedx to the same version', () => {
    const ps = readFileSync(GEN_SBOM_PS1, 'utf8');
    expect(ps).toContain(PINNED_CYCLONEDX_VERSION);
    expect(ps).toMatch(/cargo cyclonedx/);
    expect(ps).toMatch(/--format json/);
  });

  it('Bash helper pins cargo-cyclonedx to the same version', () => {
    const sh = readFileSync(GEN_SBOM_SH, 'utf8');
    expect(sh).toContain(PINNED_CYCLONEDX_VERSION);
    expect(sh).toMatch(/cargo cyclonedx/);
    expect(sh).toMatch(/--format json/);
  });

  it('helpers default the output filename to the CI-convention name', () => {
    // If the operator runs gen-sbom locally and the file lands at
    // stavr-governor.sbom.cdx.json, it slots straight into the CI
    // verification flow with no path translation.
    const ps = readFileSync(GEN_SBOM_PS1, 'utf8');
    const sh = readFileSync(GEN_SBOM_SH, 'utf8');
    expect(ps).toContain('stavr-governor.sbom.cdx.json');
    expect(sh).toContain('stavr-governor.sbom.cdx.json');
  });

  it('bash helper is set -euo pipefail', () => {
    const sh = readFileSync(GEN_SBOM_SH, 'utf8');
    expect(sh).toMatch(/set -euo pipefail/);
  });
});
