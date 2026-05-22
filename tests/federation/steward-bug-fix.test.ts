/**
 * Stream C C1 — `stavr steward bug-fix` end-to-end integration test.
 *
 * Spawns a real stavr daemon (loopback) and exercises the full pipeline:
 *  1. Stand up a tiny mock GitHub API on a separate ephemeral port (we
 *     redirect the `gh` shim via PATH so it consults our fake instead of
 *     hitting github.com).
 *  2. Run `stavr steward bug-fix --issue stenlund/stavr-test-sandbox#1`
 *     against the daemon. With STAVR_AUTO_APPROVE_BUG_FIXES=1 set we
 *     expect trust_scope_proposed + trust_scope_granted + steward_prompt
 *     events to land on the daemon's broker.
 *  3. Read the daemon's events table via the `stavr events` CLI and assert
 *     the three events were persisted with the right correlation ids.
 *  4. --dry-run path exits 0 without contacting the daemon (used by smoke).
 *
 * No mocks of Broker / EventStore / transports — those are real. We only
 * stub `gh` (an external system the brief allows substituting in CI).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const projectRoot = resolve(__dirname, '..', '..');
const cliEntry = resolve(projectRoot, 'src', 'cli.ts');
const tsxCli = resolve(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const isWindows = process.platform === 'win32';
void isWindows;

interface SpawnedDaemon {
  child: ChildProcess;
  stdout: string[];
  stderr: string[];
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function spawnCli(args: string[], env: NodeJS.ProcessEnv): SpawnedDaemon {
  // See tests/federation/bind.test.ts — invoke tsx via node directly to avoid
  // npx.cmd shell:true (DEP0190 on Node 22+).
  const child = spawn(process.execPath, [tsxCli, cliEntry, ...args], {
    cwd: projectRoot,
    env: { ...process.env, ...env },
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout?.on('data', (d) => stdout.push(String(d)));
  child.stderr?.on('data', (d) => stderr.push(String(d)));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => {
    child.on('exit', (code, signal) => res({ code, signal }));
  });
  return { child, stdout, stderr, exited };
}

function runCli(args: string[], env: NodeJS.ProcessEnv = {}): { stdout: string; stderr: string; status: number } {
  const r = spawnSync(process.execPath, [tsxCli, cliEntry, ...args], {
    cwd: projectRoot,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? -1 };
}

function pickPort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        s.close(() => res(port));
      } else {
        s.close();
        rej(new Error('failed to allocate port'));
      }
    });
    s.on('error', rej);
  });
}

async function waitForHealthz(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (r.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`healthz never reachable on 127.0.0.1:${port}`);
}

async function shutdown(d: SpawnedDaemon): Promise<void> {
  if (d.child.exitCode !== null) return;
  d.child.kill(isWindows ? 'SIGKILL' : 'SIGTERM');
  await Promise.race([d.exited, new Promise((r) => setTimeout(r, 4000))]);
}

/**
 * Writes a Node-script shim that mimics `gh issue view --json … --repo X N`.
 * On both platforms we point STAVR_GH_BIN at this script's absolute path —
 * sidesteps PATH-ordering quirks where Windows' execFile finds real gh.exe
 * before our PATH-prepended gh.cmd. The shim parses argv enough to detect
 * `issue view`, emits the canned JSON, and exits 0; anything else exits 1.
 */
function writeFakeGh(dir: string, expected: { repo: string; number: number; body: object }): string {
  mkdirSync(dir, { recursive: true });
  // On Windows, STAVR_GH_BIN must be a .exe / .cmd / etc. that execFile can
  // exec. A bare .js file won't execute. So on Windows we wrap a tiny .cmd
  // that calls `node <script>`; on POSIX we write a shebang'd script.
  const jsBody =
    "const args = process.argv.slice(2);\n" +
    "if (args[0] === 'issue' && args[1] === 'view') {\n" +
    "  process.stdout.write(" + JSON.stringify(JSON.stringify(expected.body)) + ");\n" +
    "  process.exit(0);\n" +
    "}\n" +
    "process.exit(1);\n";
  const jsPath = join(dir, 'gh-fake.js');
  writeFileSync(jsPath, jsBody);
  if (isWindows) {
    const cmdPath = join(dir, 'gh.cmd');
    writeFileSync(
      cmdPath,
      `@echo off\r\nnode "${jsPath.replace(/\\/g, '\\\\')}" %*\r\n`,
    );
    return cmdPath;
  }
  const shPath = join(dir, 'gh');
  writeFileSync(shPath, `#!/usr/bin/env bash\nexec node "${jsPath}" "$@"\n`);
  chmodSync(shPath, 0o755);
  return shPath;
}

