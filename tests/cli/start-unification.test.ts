/**
 * Regression test for `proposed/bom-cli-start-unify.md`.
 *
 * Pre-fix, `stavr start` (the bare command, no `daemon` subcommand) mounted
 * transports + broker only. The memory poller, retention scheduler, worker
 * watchdog, steward loop, and v0.2 subsystem all lived inside
 * `startDaemonForeground`, which was only invoked by `stavr daemon start`.
 * Net effect: under `npm start` (which used `stavr start`) the OOM leak-hunt
 * fix shipped in PR #16 was dormant — the daemon emitted zero
 * `retention_swept` or `daemon_memory` events.
 *
 * This test boots a real subprocess via `tsx src/cli.ts start` (no
 * `--stdio-only`) and asserts both events show up in the SQLite event store
 * within ~5s. If `stavr start` ever silently regresses to the lighter path,
 * the assertion fails.
 *
 * Cross-platform: subprocess pattern lifted from tests/federation/bind.test.ts.
 * STAVR_HOME isolation keeps parallel workers from colliding on the daemon
 * PID file.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EventStore } from '../../src/persistence.js';

const projectRoot = resolve(__dirname, '..', '..');
const cliEntry = resolve(projectRoot, 'src', 'cli.ts');
const tsxCli = resolve(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const isWindows = process.platform === 'win32';
void isWindows;

interface Spawned {
  child: ChildProcess;
  stderr: string[];
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function spawnCli(args: string[], env: NodeJS.ProcessEnv): Spawned {
  // See tests/federation/bind.test.ts — invoke tsx via node directly to avoid
  // npx.cmd shell:true (DEP0190 on Node 22+).
  const child = spawn(process.execPath, [tsxCli, cliEntry, ...args], {
    cwd: projectRoot,
    env: { ...process.env, ...env },
  });
  const stderr: string[] = [];
  child.stderr?.on('data', (d) => stderr.push(String(d)));
  // Drain stdout so the buffer never fills up.
  child.stdout?.on('data', () => {});
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => {
    child.on('exit', (code, signal) => res({ code, signal }));
  });
  return { child, stderr, exited };
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

async function waitForLine(
  d: Spawned,
  predicate: (s: string) => boolean,
  timeoutMs: number,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const buf of d.stderr) {
      if (predicate(buf)) return buf;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timeout waiting for log line. stderr:\n${d.stderr.join('')}`);
}

async function shutdown(d: Spawned): Promise<void> {
  if (d.child.exitCode !== null) return;
  d.child.kill(isWindows ? 'SIGKILL' : 'SIGTERM');
  await Promise.race([d.exited, new Promise((r) => setTimeout(r, 4000))]);
  if (d.child.exitCode === null) {
    d.child.kill('SIGKILL');
    await Promise.race([d.exited, new Promise((r) => setTimeout(r, 1000))]);
  }
}

describe('stavr start unification (bom-cli-start-unify)', () => {
  const tempDirs: string[] = [];
  let daemon: Spawned | undefined;

  afterEach(async () => {
    if (daemon) {
      await shutdown(daemon);
      daemon = undefined;
    }
    for (const d of tempDirs.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  });

  it('non-stdio `stavr start` reaches the full daemon path (emits daemon_memory + retention_swept)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'stavr-unify-'));
    tempDirs.push(home);
    const dbPath = join(home, 'unify.db');
    const port = await pickPort();

    daemon = spawnCli(
      ['start', '--port', String(port), '--db', dbPath, '--log-format', 'json'],
      { STAVR_HOME: home },
    );

    // The canonical "we took the full daemon path" log line lives in
    // `startDaemonForeground`. If this never appears, the start command
    // regressed to the lighter (transports-only) path.
    await waitForLine(
      daemon,
      (line) => line.includes('"msg":"daemon ready"'),
      15_000,
    );

    // Poll the SQLite store for the two events that prove the wire-up ran:
    //  - daemon_memory  → memory poller fired (boot tick is immediate)
    //  - retention_swept → retention scheduler fired (boot sweep is immediate)
    const deadline = Date.now() + 10_000;
    let seenMemory = false;
    let seenRetention = false;
    let lastKinds: string[] = [];
    while (Date.now() < deadline && !(seenMemory && seenRetention)) {
      try {
        const store = new EventStore();
        store.init(dbPath);
        const { events } = store.getEvents({ limit: 200 });
        lastKinds = events.map((e) => e.kind);
        seenMemory = lastKinds.includes('daemon_memory');
        seenRetention = lastKinds.includes('retention_swept');
        store.close();
      } catch {
        /* DB may be momentarily locked; retry */
      }
      if (seenMemory && seenRetention) break;
      await new Promise((r) => setTimeout(r, 200));
    }

    expect(seenMemory, `daemon_memory not seen; observed kinds: ${lastKinds.join(', ')}`).toBe(true);
    expect(seenRetention, `retention_swept not seen; observed kinds: ${lastKinds.join(', ')}`).toBe(true);
  }, 30_000);

  it('`stavr start --stdio-only` stays on the lighter path (no daemon ready, no retention)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'stavr-unify-stdio-'));
    tempDirs.push(home);
    const dbPath = join(home, 'stdio.db');

    daemon = spawnCli(
      ['start', '--stdio-only', '--db', dbPath, '--log-format', 'json'],
      { STAVR_HOME: home },
    );

    // Wait for the stdio transport ready log — proves the command booted.
    await waitForLine(
      daemon,
      (line) => line.includes('stdio transport ready'),
      15_000,
    );

    // Give the lighter path 1.5s to (incorrectly) run any daemon services.
    // The retention sweep and memory poller should NOT have fired.
    await new Promise((r) => setTimeout(r, 1500));

    const store = new EventStore();
    store.init(dbPath);
    const { events } = store.getEvents({ limit: 200 });
    const kinds = events.map((e) => e.kind);
    store.close();

    expect(kinds).not.toContain('daemon_memory');
    expect(kinds).not.toContain('retention_swept');
  }, 30_000);
});
