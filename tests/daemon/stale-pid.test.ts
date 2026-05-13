import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isProcessAlive } from '../../src/daemon.js';
import { safeWrite } from '../../src/util/atomic.js';

describe('Spec 51 — atomic write and stale PID detection', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cowire-resilience-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('safeWrite creates parent dir and atomically replaces an existing file', () => {
    const target = join(tmp, 'sub', 'nested', 'file.json');
    safeWrite(target, '{"v":1}');
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('{"v":1}');

    // Overwrite — must replace cleanly.
    safeWrite(target, '{"v":2}');
    expect(readFileSync(target, 'utf8')).toBe('{"v":2}');

    // No leftover tmp files in the parent directory.
    const { readdirSync } = require('node:fs') as typeof import('node:fs');
    const siblings = readdirSync(join(tmp, 'sub', 'nested'));
    expect(siblings.filter((n) => n.startsWith('file.json.tmp.'))).toHaveLength(0);
  });

  it('safeWrite cleans up the temp file on failure', () => {
    // Pointing at a path the OS can't rename onto (we use a directory name to force ENOTDIR/EISDIR).
    const dirPath = join(tmp, 'cant-write-here');
    require('node:fs').mkdirSync(dirPath, { recursive: true });
    expect(() => safeWrite(dirPath, 'whatever')).toThrow();
    // Confirm no leftover tmp files in the parent dir.
    const { readdirSync } = require('node:fs') as typeof import('node:fs');
    const siblings = readdirSync(tmp);
    expect(siblings.filter((n) => n.startsWith('cant-write-here.tmp.'))).toHaveLength(0);
  });

  it('isProcessAlive returns false for a PID that has never been allocated', () => {
    // 2^31 - 1 is unlikely to ever match a live PID on any platform.
    expect(isProcessAlive(2147483647)).toBe(false);
  });

  it('writes a PID file with a definitely-dead pid and confirms detection', () => {
    const fakePid = 2147483647;
    const pidPath = join(tmp, 'fake-pid.json');
    writeFileSync(
      pidPath,
      JSON.stringify({ pid: fakePid, port: 7777, started_at: new Date().toISOString(), db: 'x' }),
    );
    const record = JSON.parse(readFileSync(pidPath, 'utf8')) as { pid: number };
    expect(isProcessAlive(record.pid)).toBe(false);
  });
});
