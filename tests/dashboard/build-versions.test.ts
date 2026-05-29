import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCopyString,
  formatUptime,
  snapshotBuildVersions,
  _readGitShaForTests,
} from '../../src/dashboard/data/build-versions.js';

describe('v0.6.8 Section 0 — buildCopyString', () => {
  it('produces a pipe-separated grep-friendly bug-report line', () => {
    const s = buildCopyString({
      daemonVersion: '0.6.5',
      daemonGitSha: '1022fee',
      stewardStatus: 'up',
      stewardModelRuntime: 'anthropic',
      governorVersion: '0.6.5',
      governorStatus: 'cosign-signed',
      nodeVersion: 'v20.18.1',
      buildTimestamp: '2026-05-18T14:32Z',
      buildRunNumber: '126',
    });
    expect(s).toContain('stavR v0.6.5/1022fee');
    expect(s).toContain('steward up/anthropic');
    expect(s).toContain('governor v0.6.5/cosign-signed');
    expect(s).toContain('node v20.18.1');
    expect(s).toContain('build 2026-05-18T14:32Z (run #126)');
    expect(s.split(' · ').length).toBe(5);
  });

  it('handles partial / null fields gracefully', () => {
    const s = buildCopyString({
      daemonVersion: '0.1.0',
      daemonGitSha: null,
      stewardStatus: 'unwired',
      stewardModelRuntime: null,
      governorVersion: null,
      governorStatus: 'not-running',
      nodeVersion: 'v20.18.1',
      buildTimestamp: null,
      buildRunNumber: null,
    });
    expect(s).toContain('stavR v0.1.0');
    expect(s).not.toContain('//');
    expect(s).toContain('steward unwired');
    expect(s).toContain('governor not-built');
    expect(s).toContain('node v20.18.1');
    expect(s).not.toContain('build ');
  });
});

describe('v0.6.8 Section 0 — formatUptime', () => {
  it('renders sub-minute as seconds', () => {
    expect(formatUptime(0)).toBe('0s');
    expect(formatUptime(45)).toBe('45s');
  });
  it('renders sub-hour as minutes', () => {
    expect(formatUptime(60)).toBe('1m');
    expect(formatUptime(60 * 23)).toBe('23m');
  });
  it('renders sub-day as hours + optional minutes', () => {
    expect(formatUptime(3600)).toBe('1h');
    expect(formatUptime(3600 * 4 + 60 * 12)).toBe('4h 12m');
  });
  it('renders multi-day as days + optional hours', () => {
    expect(formatUptime(86400 * 2)).toBe('2d');
    expect(formatUptime(86400 * 2 + 3600 * 5)).toBe('2d 5h');
  });
  it('handles malformed input gracefully', () => {
    expect(formatUptime(-1)).toBe('?');
    expect(formatUptime(NaN)).toBe('?');
  });
});

describe('v0.6.8 Section 0 — git SHA discovery', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'stavr-bv-test-'));
    mkdirSync(join(root, '.git'), { recursive: true });
    mkdirSync(join(root, '.git', 'refs', 'heads'), { recursive: true });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reads ref-style HEAD via the referenced ref file', () => {
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(root, '.git', 'refs', 'heads', 'main'), 'abcdef1234567890\n');
    expect(_readGitShaForTests(root, {})).toBe('abcdef1');
  });

  it('reads detached HEAD (raw 40-char SHA)', () => {
    writeFileSync(join(root, '.git', 'HEAD'), 'fedcba9876543210fedcba9876543210fedcba98\n');
    expect(_readGitShaForTests(root, {})).toBe('fedcba9');
  });

  it('falls back to packed-refs when the loose ref is missing', () => {
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(
      join(root, '.git', 'packed-refs'),
      '# pack-refs with: peeled fully-peeled sorted\n9999aaaa1111222233334444555566667777eeee refs/heads/main\n',
    );
    expect(_readGitShaForTests(root, {})).toBe('9999aaa');
  });

  it('honours GIT_SHA env override (CI build injection)', () => {
    expect(_readGitShaForTests(root, { GIT_SHA: 'deadbeefcafe' })).toBe('deadbee');
  });

  it('returns null when no git state is available', () => {
    rmSync(join(root, '.git'), { recursive: true });
    expect(_readGitShaForTests(root, {})).toBeNull();
  });
});

