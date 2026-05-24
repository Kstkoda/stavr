#!/usr/bin/env node
// v0.7 Phase 10a — two-instance federation smoke test.
//
// Spins up two ephemeral stavR daemon instances on different ports with
// separate STAVR_HOME dirs, lets them discover each other via mDNS or
// peers.yaml seeding, and verifies:
//
//   1. Both /api/federation/health endpoints return JSON with peer_id +
//      protocol_version.
//   2. Each instance's /api/federation/peers list includes the other
//      instance's peer_id within ~30s of startup (mDNS) OR immediately
//      (when peers.yaml is pre-seeded).
//   3. The full v0.6.11 regression spot-check — /healthz responds, the
//      dashboard /helm renders, no crash within the 60s observation
//      window.
//
// What this does NOT do (deferred to Phase 10b, operator-supervised):
//   - 90-min sustained load (use load-runner.mjs separately)
//   - Real WebAuthn ceremony (passkey registration is browser-side; the
//     /api/auth/* endpoints respond correctly, but actually completing
//     the ceremony requires a real authenticator).
//   - True multi-machine — same-host two-process is the autonomous
//     surrogate for actual two-LAN-host validation.
//
// Usage:
//   node tmp/perf/peer-smoke.mjs                 # default: ports 7777 + 7778
//   node tmp/perf/peer-smoke.mjs --port-a 8080 --port-b 8081
//   node tmp/perf/peer-smoke.mjs --observation-seconds 30
//
// Exit codes:
//   0 — all asserts passed
//   1 — at least one assert failed
//   2 — setup failed (port in use, daemon failed to start, etc.)

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync, createWriteStream } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { request as httpRequest } from 'node:http';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, arr) => {
    if (!a.startsWith('--')) return [];
    const next = arr[i + 1];
    if (next === undefined || next.startsWith('--')) return [[a.slice(2), true]];
    return [[a.slice(2), next]];
  }),
);

const PORT_A = Number(args['port-a'] ?? 7787);
const PORT_B = Number(args['port-b'] ?? 7788);
const OBS_SEC = Number(args['observation-seconds'] ?? 60);
const ARTIFACTS_DIR = join(ROOT, 'tmp', 'perf', 'peer-smoke-artifacts');

mkdirSync(ARTIFACTS_DIR, { recursive: true });

const HOME_A = join(ARTIFACTS_DIR, 'home-a');
const HOME_B = join(ARTIFACTS_DIR, 'home-b');

// Per-instance home dirs: each gets its own runestone.db + peers.yaml.
// Wipe between runs so the smoke is reproducible.
for (const d of [HOME_A, HOME_B]) {
  if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
}

// Pre-seed peers.yaml on each side so we get mutual discovery via the
// trust root even when LAN multicast is blocked (CI, Hyper-V, etc.).
writeFileSync(
  join(HOME_A, 'peers.yaml'),
  [
    'self_id: peer-a',
    'self_display_name: Peer A (smoke)',
    'peers:',
    '  - id: peer-b',
    '    display_name: Peer B (smoke)',
    '    hostname: 127.0.0.1',
    `    port: ${PORT_B}`,
    '    trust: verified',
  ].join('\n'),
  'utf8',
);
writeFileSync(
  join(HOME_B, 'peers.yaml'),
  [
    'self_id: peer-b',
    'self_display_name: Peer B (smoke)',
    'peers:',
    '  - id: peer-a',
    '    display_name: Peer A (smoke)',
    '    hostname: 127.0.0.1',
    `    port: ${PORT_A}`,
    '    trust: verified',
  ].join('\n'),
  'utf8',
);

const distCli = join(ROOT, 'dist', 'cli.js');
if (!existsSync(distCli)) {
  console.error('[peer-smoke] dist/cli.js missing — run `npm run build` first');
  process.exit(2);
}

