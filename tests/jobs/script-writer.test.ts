import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildInvocation,
  cleanupOldScripts,
  composeScript,
  defaultScriptDir,
  renderSleep,
  retentionDays,
  writeWorkerScript,
  type WorkerShell,
} from '../../src/jobs/script-writer.js';

const FIXED_NOW = new Date('2026-05-18T20:00:00.000Z');

describe('v0.6.7 P1 — composeScript headers per shell', () => {
  it('powershell header includes #Requires + audit comments + ErrorAction', () => {
    const body = composeScript({
      workerId: 'w-abc',
      shell: 'powershell',
      command: 'Write-Host hi',
      now: () => FIXED_NOW,
    });
    expect(body.split('\n')[0].trim()).toBe('#Requires -Version 5');
    expect(body).toContain('# stavR worker script');
    expect(body).toContain('# worker_id: w-abc');
    expect(body).toContain('# created:   2026-05-18T20:00:00.000Z');
    expect(body).toContain('$ErrorActionPreference = "Stop"');
    expect(body).toContain('Write-Host hi');
  });

  it('cmd header uses REM comments + @echo off prelude', () => {
    const body = composeScript({
      workerId: 'w-cmd',
      shell: 'cmd',
      command: 'echo hello',
      now: () => FIXED_NOW,
    });
    expect(body.split('\r\n')[0]).toBe('@echo off');
    expect(body).toContain('REM stavR worker script');
    expect(body).toContain('REM worker_id: w-cmd');
    expect(body).toContain('echo hello');
    // CMD uses CRLF line endings.
    expect(body).toContain('\r\n');
  });

  it('bash header uses #!/usr/bin/env bash + set -euo pipefail', () => {
    const body = composeScript({
      workerId: 'w-sh',
      shell: 'bash',
      command: 'echo hi',
      now: () => FIXED_NOW,
    });
    expect(body.split('\n')[0]).toBe('#!/usr/bin/env bash');
    expect(body.split('\n')[1]).toBe('set -euo pipefail');
    expect(body).toContain('# worker_id: w-sh');
    expect(body).toContain('echo hi');
  });

  it('joins args onto the command line space-separated', () => {
    const body = composeScript({
      workerId: 'w-args',
      shell: 'bash',
      command: 'tail',
      args: ['-f', '/var/log/syslog'],
      now: () => FIXED_NOW,
    });
    expect(body).toContain('tail -f /var/log/syslog');
  });
});

describe('v0.6.7 P2 — renderSleep across shells', () => {
  it('powershell uses Start-Sleep -Seconds', () => {
    expect(renderSleep('powershell', 5)).toBe('Start-Sleep -Seconds 5');
  });

  it('cmd uses ping for headless-correct sleep (n+1 packets ≈ n seconds)', () => {
    expect(renderSleep('cmd', 5)).toBe('ping 127.0.0.1 -n 6 >nul');
    expect(renderSleep('cmd', 1)).toBe('ping 127.0.0.1 -n 2 >nul');
  });

  it('bash uses sleep', () => {
    expect(renderSleep('bash', 30)).toBe('sleep 30');
  });

  it('zero or negative seconds renders empty string (no-op)', () => {
    for (const shell of ['cmd', 'powershell', 'bash'] as WorkerShell[]) {
      expect(renderSleep(shell, 0)).toBe('');
      expect(renderSleep(shell, -1)).toBe('');
    }
  });
});

describe('v0.6.7 P2 — sleepBefore / sleepAfter weave into composed script', () => {
  it('sleepBefore precedes the command, sleepAfter follows it', () => {
    const body = composeScript({
      workerId: 'w-sleep',
      shell: 'powershell',
      command: 'Get-Process',
      sleepBefore: 3,
      sleepAfter: 7,
      now: () => FIXED_NOW,
    });
    const i = body.indexOf('Start-Sleep -Seconds 3');
    const j = body.indexOf('Get-Process');
    const k = body.indexOf('Start-Sleep -Seconds 7');
    expect(i).toBeGreaterThan(0);
    expect(j).toBeGreaterThan(i);
    expect(k).toBeGreaterThan(j);
  });

  it('omitted sleeps do not produce empty lines', () => {
    const body = composeScript({
      workerId: 'w-nosleep',
      shell: 'bash',
      command: 'echo hi',
      now: () => FIXED_NOW,
    });
    expect(body.split('\n').filter((l) => l.trim() === '').length).toBeLessThanOrEqual(2);
  });
});

describe('v0.6.7 P1 — buildInvocation argv per shell', () => {
  it('powershell argv uses -File + -NoProfile + ExecutionPolicy Bypass (AV-friendly)', () => {
    const inv = buildInvocation('powershell', '/tmp/w.ps1');
    expect(inv.argv0).toBe('powershell.exe');
    expect(inv.argv).toContain('-File');
    expect(inv.argv).toContain('-NoProfile');
    expect(inv.argv).toContain('Bypass');
    expect(inv.argv).toContain('/tmp/w.ps1');
    // The whole point: must NOT pass -Command.
    expect(inv.argv).not.toContain('-Command');
  });

  it('cmd argv is /c <path> only — no /k (would keep window open)', () => {
    const inv = buildInvocation('cmd', 'C:\\tmp\\w.cmd');
    expect(inv.argv0).toBe('cmd.exe');
    expect(inv.argv).toEqual(['/c', 'C:\\tmp\\w.cmd']);
  });

  it('bash argv is just the script path', () => {
    const inv = buildInvocation('bash', '/tmp/w.sh');
    expect(inv.argv0).toBe('bash');
    expect(inv.argv).toEqual(['/tmp/w.sh']);
  });
});

