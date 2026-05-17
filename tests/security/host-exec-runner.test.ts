import { describe, expect, it } from 'vitest';
import { resolve as resolvePath } from 'node:path';
import {
  HostExecRejection,
  resolveContainedCwd,
  runHostExec,
} from '../../src/security/host-exec-runner.js';

describe('host-exec runner — cwd containment', () => {
  const root = resolvePath(process.cwd());

  it('accepts undefined cwd (defaults to root)', () => {
    expect(resolveContainedCwd(undefined, root)).toBe(root);
  });

  it('accepts a path inside the root', () => {
    expect(() => resolveContainedCwd('src', root)).not.toThrow();
  });

  it('rejects ../ escape', () => {
    expect(() => resolveContainedCwd('../', root)).toThrow(HostExecRejection);
  });

  it('rejects ../../etc escape', () => {
    expect(() => resolveContainedCwd('../../etc', root)).toThrow(HostExecRejection);
  });

  it('rejects an absolute path outside the root', () => {
    const outside = process.platform === 'win32' ? 'C:\\Windows' : '/etc';
    expect(() => resolveContainedCwd(outside, root)).toThrow(HostExecRejection);
  });
});

describe('host-exec runner — runHostExec smoke', () => {
  it('runs git --version with exit 0 and version text in stdout', async () => {
    const result = await runHostExec({
      command: 'git',
      args: ['--version'],
      timeout_ms: 10_000,
    });
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toMatch(/git version/i);
    expect(result.timed_out).toBe(false);
    expect(result.command_full).toBe('git --version');
  });

  it('captures stderr from a failing command (git on bogus subcommand)', async () => {
    const result = await runHostExec({
      command: 'git',
      args: ['this-subcommand-does-not-exist'],
      timeout_ms: 10_000,
    });
    // git typically exits with a non-zero code on unknown subcommands and
    // prints to stderr. We don't pin to a specific code (varies by version).
    expect(result.exit_code).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it('returns exit -1 with spawn-error stderr when the binary is missing', async () => {
    const result = await runHostExec({
      command: 'this-binary-definitely-does-not-exist-xyz',
      args: [],
      timeout_ms: 5_000,
    });
    expect(result.exit_code).toBe(-1);
    expect(result.stderr).toMatch(/spawn error/i);
  });

  it('honors timeout_ms and reports timed_out: true', async () => {
    // Use git's --help with no pager — quick. To force a long run we use
    // `git rev-list` with a very expensive query? Easier: spawn `node -e`
    // here directly, bypassing the allowlist (the runner itself doesn't
    // gate on the allowlist — the handler does, by design).
    const result = await runHostExec({
      command: process.execPath, // current node binary
      args: ['-e', "setInterval(()=>{},1000)"],
      timeout_ms: 600,
    });
    expect(result.timed_out).toBe(true);
    expect(result.duration_ms).toBeGreaterThanOrEqual(500);
    expect(result.duration_ms).toBeLessThan(5_000);
    // exit_code is null when killed by signal.
    expect(result.exit_code === null || result.exit_code === -1 || result.exit_code !== 0).toBe(
      true,
    );
  });

  it('truncates stdout above the 1MB cap and marks stdout_truncated', async () => {
    // 1.5MB of output via `node -e`. Print in chunks so we don't blow node's
    // own buffers writing it.
    const program =
      "const c=Buffer.alloc(64*1024,'x'); for(let i=0;i<24;i++){process.stdout.write(c);}";
    const result = await runHostExec({
      command: process.execPath,
      args: ['-e', program],
      timeout_ms: 30_000,
    });
    expect(result.stdout_truncated).toBe(true);
    expect(result.stdout).toContain('[... output truncated]');
    // Should be capped near 1MB + marker (a few KB slack).
    expect(result.stdout.length).toBeLessThan(1_050_000);
  });

  it('scrubs env: GITHUB_TOKEN does NOT reach the child', async () => {
    const previous = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'sentinel-must-not-leak-' + Date.now();
    try {
      const program =
        "process.stdout.write(process.env.GITHUB_TOKEN === undefined ? 'absent' : 'present:'+process.env.GITHUB_TOKEN);";
      const result = await runHostExec({
        command: process.execPath,
        args: ['-e', program],
        timeout_ms: 10_000,
      });
      expect(result.stdout).toBe('absent');
    } finally {
      if (previous === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previous;
    }
  });
});