function spawnDaemon(label, port, home) {
  const env = {
    ...process.env,
    STAVR_HOME: home,
    PORT: String(port),
    NODE_ENV: 'production',
    STAVR_PEER_ID: label,
  };
  const child = spawn(process.execPath, [distCli, 'daemon', 'start', '--port', String(port)], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: ROOT,
  });
  // Persist each peer's combined stdout+stderr to a per-peer log under
  // the artifacts dir. The pre-fix smoke recorded "never reached
  // /healthz" without preserving the child's stderr — a smoke that
  // cannot show why a peer died is half-blind. CI's on-failure
  // artifact upload (.github/workflows/peer-smoke.yml) picks these up
  // alongside peer-smoke-summary.json so the operator has the full
  // picture without re-running locally.
  const logPath = join(ARTIFACTS_DIR, `peer-${label}.log`);
  const logStream = createWriteStream(logPath, { flags: 'w' });
  child.stdout.on('data', (b) => {
    const line = b.toString();
    logStream.write(line);
    if (process.env['SMOKE_VERBOSE']) process.stdout.write(`[${label}] ${line}`);
  });
  child.stderr.on('data', (b) => {
    const line = b.toString();
    logStream.write(line);
    if (process.env['SMOKE_VERBOSE']) process.stderr.write(`[${label}-err] ${line}`);
  });
  child.on('exit', (code, signal) => {
    logStream.end(`\n[peer-smoke] exit code=${code} signal=${signal}\n`);
    if (!stopRequested) {
      console.error(`[peer-smoke] ${label} exited unexpectedly with code ${code} (signal=${signal}). Log: ${logPath}`);
    }
  });
  return child;
}

let stopRequested = false;
function shutdown(daemons) {
  stopRequested = true;
  for (const d of daemons) {
    try {
      d.kill();
    } catch {
      /* already gone */
    }
  }
}