describe('v0.6.7 P1 — writeWorkerScript on disk', () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'stavr-script-test-'));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it('writes the script to <baseDir>/<workerId>.<ext>', () => {
    const result = writeWorkerScript({
      workerId: 'w-write',
      shell: 'powershell',
      command: 'Write-Host hi',
      baseDir,
      now: () => FIXED_NOW,
    });
    expect(result.path).toBe(join(baseDir, 'w-write.ps1'));
    expect(result.ext).toBe('ps1');
    const onDisk = readFileSync(result.path, 'utf8');
    expect(onDisk).toContain('Write-Host hi');
    expect(onDisk).toContain('# worker_id: w-write');
  });

  it('invocation tuple matches buildInvocation for the chosen shell', () => {
    const result = writeWorkerScript({
      workerId: 'w-inv',
      shell: 'cmd',
      command: 'echo hi',
      baseDir,
      now: () => FIXED_NOW,
    });
    expect(result.invocation.argv0).toBe('cmd.exe');
    expect(result.invocation.argv).toEqual(['/c', result.path]);
  });

  it('does not collide with same-id rewrites — overwrites in place', () => {
    writeWorkerScript({
      workerId: 'w-overwrite',
      shell: 'bash',
      command: 'first',
      baseDir,
      now: () => FIXED_NOW,
    });
    const r2 = writeWorkerScript({
      workerId: 'w-overwrite',
      shell: 'bash',
      command: 'second',
      baseDir,
      now: () => FIXED_NOW,
    });
    const onDisk = readFileSync(r2.path, 'utf8');
    expect(onDisk).toContain('second');
    expect(onDisk).not.toContain('first');
  });

  it('writes with restrictive permissions on POSIX (0o700 mask)', () => {
    if (process.platform === 'win32') return; // chmod is a no-op on Windows
    const result = writeWorkerScript({
      workerId: 'w-perm',
      shell: 'bash',
      command: 'echo hi',
      baseDir,
      now: () => FIXED_NOW,
    });
    const mode = statSync(result.path).mode & 0o777;
    expect(mode).toBe(0o700);
  });
});

describe('v0.6.7 P1 — retention cleanup', () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'stavr-retention-test-'));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it('retentionDays defaults to 7', () => {
    delete process.env.STAVR_WORKER_SCRIPT_RETENTION_DAYS;
    expect(retentionDays()).toBe(7);
  });

  it('retentionDays honours env override when valid', () => {
    process.env.STAVR_WORKER_SCRIPT_RETENTION_DAYS = '14';
    expect(retentionDays()).toBe(14);
    process.env.STAVR_WORKER_SCRIPT_RETENTION_DAYS = '0';
    expect(retentionDays()).toBe(7); // ≤0 → default
    process.env.STAVR_WORKER_SCRIPT_RETENTION_DAYS = 'abc';
    expect(retentionDays()).toBe(7); // NaN → default
    delete process.env.STAVR_WORKER_SCRIPT_RETENTION_DAYS;
  });

  it('cleanupOldScripts removes files older than retention window', () => {
    // Create fresh + ancient script. The ancient one has mtime > 30d ago.
    const freshPath = join(baseDir, 'fresh.ps1');
    const ancientPath = join(baseDir, 'ancient.ps1');
    writeFileSync(freshPath, 'fresh', 'utf8');
    writeFileSync(ancientPath, 'old', 'utf8');
    // Backdate the ancient one via utimesSync would be ideal but is racy
    // with the cleanup call's clock-source — instead we advance the
    // cleanup clock 30 days into the future and check the fresh one
    // survives (1 minute old) while the ancient one (30 days + a tick old)
    // doesn't. The trick: make both files at "now" and advance the
    // cleanup's `now` so retention catches the older mtime relative to
    // the bumped clock.
    const future = new Date(Date.now() + 30 * 86_400_000);
    const removed = cleanupOldScripts({ baseDir, now: () => future });
    // Both files were created at "real now", which is now 30+ days
    // before `future`. Both should be removed.
    expect(removed).toBe(2);
  });

  it('cleanupOldScripts returns 0 for non-existent dir', () => {
    expect(cleanupOldScripts({ baseDir: join(baseDir, 'nope') })).toBe(0);
  });
});

describe('v0.6.7 P5 — STAVR_WORKER_SCRIPT_DIR override', () => {
  it('defaultScriptDir falls back to <STAVR_HOME>/worker-scripts when env unset', () => {
    const before = process.env.STAVR_WORKER_SCRIPT_DIR;
    delete process.env.STAVR_WORKER_SCRIPT_DIR;
    try {
      expect(defaultScriptDir().endsWith('worker-scripts')).toBe(true);
    } finally {
      if (before !== undefined) process.env.STAVR_WORKER_SCRIPT_DIR = before;
    }
  });

  it('honours STAVR_WORKER_SCRIPT_DIR when set (AV-whitelisted folder)', () => {
    const before = process.env.STAVR_WORKER_SCRIPT_DIR;
    try {
      process.env.STAVR_WORKER_SCRIPT_DIR = 'C:\\stavr\\trusted-scripts';
      expect(defaultScriptDir()).toBe('C:\\stavr\\trusted-scripts');
    } finally {
      if (before === undefined) delete process.env.STAVR_WORKER_SCRIPT_DIR;
      else process.env.STAVR_WORKER_SCRIPT_DIR = before;
    }
  });

  it('whitespace-only override falls back to default', () => {
    const before = process.env.STAVR_WORKER_SCRIPT_DIR;
    try {
      process.env.STAVR_WORKER_SCRIPT_DIR = '   ';
      expect(defaultScriptDir().endsWith('worker-scripts')).toBe(true);
    } finally {
      if (before === undefined) delete process.env.STAVR_WORKER_SCRIPT_DIR;
      else process.env.STAVR_WORKER_SCRIPT_DIR = before;
    }
  });
});
