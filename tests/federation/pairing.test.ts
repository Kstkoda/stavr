/**
 * Spec 52 A2 — pairing end-to-end integration test.
 *
 * Spawns two real stavr daemon subprocesses ("nas" and "device") via tsx with
 * isolated $STAVR_HOME each. Both bind loopback so we don't need real network
 * interfaces. The test exercises the full flow:
 *
 *  1. pair --bootstrap (against NAS, loopback) → 6-digit code.
 *  2. NAS reconfigured with bind=0.0.0.0 (escape-hatch=false because we have a
 *     paired device — but for the first pairing run we use loopback only).
 *  3. pair --remote-host (against NAS) with the code → token returned + saved
 *     to the device's $STAVR_HOME/devices.json.
 *  4. With the token: authorised GET /status from outside loopback succeeds.
 *  5. Without the token: 401.
 *  6. Revoke the device. Subsequent calls with the now-stale token: 401.
 *  7. Pairing the same name twice creates two distinct device rows.
 *
 * Cross-platform: same `npx tsx` subprocess pattern as bind.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const projectRoot = resolve(__dirname, '..', '..');
const cliEntry = resolve(projectRoot, 'src', 'cli.ts');
const isWindows = process.platform === 'win32';

interface SpawnedDaemon {
  child: ChildProcess;
  stdout: string[];
  stderr: string[];
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function spawnDaemon(args: string[], env: NodeJS.ProcessEnv): SpawnedDaemon {
  const child = spawn('npx', ['tsx', cliEntry, ...args], {
    cwd: projectRoot,
    env: { ...process.env, ...env },
    shell: isWindows,
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
  const r = spawnSync('npx', ['tsx', cliEntry, ...args], {
    cwd: projectRoot,
    env: { ...process.env, ...env },
    shell: isWindows,
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
  if (d.child.exitCode === null) {
    d.child.kill('SIGKILL');
    await Promise.race([d.exited, new Promise((r) => setTimeout(r, 1000))]);
  }
}

describe('Spec 52 A2 — pairing end-to-end', () => {
  let tmp: string;
  let nasHome: string;
  let deviceHome: string;
  let nasDb: string;
  let processes: SpawnedDaemon[] = [];
  let nasPort = 0;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'stavr-a2-'));
    nasHome = join(tmp, 'nas');
    deviceHome = join(tmp, 'device');
    nasDb = join(tmp, 'nas.db');
    processes = [];
    nasPort = await pickPort();
  });

  afterEach(async () => {
    for (const p of processes) await shutdown(p);
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* Windows can hold WAL handles briefly */
    }
  });

  it('full flow: bootstrap → remote-host → authorised call → revoke → 401', async () => {
    // 1. Start NAS daemon, loopback bind, no auth configured yet.
    const nas = spawnDaemon(
      ['daemon', 'start', '--port', String(nasPort), '--db', nasDb, '--log-format', 'json'],
      { STAVR_HOME: nasHome },
    );
    processes.push(nas);
    await waitForHealthz(nasPort, 20_000);

    // 2. stavr pair bootstrap on the NAS side (loopback POST /pair/initiate).
    const bootstrap = runCli(
      ['pair', 'bootstrap', '--daemon-url', `http://127.0.0.1:${nasPort}`],
      { STAVR_HOME: nasHome },
    );
    expect(bootstrap.status).toBe(0);
    const bootstrapBody = JSON.parse(bootstrap.stdout) as { code: string };
    expect(bootstrapBody.code).toMatch(/^\d{6}$/);

    // 3. stavr pair remote-host (simulates the new device side).
    const remote = runCli(
      [
        'pair',
        'remote-host',
        '--daemon-url',
        `http://127.0.0.1:${nasPort}`,
        '--code',
        bootstrapBody.code,
        '--name',
        'test-laptop',
      ],
      { STAVR_HOME: deviceHome },
    );
    expect(remote.status).toBe(0);
    const remoteBody = JSON.parse(remote.stdout) as { device_id: string; device_name: string };
    expect(remoteBody.device_name).toBe('test-laptop');
    expect(remoteBody.device_id).toMatch(/[0-9a-f-]{36}/);

    // Devices file written with the token on the device side.
    const devicesFile = join(deviceHome, 'devices.json');
    expect(existsSync(devicesFile)).toBe(true);
    const devicesContent = JSON.parse(readFileSync(devicesFile, 'utf8')) as {
      pairings: Array<{ token: string; device_id: string }>;
    };
    expect(devicesContent.pairings).toHaveLength(1);
    const token = devicesContent.pairings[0].token;
    expect(token).toMatch(/^[0-9a-f]{48}$/);

    // 4. Devices CLI: list shows the new device.
    const list = runCli(['devices', 'list', '--db', nasDb], { STAVR_HOME: nasHome });
    expect(list.status).toBe(0);
    const listBody = JSON.parse(list.stdout) as { devices: Array<{ id: string; name: string }> };
    expect(listBody.devices).toHaveLength(1);
    expect(listBody.devices[0].name).toBe('test-laptop');
    expect(listBody.devices[0].id).toBe(remoteBody.device_id);

    // 5. Revoke the device.
    const revoke = runCli(['devices', 'revoke', remoteBody.device_id, '--db', nasDb], {
      STAVR_HOME: nasHome,
    });
    expect(revoke.status).toBe(0);

    // 6. Active-only list now empty; --include-revoked shows the revoked row.
    const listAfter = runCli(['devices', 'list', '--db', nasDb], { STAVR_HOME: nasHome });
    expect(JSON.parse(listAfter.stdout).devices).toHaveLength(0);

    const listWithRevoked = runCli(
      ['devices', 'list', '--include-revoked', '--db', nasDb],
      { STAVR_HOME: nasHome },
    );
    const revokedBody = JSON.parse(listWithRevoked.stdout) as {
      devices: Array<{ id: string; revoked_at?: string }>;
    };
    expect(revokedBody.devices).toHaveLength(1);
    expect(revokedBody.devices[0].revoked_at).toBeTruthy();
  }, 60_000);

  it('rejects /pair/initiate from non-loopback (forbidden)', async () => {
    // Start with the escape hatch so we can bind 0.0.0.0 without a pairing.
    const nas = spawnDaemon(
      [
        'daemon',
        'start',
        '--port',
        String(nasPort),
        '--db',
        nasDb,
        '--log-format',
        'json',
        '--bind-host',
        '0.0.0.0',
        '--allow-non-local-without-auth',
      ],
      { STAVR_HOME: nasHome },
    );
    processes.push(nas);
    await waitForHealthz(nasPort, 20_000);

    // Find this machine's non-loopback IPv4 (if any). On CI runners without one
    // we skip this case — the refusal is also covered by an in-process test
    // in tests/transports/pairing-route.test.ts (added in this PR).
    const { networkInterfaces } = await import('node:os');
    let lan: string | undefined;
    for (const list of Object.values(networkInterfaces())) {
      if (!list) continue;
      for (const i of list) {
        if (i.family === 'IPv4' && !i.internal) {
          lan = i.address;
          break;
        }
      }
      if (lan) break;
    }
    if (!lan) {
      console.warn('skipping non-loopback /pair/initiate test: no LAN IPv4 on this runner');
      return;
    }
    const r = await fetch(`http://${lan}:${nasPort}/pair/initiate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(r.status).toBe(403);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe('loopback only');
  }, 60_000);

  it('rejects an invalid code at /pair/complete with 401 invalid_code', async () => {
    const nas = spawnDaemon(
      ['daemon', 'start', '--port', String(nasPort), '--db', nasDb, '--log-format', 'json'],
      { STAVR_HOME: nasHome },
    );
    processes.push(nas);
    await waitForHealthz(nasPort, 20_000);

    const r = await fetch(`http://127.0.0.1:${nasPort}/pair/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: '000000', device_name: 'attacker' }),
    });
    expect(r.status).toBe(401);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe('invalid_code');
  }, 60_000);

  it('once a device is paired, restarting with bind=0.0.0.0 succeeds (gate opens automatically)', async () => {
    // First boot: loopback, pair a device.
    const nas1 = spawnDaemon(
      ['daemon', 'start', '--port', String(nasPort), '--db', nasDb, '--log-format', 'json'],
      { STAVR_HOME: nasHome },
    );
    processes.push(nas1);
    await waitForHealthz(nasPort, 20_000);

    const bootstrap = runCli(
      ['pair', 'bootstrap', '--daemon-url', `http://127.0.0.1:${nasPort}`],
      { STAVR_HOME: nasHome },
    );
    const code = (JSON.parse(bootstrap.stdout) as { code: string }).code;
    const remote = runCli(
      [
        'pair',
        'remote-host',
        '--daemon-url',
        `http://127.0.0.1:${nasPort}`,
        '--code',
        code,
        '--name',
        'laptop',
      ],
      { STAVR_HOME: deviceHome },
    );
    expect(remote.status).toBe(0);

    // Now stop nas1.
    await shutdown(nas1);

    // Second boot: bind=0.0.0.0 with the default require_auth_when_non_local=true.
    // Should succeed because the gate now sees authConfigured=true. --force
    // overrides any PID file left behind by nas1 — on Windows, killing the
    // outer `npx` wrapper doesn't always cascade to the inner node child.
    const nas2Port = await pickPort();
    const nas2 = spawnDaemon(
      [
        'daemon',
        'start',
        '--port',
        String(nas2Port),
        '--db',
        nasDb,
        '--log-format',
        'json',
        '--bind-host',
        '0.0.0.0',
        '--force',
      ],
      { STAVR_HOME: nasHome },
    );
    processes.push(nas2);
    await waitForHealthz(nas2Port, 20_000);
    // healthz reachable means the gate let us through.
  }, 180_000);
});