describe('v0.6.8 Section 0 — snapshotBuildVersions integration', () => {
  it('reads the daemon package.json from the real repo root', () => {
    const s = snapshotBuildVersions();
    expect(s.daemonVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(s.nodeVersion).toMatch(/^v\d+\./);
    expect(s.copyString).toContain('stavR v');
    expect(s.copyString).toContain('node v');
    expect(typeof s.daemonUptimeSeconds).toBe('number');
  });

  it('reports governor not-running when no heartbeat is supplied', () => {
    const s = snapshotBuildVersions();
    expect(s.governorStatus).toBe('not-running');
  });

  it('reports cosign-signed when heartbeat carries that signing kind', () => {
    const s = snapshotBuildVersions({
      governorHeartbeat: { version: '0.6.5', signing: 'cosign-signed' },
    });
    expect(s.governorStatus).toBe('cosign-signed');
  });

  it('reports steward status from the injected snapshot', () => {
    const s = snapshotBuildVersions({
      steward: { status: 'up', model_runtime: 'anthropic' },
    });
    expect(s.stewardStatus).toBe('up');
    expect(s.stewardModelRuntime).toBe('anthropic');
    expect(s.copyString).toContain('steward up/anthropic');
  });

  it('exposes CI build identity when env vars are set', () => {
    const s = snapshotBuildVersions({
      env: {
        BUILD_TIMESTAMP: '2026-05-19T05:00Z',
        GITHUB_RUN_NUMBER: '127',
      } as NodeJS.ProcessEnv,
    });
    expect(s.buildTimestamp).toBe('2026-05-19T05:00Z');
    expect(s.buildRunNumber).toBe('127');
    expect(s.copyString).toContain('build 2026-05-19T05:00Z (run #127)');
  });
});

describe('v0.6.8 Section 0 — diagnostics page integration', () => {
  it('renders the Build & Versions section with the injected snapshot', async () => {
    const { renderDiagnosticsPage } = await import('../../src/dashboard/pages/diagnostics.js');
    const html = renderDiagnosticsPage({
      bricks: [],
      jobs: [],
      versions: {
        daemonVersion: '0.6.5',
        daemonGitSha: '1022fee',
        daemonUptimeSeconds: 4 * 3600 + 30 * 60,
        nodeVersion: 'v20.18.1',
        mcpSdkVersion: '1.0.4',
        governorVersion: '0.6.5',
        governorStatus: 'cosign-signed',
        stewardStatus: 'up',
        stewardModelRuntime: 'anthropic',
        buildTimestamp: '2026-05-18T14:32Z',
        buildRunNumber: '126',
        copyString:
          'stavR v0.6.5/1022fee · steward up/anthropic · governor v0.6.5/cosign-signed · node v20.18.1 · build 2026-05-18T14:32Z (run #126)',
      },
    });
    expect(html).toContain('data-role="build-versions"');
    expect(html).toContain('Build & Versions');
    expect(html).toContain('v0.6.5');
    expect(html).toContain('1022fee');
    expect(html).toContain('4h 30m');
    expect(html).toContain('v20.18.1');
    expect(html).toContain('anthropic');
    expect(html).toContain('cosign-signed');
    expect(html).toContain('Copy version');
    expect(html).toContain('View on GitHub');
    expect(html).toContain('https://github.com/Kstkoda/stavr/commit/1022fee');
  });

  it('omits the View-on-GitHub link when the git SHA is unknown', async () => {
    const { renderDiagnosticsPage } = await import('../../src/dashboard/pages/diagnostics.js');
    const html = renderDiagnosticsPage({
      bricks: [],
      jobs: [],
      versions: {
        daemonVersion: '0.0.0-dev',
        daemonGitSha: null,
        daemonUptimeSeconds: 12,
        nodeVersion: 'v20.18.1',
        mcpSdkVersion: null,
        governorVersion: null,
        governorStatus: 'not-running',
        stewardStatus: 'unwired',
        stewardModelRuntime: null,
        buildTimestamp: null,
        buildRunNumber: null,
        copyString: 'stavR v0.0.0-dev · steward unwired · governor not-built · node v20.18.1',
      },
    });
    expect(html).toContain('data-role="build-versions"');
    expect(html).not.toContain('View on GitHub');
    // When the governor binary isn't built we display "not-built" and
    // suppress the running-status pill entirely.
    expect(html).toContain('not-built');
    expect(html).toContain('unwired');
  });
});
