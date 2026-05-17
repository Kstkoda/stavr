/**
 * tests/release/dev-sign-helpers.test.ts
 *
 * Smoke tests for the local-build self-signing helpers
 * (BOM v0.6.5.1 P3 acceptance: 2+ smoke tests across Windows + Linux paths).
 *
 * Like the other release tests we can't actually exercise signtool /
 * codesign / gpg from the unit suite — they need a real cert store, a
 * built binary, and a host signing toolchain. Instead we guard:
 *
 *   - The helpers exist on disk at the conventional paths
 *   - They embed the BOM's safety invariants (operator confirmation
 *     before Trusted Root install, dev-signature warning visible)
 *   - The docs file enumerates the cleanup path so an operator can
 *     remove the dev cert when done
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..');
const DEV_SIGN_PS1 = join(REPO_ROOT, 'governor', 'scripts', 'dev-sign.ps1');
const DEV_SIGN_SH = join(REPO_ROOT, 'governor', 'scripts', 'dev-sign.sh');
const LOCAL_DEV_DOCS = join(REPO_ROOT, 'docs', 'governor-local-dev.md');

describe('Windows dev-sign helper', () => {
  it('exists at governor/scripts/dev-sign.ps1', () => {
    expect(existsSync(DEV_SIGN_PS1)).toBe(true);
  });

  it('uses SignTool with SHA256 + RFC 3161 timestamp', () => {
    const ps = readFileSync(DEV_SIGN_PS1, 'utf8');
    expect(ps).toMatch(/signtool/i);
    expect(ps).toMatch(/\/fd SHA256/);
    expect(ps).toMatch(/\/tr /);
    expect(ps).toMatch(/\/td SHA256/);
  });

  it('prompts before installing the dev cert to Trusted Root', () => {
    // BOM open question §3 conservative default: never silent install.
    const ps = readFileSync(DEV_SIGN_PS1, 'utf8');
    expect(ps).toMatch(/Read-Host/);
    expect(ps).toMatch(/InstallToTrustedRoot/);
  });

  it('warns that dev signatures are not for distribution', () => {
    const ps = readFileSync(DEV_SIGN_PS1, 'utf8');
    expect(ps).toMatch(/do not distribute/i);
  });

  it('reuses an existing dev cert instead of generating a fresh one', () => {
    // Keeps the operator's CurrentUser\My from filling up across runs.
    const ps = readFileSync(DEV_SIGN_PS1, 'utf8');
    expect(ps).toMatch(/reusing cert/);
  });
});

describe('Unix dev-sign helper', () => {
  it('exists at governor/scripts/dev-sign.sh', () => {
    expect(existsSync(DEV_SIGN_SH)).toBe(true);
  });

  it('uses codesign on Darwin and GPG-detach on Linux', () => {
    const sh = readFileSync(DEV_SIGN_SH, 'utf8');
    expect(sh).toMatch(/Darwin/);
    expect(sh).toMatch(/codesign/);
    expect(sh).toMatch(/Linux/);
    expect(sh).toMatch(/gpg --detach-sign/);
  });

  it('prefers a real Developer ID identity over ad-hoc on Darwin', () => {
    const sh = readFileSync(DEV_SIGN_SH, 'utf8');
    expect(sh).toMatch(/Developer ID Application/);
  });

  it('warns that dev signatures are not for distribution', () => {
    const sh = readFileSync(DEV_SIGN_SH, 'utf8');
    expect(sh).toMatch(/do not distribute/i);
  });

  it('is set -euo pipefail (fails on first error)', () => {
    const sh = readFileSync(DEV_SIGN_SH, 'utf8');
    expect(sh).toMatch(/set -euo pipefail/);
  });
});

describe('Local dev docs', () => {
  it('exists at docs/governor-local-dev.md', () => {
    expect(existsSync(LOCAL_DEV_DOCS)).toBe(true);
  });

  it('documents cert cleanup for both CurrentUser\\My and Trusted Root', () => {
    const md = readFileSync(LOCAL_DEV_DOCS, 'utf8');
    expect(md).toMatch(/Cert:\\CurrentUser\\My/);
    expect(md).toMatch(/Cert:\\CurrentUser\\Root/);
  });

  it('cross-references verify-release for the opposite direction', () => {
    const md = readFileSync(LOCAL_DEV_DOCS, 'utf8');
    expect(md).toMatch(/verify-release/);
  });
});
