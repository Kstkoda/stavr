/**
 * tests/release/install-from-release.test.ts
 *
 * Shape tests for the verify-then-trust install scripts (BOM v0.6.5.1 P4).
 *
 * The whole point of the install path is that verification happens BEFORE
 * the operator runs the binary — so we test that:
 *
 *   - The installer invokes verify-release as a non-optional step
 *   - -SkipVerify / SKIP_VERIFY=1 exist as an escape hatch but are
 *     explicitly marked as not recommended
 *   - The tag pattern is narrow (v0.6.5*) so a daemon tag can't be
 *     fed to the Governor installer by mistake
 *   - SHA256 cross-check is in addition to (not instead of) Sigstore
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..');
const INSTALL_PS1 = join(REPO_ROOT, 'governor', 'scripts', 'install-from-release.ps1');
const INSTALL_SH = join(REPO_ROOT, 'governor', 'scripts', 'install-from-release.sh');
const INSTALL_DOCS = join(REPO_ROOT, 'docs', 'governor-install.md');

describe('Windows installer', () => {
  const ps = (() => {
    expect(existsSync(INSTALL_PS1)).toBe(true);
    return readFileSync(INSTALL_PS1, 'utf8');
  })();

  it('invokes verify-release.ps1 as a non-optional step', () => {
    expect(ps).toMatch(/verify-release\.ps1/);
  });

  it('rejects tags that do not match the v0.6.5* Governor pattern', () => {
    expect(ps).toMatch(/v0\\?\.6\\?\.5/);
    expect(ps).toMatch(/does not match Governor release pattern/);
  });

  it('cross-checks SHA256 in addition to Sigstore (defense in depth)', () => {
    expect(ps).toMatch(/SHA256SUMS\.txt/);
    expect(ps).toMatch(/Get-FileHash -Algorithm SHA256/);
  });

  it('exposes -SkipVerify as an escape hatch but warns it is not recommended', () => {
    expect(ps).toMatch(/SkipVerify/);
    expect(ps).toMatch(/NOT RECOMMENDED/i);
  });

  it('downloads SBOM alongside the binary', () => {
    expect(ps).toMatch(/stavr-governor\.sbom\.cdx\.json/);
  });
});

describe('Unix installer', () => {
  const sh = (() => {
    expect(existsSync(INSTALL_SH)).toBe(true);
    return readFileSync(INSTALL_SH, 'utf8');
  })();

  it('invokes verify-release.sh as a non-optional step', () => {
    expect(sh).toMatch(/verify-release\.sh/);
  });

  it('rejects tags that do not match the v0.6.5* Governor pattern', () => {
    expect(sh).toMatch(/v0\.6\.5\*/);
  });

  it('cross-checks SHA256 in addition to Sigstore', () => {
    expect(sh).toMatch(/SHA256SUMS\.txt/);
    expect(sh).toMatch(/sha256sum|shasum -a 256/);
  });

  it('exposes SKIP_VERIFY env var as an escape hatch but warns', () => {
    expect(sh).toMatch(/SKIP_VERIFY/);
    expect(sh).toMatch(/NOT RECOMMENDED/i);
  });

  it('is set -euo pipefail (fail fast)', () => {
    expect(sh).toMatch(/set -euo pipefail/);
  });
});

describe('Install docs', () => {
  it('exists at docs/governor-install.md', () => {
    expect(existsSync(INSTALL_DOCS)).toBe(true);
  });

  it('puts verify before run in the operator-facing flow', () => {
    const md = readFileSync(INSTALL_DOCS, 'utf8');
    expect(md).toMatch(/Verify before you run/);
  });

  it('documents the SAC reputation gap honestly', () => {
    // BOM footgun #1: Sigstore-signed != SAC-trusted on day one.
    const md = readFileSync(INSTALL_DOCS, 'utf8');
    expect(md).toMatch(/SAC reputation|reputation/i);
  });
});
