/**
 * tests/release/signing-smoke.test.ts
 *
 * Static-shape acceptance tests for the Governor release signing pipeline
 * (per BOM v0.6.5.1 P1 + ADR-038 §2).
 *
 * We cannot exercise the live Sigstore Fulcio/Rekor pipeline from unit
 * tests — that requires GitHub Actions OIDC and a tag push. Instead we
 * assert the *shape* of the workflow file and operator-side verification
 * helpers, which is enough to catch:
 *
 *   - Workflow trigger drift (e.g. someone accidentally widening to `v*`)
 *   - Missing `id-token: write` permission (cosign keyless fails silently
 *     without it)
 *   - Matrix targets going missing (regression risk per platform)
 *   - Signature command shape regressions
 *   - verify-release helpers losing the `--certificate-identity-regexp`
 *     guard (which is the *only* thing tying a signature to the stavR repo)
 *
 * If end-to-end signing breaks in practice, that surfaces via the smoke
 * tag (`v0.6.5-rc1`) defined in BOM v0.6.5.1 P4, not these unit tests.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..');
const WORKFLOW_PATH = join(REPO_ROOT, '.github', 'workflows', 'governor-release.yml');
const VERIFY_PS1 = join(REPO_ROOT, 'governor', 'scripts', 'verify-release.ps1');
const VERIFY_SH = join(REPO_ROOT, 'governor', 'scripts', 'verify-release.sh');

const EXPECTED_TARGETS = [
  'x86_64-pc-windows-msvc',
  'aarch64-pc-windows-msvc',
  'x86_64-apple-darwin',
  'aarch64-apple-darwin',
  'x86_64-unknown-linux-gnu',
];

describe('governor-release workflow shape', () => {
  const workflow = readFileSync(WORKFLOW_PATH, 'utf8');

  it('triggers narrowly on v0.6.5* tags (not all v* tags)', () => {
    // Per BOM P1 acceptance + footgun #3: tag pattern must be narrow so
    // daemon tags do not fire a Governor build.
    expect(workflow).toMatch(/tags:\s*\n\s*-\s*'v0\.6\.5\*'/);
    expect(workflow).not.toMatch(/tags:\s*\[\s*['"]v\*['"]\s*\]/);
  });

  it('grants id-token: write for cosign keyless OIDC', () => {
    // Per BOM footgun #2: cosign keyless silently fails without this.
    expect(workflow).toMatch(/id-token:\s*write/);
  });

  it('grants contents: write so the release assets can be uploaded', () => {
    expect(workflow).toMatch(/contents:\s*write/);
  });

  it.each(EXPECTED_TARGETS)('matrix includes target %s', (target) => {
    expect(workflow).toContain(target);
  });

  it('signs the binary via cosign sign-blob --yes (non-interactive)', () => {
    // Per ADR-038 §2: keyless signing must be non-interactive in CI.
    expect(workflow).toMatch(/cosign sign-blob --yes/);
    expect(workflow).toMatch(/--output-signature/);
    expect(workflow).toMatch(/--output-certificate/);
  });

  it('also signs the SBOM (every signed artifact ships a signed SBOM)', () => {
    // Per BOM hard rule #7: no SBOM-skip path.
    expect(workflow).toMatch(/stavr-governor\.sbom\.sig/);
    expect(workflow).toMatch(/stavr-governor\.sbom\.crt/);
  });

  it('uses --locked when building so SBOM accuracy is not undermined', () => {
    // Per BOM footgun #7: SBOM accuracy depends on a frozen Cargo.lock.
    expect(workflow).toMatch(/cargo build --release --locked/);
  });

  it('emits a SHA256SUMS.txt for the release', () => {
    expect(workflow).toMatch(/SHA256SUMS\.txt/);
  });

  it('uploads to a GitHub Release (softprops/action-gh-release)', () => {
    expect(workflow).toMatch(/softprops\/action-gh-release@/);
  });

  it('pins cosign-installer to a versioned release', () => {
    // Floating tags on signing infra are how supply-chain attacks happen.
    expect(workflow).toMatch(/sigstore\/cosign-installer@v\d+/);
    expect(workflow).toMatch(/cosign-release:\s*['"]v\d+\.\d+\.\d+['"]/);
  });
});

describe('operator-side verify-release helpers', () => {
  it('PowerShell helper exists and pins the stavR identity regexp', () => {
    const ps = readFileSync(VERIFY_PS1, 'utf8');
    expect(ps).toMatch(/https:\/\/github\.com\/Kstkoda\/stavr\/\.\*/);
    expect(ps).toMatch(/--certificate-identity-regexp/);
    expect(ps).toMatch(/--certificate-oidc-issuer/);
    expect(ps).toMatch(/token\.actions\.githubusercontent\.com/);
  });

  it('Bash helper exists and pins the stavR identity regexp', () => {
    const sh = readFileSync(VERIFY_SH, 'utf8');
    expect(sh).toMatch(/https:\/\/github\.com\/Kstkoda\/stavr\/\.\*/);
    expect(sh).toMatch(/--certificate-identity-regexp/);
    expect(sh).toMatch(/--certificate-oidc-issuer/);
    expect(sh).toMatch(/token\.actions\.githubusercontent\.com/);
  });

  it('helpers fail fast when signature companion files are missing', () => {
    const ps = readFileSync(VERIFY_PS1, 'utf8');
    const sh = readFileSync(VERIFY_SH, 'utf8');
    // Should explicitly check for .sig + .crt next to the binary
    expect(ps).toMatch(/\.sig/);
    expect(ps).toMatch(/\.crt/);
    expect(sh).toMatch(/SIG_PATH/);
    expect(sh).toMatch(/CRT_PATH/);
  });

  it('bash helper is set -euo pipefail (fails on first error)', () => {
    const sh = readFileSync(VERIFY_SH, 'utf8');
    expect(sh).toMatch(/set -euo pipefail/);
  });
});
