/**
 * Spec 52 A1 — configurable bind + auth gate, integration tests.
 *
 * These boot real subprocesses via `tsx src/cli.ts` so we exercise the full CLI
 * path (config load → resolveBind → auth gate → mountTransports → app.listen).
 *
 * Each test gets an isolated $STAVR_HOME so PID files / config files / DBs
 * don't collide between concurrent vitest workers. The success-path test uses
 * an ephemeral port chosen by the OS (via a probe `net.createServer`) so it is
 * safe to run in parallel.
 *
 * Cross-platform considerations:
 *  - Refusal test: pure config-level rejection, identical behaviour on Linux,
 *    macOS, Windows. Always runs.
 *  - Localhost-success test: binds 127.0.0.1 only; no firewall prompt on any
 *    platform. Always runs.
 *  - LAN-success test: we deliberately do NOT bind a real LAN address in CI —
 *    GitHub-hosted Windows runners don't have a predictable LAN IP and would
 *    flake. The lan resolution itself is covered by tests/config.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const projectRoot = resolve(__dirname, '..', '..');
const cliEntry = resolve(projectRoot, 'src', 'cli.ts');
const tsxCli = resolve(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

const isWindows = process.platform === 'win32';

interface SpawnedDaemon {
  child: ChildProcess;
  stdout: string[];
  stderr: string[];
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function spawnCli(args: string[], env: NodeJS.ProcessEnv): SpawnedDaemon {
  // Invoke tsx via node directly, NOT through `npx tsx`. The npx route forces
  // shell:true on Windows (npx.cmd), and shell:true + args-array trips
  // DEP0190 on Node 22+. node + the resolved tsx CLI file works identically
  // on every platform with shell:false.
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

async function waitForLine(d: SpawnedDaemon, predicate: (s: string) => boolean, timeoutMs: number): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const buf of [...d.stderr, ...d.stdout]) {
      if (predicate(buf)) return buf;
    }
    if ((await Promise.race([d.exited, new Promise((r) => setTimeout(r, 50))])) !== undefined) {
      // Loop one more iteration so we capture any final output if the process exited.
    }
    // Poll again after a short delay.
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(
    `timeout waiting for log line.\nstdout:\n${d.stdout.join('')}\nstderr:\n${d.stderr.join('')}`,
  );
}

async function shutdown(d: SpawnedDaemon): Promise<void> {
  if (d.child.exitCode !== null) return;
  d.child.kill(isWindows ? 'SIGKILL' : 'SIGTERM');
  await Promise.race([d.exited, new Promise((r) => setTimeout(r, 4000))]);
  if (d.child.exitCode === null) {
    d.child.kill('SIGKILL');
    await Promise.race([d.exited, new Promise((r) => setTimeout(r, 1000))]);
  }
}

describe('Spec 52 A1 — federation bind + auth gate', () => {
  let tmp: string;
  let stavrHome: string;
  let dbPath: string;
  let configPath: string;
  let processes: SpawnedDaemon[] = [];

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'stavr-fed-'));
    stavrHome = join(tmp, 'home');
    dbPath = join(tmp, 'runestone.db');
    configPath = join(tmp, 'stavr.yaml');
    processes = [];
  });

  afterEach(async () => {
    for (const p of processes) {
      await shutdown(p);
    }
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* Windows can briefly hold the SQLite WAL; not material */
    }
  });

  it('refuses to start when bind is non-loopback and auth is not configured', async () => {
    writeFileSync(
      configPath,
      'network:\n  bind: 0.0.0.0\n  require_auth_when_non_local: true\n',
      'utf8',
    );
    const port = await pickPort();
    const d = spawnCli(
      [
        'daemon',
        'start',
        '--port',
        String(port),
        '--db',
        dbPath,
        '--config',
        configPath,
        '--log-format',
        'json',
      ],
      { STAVR_HOME: stavrHome },
    );
    processes.push(d);
    const exit = await Promise.race([
      d.exited,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('daemon did not exit')), 30_000)),
    ]);
    expect(exit.code).toBe(1);
    const combined = d.stdout.join('') + d.stderr.join('');
    expect(combined).toMatch(/refusing to bind non-local without auth configured/);
  }, 35_000);

  it('starts cleanly on localhost (default) and serves /healthz', async () => {
    writeFileSync(configPath, 'network:\n  bind: localhost\n', 'utf8');
    const port = await pickPort();
    const d = spawnCli(
      [
        'daemon',
        'start',
        '--port',
        String(port),
        '--db',
        dbPath,
        '--config',
        configPath,
        '--log-format',
        'json',
      ],
      { STAVR_HOME: stavrHome },
    );
    processes.push(d);
    // Wait for the "daemon ready" log line. We're already binding to localhost
    // so this should come up in a few seconds even with the tsx start-up cost.
    await waitForLine(
      d,
      (line) => line.includes('"msg":"daemon ready"') && line.includes('127.0.0.1'),
      30_000,
    );
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; version: string };
    expect(body.ok).toBe(true);
  }, 35_000);

  it('starts when require_auth_when_non_local is false (escape hatch)', async () => {
    writeFileSync(
      configPath,
      'network:\n  bind: 127.0.0.1\n  require_auth_when_non_local: false\n',
      'utf8',
    );
    const port = await pickPort();
    const d = spawnCli(
      [
        'daemon',
        'start',
        '--port',
        String(port),
        '--db',
        dbPath,
        '--config',
        configPath,
        '--log-format',
        'json',
      ],
      { STAVR_HOME: stavrHome },
    );
    processes.push(d);
    await waitForLine(d, (line) => line.includes('"msg":"daemon ready"'), 30_000);
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);
  }, 35_000);

  it('stavr config show reports defaults and would_refuse for a risky bind', async () => {
    // No config file present — defaults apply (bind: localhost).
    const d = spawnCli(['config', 'show', '--bind-host', '0.0.0.0'], { STAVR_HOME: stavrHome });
    processes.push(d);
    const exit = await Promise.race([
      d.exited,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('config show did not exit')), 30_000)),
    ]);
    expect(exit.code).toBe(0);
    const out = d.stdout.join('');
    const parsed = JSON.parse(out) as {
      config_source: string;
      effective: { network: { bind: string } };
      auth_gate: { would_refuse: boolean; reason?: string };
    };
    expect(parsed.config_source).toBe('defaults');
    expect(parsed.effective.network.bind).toBe('0.0.0.0');
    expect(parsed.auth_gate.would_refuse).toBe(true);
    expect(parsed.auth_gate.reason).toMatch(/refusing to bind non-local/);
  }, 35_000);

  it('stavr config show with --allow-non-local-without-auth flips the verdict', async () => {
    const d = spawnCli(
      ['config', 'show', '--bind-host', '0.0.0.0', '--allow-non-local-without-auth'],
      { STAVR_HOME: stavrHome },
    );
    processes.push(d);
    const exit = await Promise.race([
      d.exited,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('config show did not exit')), 30_000)),
    ]);
    expect(exit.code).toBe(0);
    const parsed = JSON.parse(d.stdout.join('')) as {
      auth_gate: { would_refuse: boolean };
      effective: { network: { require_auth_when_non_local: boolean } };
    };
    expect(parsed.auth_gate.would_refuse).toBe(false);
    expect(parsed.effective.network.require_auth_when_non_local).toBe(false);
  }, 35_000);
});