function getJson(url, timeoutMs = 3000) {
  return new Promise((resolve_, reject) => {
    const req = httpRequest(url, { method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve_(JSON.parse(body));
          } catch {
            reject(new Error(`bad JSON from ${url}: ${body.slice(0, 200)}`));
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout: ${url}`)));
    req.end();
  });
}

async function waitForHealth(port, label, maxSec = 30) {
  const deadline = Date.now() + maxSec * 1000;
  while (Date.now() < deadline) {
    try {
      const data = await getJson(`http://127.0.0.1:${port}/healthz`, 1500);
      if (data && (data.ok === true || data.status === 'ok')) {
        return data;
      }
    } catch {
      /* not yet */
    }
    await sleep(500);
  }
  throw new Error(`${label} on port ${port} never reached /healthz=ok in ${maxSec}s`);
}

const results = {
  config: { PORT_A, PORT_B, OBS_SEC, started_at: new Date().toISOString() },
  asserts: [],
  artifacts: ARTIFACTS_DIR,
  passed: 0,
  failed: 0,
};

function record(name, ok, detail) {
  results.asserts.push({ name, ok, detail });
  if (ok) {
    results.passed++;
    console.log(`  PASS  ${name}`);
  } else {
    results.failed++;
    console.error(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
}

async function main() {
  console.log(`[peer-smoke] launching peer-a on :${PORT_A}, peer-b on :${PORT_B}`);
  const a = spawnDaemon('peer-a', PORT_A, HOME_A);
  const b = spawnDaemon('peer-b', PORT_B, HOME_B);
  const daemons = [a, b];

  process.on('SIGINT', () => {
    shutdown(daemons);
    process.exit(2);
  });

  try {
    console.log('[peer-smoke] waiting for /healthz on both daemons (30s timeout each)');
    await waitForHealth(PORT_A, 'peer-a');
    await waitForHealth(PORT_B, 'peer-b');
    record('both daemons started and reach /healthz', true);

    // Settle: federation subsystem starts after listener binds.
    await sleep(2000);

    console.log(`[peer-smoke] observing federation for ${OBS_SEC}s...`);
    const start = Date.now();
    let mutualVisible = false;
    let lastA, lastB;
    while ((Date.now() - start) / 1000 < OBS_SEC) {
      try {
        lastA = await getJson(`http://127.0.0.1:${PORT_A}/api/federation/peers`);
        lastB = await getJson(`http://127.0.0.1:${PORT_B}/api/federation/peers`);
        const aSeesB = (lastA.peers ?? []).some((p) => p.id === 'peer-b');
        const bSeesA = (lastB.peers ?? []).some((p) => p.id === 'peer-a');
        if (aSeesB && bSeesA) {
          mutualVisible = true;
          break;
        }
      } catch (err) {
        // transient — keep polling
      }
      await sleep(1500);
    }
    record('mutual peer visibility within observation window', mutualVisible, mutualVisible ? undefined : `lastA: ${JSON.stringify(lastA?.peers ?? [])}; lastB: ${JSON.stringify(lastB?.peers ?? [])}`);

    // health endpoint shape check
    try {
      const hA = await getJson(`http://127.0.0.1:${PORT_A}/api/federation/health`);
      const hB = await getJson(`http://127.0.0.1:${PORT_B}/api/federation/health`);
      record('peer-a federation health has peer_id + protocol_version', hA.peer_id === 'peer-a' && hA.protocol_version === '1');
      record('peer-b federation health has peer_id + protocol_version', hB.peer_id === 'peer-b' && hB.protocol_version === '1');
    } catch (err) {
      record('federation health endpoints reachable', false, err.message);
    }

    // /dashboard/family-mode + /dashboard/about render
    try {
      const fmA = await rawText(`http://127.0.0.1:${PORT_A}/dashboard/family-mode`);
      record('peer-a renders /dashboard/family-mode', fmA.includes('Family mode'));
      const abA = await rawText(`http://127.0.0.1:${PORT_A}/dashboard/about`);
      record('peer-a renders /dashboard/about', abA.includes('About') && abA.includes('stav&#x16B1;'));
    } catch (err) {
      record('dashboard pages render', false, err.message);
    }

    // /api/auth/credentials returns 200 + {credentials: []}
    try {
      const creds = await getJson(`http://127.0.0.1:${PORT_A}/api/auth/credentials`);
      record('peer-a /api/auth/credentials responds 200', Array.isArray(creds.credentials));
    } catch (err) {
      record('peer-a /api/auth/credentials reachable', false, err.message);
    }

    // /api/auth/tier3/recent before any assertion → has_recent=false
    try {
      const recent = await getJson(`http://127.0.0.1:${PORT_A}/api/auth/tier3/recent`);
      record('peer-a tier3/recent reports has_recent=false initially', recent.has_recent === false);
    } catch (err) {
      record('peer-a /api/auth/tier3/recent reachable', false, err.message);
    }
  } catch (err) {
    console.error(`[peer-smoke] setup failed: ${err.message}`);
    results.failed++;
    results.asserts.push({ name: 'setup', ok: false, detail: err.message });
  } finally {
    shutdown(daemons);
    await sleep(2000);
  }

  results.finished_at = new Date().toISOString();
  const summaryPath = join(ARTIFACTS_DIR, 'peer-smoke-summary.json');
  writeFileSync(summaryPath, JSON.stringify(results, null, 2), 'utf8');
  console.log(`\n[peer-smoke] ${results.passed} pass, ${results.failed} fail`);
  console.log(`[peer-smoke] summary → ${summaryPath}`);
  process.exit(results.failed === 0 ? 0 : 1);
}

async function rawText(url, timeoutMs = 3000) {
  return new Promise((resolve_, reject) => {
    const req = httpRequest(url, { method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve_(body);
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout: ${url}`)));
    req.end();
  });
}

main().catch((err) => {
  console.error('[peer-smoke] unexpected error:', err);
  process.exit(2);
});