describe('Stream C C1 — steward bug-fix end-to-end', () => {
  let tmp: string;
  let daemonHome: string;
  let daemonDb: string;
  let processes: SpawnedDaemon[] = [];
  let daemonPort = 0;
  let ghDir: string;
  let ghBinPath: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'stavr-c1-'));
    daemonHome = join(tmp, 'daemon');
    daemonDb = join(tmp, 'daemon.db');
    ghDir = join(tmp, 'bin');
    processes = [];
    daemonPort = await pickPort();

    ghBinPath = writeFakeGh(ghDir, {
      repo: 'stenlund/stavr-test-sandbox',
      number: 1,
      body: {
        number: 1,
        title: 'Synthetic bug for C1',
        body: 'Something is wrong with the X widget.',
        state: 'open',
        labels: [{ name: 'bug' }, { name: 'cc-mega' }],
        url: 'https://github.com/stenlund/stavr-test-sandbox/issues/1',
      },
    });
  });

  afterEach(async () => {
    for (const p of processes) await shutdown(p);
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* WAL might briefly hold */
    }
  });

  it('--dry-run prints scope + brief preview without contacting the daemon', () => {
    const r = runCli(
      ['steward', 'bug-fix', '--issue', 'stenlund/stavr-test-sandbox#1', '--dry-run'],
      { STAVR_GH_BIN: ghBinPath, STAVR_HOME: daemonHome, STAVR_AUTO_APPROVE_BUG_FIXES: '1' },
    );
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      dry_run: boolean;
      issue: string;
      scope: { allowed_actions: Array<{ tool: string }> };
      auto_approval: { granted: boolean };
      brief_preview: string;
    };
    expect(parsed.dry_run).toBe(true);
    expect(parsed.issue).toBe('stenlund/stavr-test-sandbox#1');
    expect(parsed.scope.allowed_actions.map((a) => a.tool)).toEqual(
      expect.arrayContaining(['github.create_pr', 'github.create_pr_comment']),
    );
    expect(parsed.auto_approval.granted).toBe(true);
    expect(parsed.brief_preview).toContain('Bug-fix request: stenlund/stavr-test-sandbox#1');
  });

  it('end-to-end: dispatches a brief, persists trust_scope_proposed + granted + steward_prompt', async () => {
    const nas = spawnCli(
      ['daemon', 'start', '--port', String(daemonPort), '--db', daemonDb, '--log-format', 'json'],
      { STAVR_HOME: daemonHome },
    );
    processes.push(nas);
    await waitForHealthz(daemonPort, 20_000);

    const r = runCli(
      [
        'steward',
        'bug-fix',
        '--issue',
        'stenlund/stavr-test-sandbox#1',
        '--daemon-url',
        `http://127.0.0.1:${daemonPort}`,
      ],
      { STAVR_GH_BIN: ghBinPath, STAVR_HOME: daemonHome, STAVR_AUTO_APPROVE_BUG_FIXES: '1' },
    );
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as {
      ok: boolean;
      correlation_id: string;
      scope_id: string;
      auto_approved: boolean;
    };
    expect(out.ok).toBe(true);
    expect(out.auto_approved).toBe(true);
    expect(out.scope_id).toMatch(/scope-bug-fix-stavr-test-sandbox-1-[0-9a-f]{8}/);
    expect(out.correlation_id).toMatch(/^prompt-/);

    // Query the event log via the CLI — proves the events actually landed on
    // the daemon's broker, not just that the HTTP POST returned 200.
    const events = runCli(
      ['events', '--db', daemonDb, '--kind', 'trust_scope_proposed', '--kind', 'trust_scope_granted', '--kind', 'steward_prompt'],
      { STAVR_HOME: daemonHome },
    );
    expect(events.status).toBe(0);
    const eventsBody = JSON.parse(events.stdout) as {
      events: Array<{ kind: string; correlation_id?: string; payload: unknown }>;
    };
    const kinds = eventsBody.events.map((e) => e.kind);
    expect(kinds).toContain('trust_scope_proposed');
    expect(kinds).toContain('trust_scope_granted');
    expect(kinds).toContain('steward_prompt');
    // The trust events share the scope_id as their correlation_id.
    const scopeEvents = eventsBody.events.filter((e) => e.correlation_id === out.scope_id);
    expect(scopeEvents.length).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it('without STAVR_AUTO_APPROVE_BUG_FIXES, emits only proposed (no granted)', async () => {
    const nas = spawnCli(
      ['daemon', 'start', '--port', String(daemonPort), '--db', daemonDb, '--log-format', 'json'],
      { STAVR_HOME: daemonHome },
    );
    processes.push(nas);
    await waitForHealthz(daemonPort, 20_000);

    const r = runCli(
      [
        'steward',
        'bug-fix',
        '--issue',
        'stenlund/stavr-test-sandbox#1',
        '--daemon-url',
        `http://127.0.0.1:${daemonPort}`,
      ],
      { STAVR_GH_BIN: ghBinPath, STAVR_HOME: daemonHome },
    );
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as { auto_approved: boolean };
    expect(out.auto_approved).toBe(false);

    const events = runCli(
      ['events', '--db', daemonDb, '--kind', 'trust_scope_granted'],
      { STAVR_HOME: daemonHome },
    );
    const body = JSON.parse(events.stdout) as { events: unknown[] };
    expect(body.events).toHaveLength(0);
  }, 60_000);

  it('surfaces a clear error when gh is missing', () => {
    const r = runCli(
      [
        'steward',
        'bug-fix',
        '--issue',
        'stenlund/stavr-test-sandbox#1',
        '--daemon-url',
        `http://127.0.0.1:${daemonPort}`,
        '--dry-run',
      ],
      // Point STAVR_GH_BIN at a path that definitely doesn't exist.
      { STAVR_GH_BIN: join(ghDir, 'nope-this-does-not-exist'), STAVR_HOME: daemonHome },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not found on PATH|failed/i);
  });
});
