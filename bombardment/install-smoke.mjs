#!/usr/bin/env node
// Bombardment Phase 0 — install-smoke.
//
// Boots `node dist/cli.js daemon start --port 0` against an isolated
// STAVR_HOME, polls /status until ready, asserts the reported version
// equals package.json#version, kills the daemon. Cross-platform pure
// Node so the same script runs on Ubuntu and Windows CI runners.
//
// What this catches (recon defect #5 + chunk of defect #2):
//   - /status reporting a stale version (pre-fix it reported "0.1.0"
//     regardless of the built version because STAVR_VERSION was never
//     populated; the build-time bake in src/version.generated.ts fixes
//     it and this smoke is the regression guard).
//   - The built artifact failing to boot at all (npm-resolution
//     drift, missing optional native deps that turn out to be load-
//     bearing, broken --port 0 binding, etc.). The wincred ^1.1.6
//     phantom-dep class of defect.
//
// What this does NOT catch (deferred):
//   - True install-from-tarball (`npm pack` + `npm install -g`).
//   - SEA bundle behaviour (no dist/cli.js in the SEA path).
//   - Windows Service install.
//
// Usage:
//   node bombardment/install-smoke.mjs            # default ~30s timeout
//   node bombardment/install-smoke.mjs --timeout-seconds 60
//   STAVR_INSTALL_SMOKE_VERBOSE=1 node bombardment/install-smoke.mjs
//
// Exit codes:
//   0 — /status.version == package.json#version
//   1 — assertion failed (mismatch, or unexpected /status shape)
//   2 — setup failure (build artifact missing, daemon never booted,
//       timeout waiting for /status)

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DIST_CLI = join(ROOT, 'dist', 'cli.js');
const PKG_JSON = join(ROOT, 'package.json');

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, arr) => {
    if (!a.startsWith('--')) return [];
    const next = arr[i + 1];
    if (next === undefined || next.startsWith('--')) return [[a.slice(2), 'true']];
    return [[a.slice(2), next]];
  }),
);

const TIMEOUT_SEC = Number(args['timeout-seconds'] ?? '30');
const VERBOSE = process.env.STAVR_INSTALL_SMOKE_VERBOSE === '1';

function log(msg) {
  process.stdout.write(`[install-smoke] ${msg}\n`);
}

function err(msg) {
  process.stderr.write(`[install-smoke] ${msg}\n`);
}

function getJson(url, timeoutMs = 2000) {
  return new Promise((resolveP, rejectP) => {
    const req = httpRequest(url, { method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolveP(JSON.parse(body));
          } catch {
            rejectP(new Error(`non-JSON response from ${url}: ${body.slice(0, 200)}`));
          }
        } else {
          rejectP(new Error(`HTTP ${res.statusCode} from ${url}: ${body.slice(0, 200)}`));
        }
      });
    });
    req.on('error', rejectP);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout: ${url}`)));
    req.end();
  });
}

function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (platform() === 'win32') {
    // Node's child.kill() does not terminate the process group on Windows;
    // a daemon spawned via cmd shell wrapper can leak. taskkill /T /F walks
    // the tree. Best-effort — ignore errors.
    try {
      const tk = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      tk.on('error', () => {});
    } catch {
      /* fall through */
    }
  } else {
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
}

async function main() {
  if (!existsSync(DIST_CLI)) {
    err(`dist/cli.js missing at ${DIST_CLI} — run \`npm run build\` first`);
    process.exit(2);
  }
  if (!existsSync(PKG_JSON)) {
    err(`package.json missing at ${PKG_JSON}`);
    process.exit(2);
  }

  const pkg = JSON.parse(readFileSync(PKG_JSON, 'utf8'));
  const expectedVersion = pkg.version;
  if (typeof expectedVersion !== 'string' || expectedVersion.length === 0) {
    err(`package.json#version is missing or not a string`);
    process.exit(2);
  }
  log(`expected version (from package.json): ${expectedVersion}`);

  const stavrHome = mkdtempSync(join(tmpdir(), 'stavr-install-smoke-'));
  log(`STAVR_HOME=${stavrHome}`);

  const env = {
    ...process.env,
    STAVR_HOME: stavrHome,
    NODE_ENV: 'production',
    // Intentionally NOT setting STAVR_VERSION — the whole point is to
    // confirm /status reports the right version WITHOUT the env var,
    // i.e. via the build-time bake. If a future regression makes
    // /status fall back to STAVR_VERSION, this smoke catches it.
  };
  // Strip any inherited STAVR_VERSION so the bake is exercised cleanly.
  delete env.STAVR_VERSION;

  const child = spawn(process.execPath, [DIST_CLI, 'daemon', 'start', '--port', '0'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logLines = [];
  let port = null;
  const portRegex = /HTTP\/SSE listening on 127\.0\.0\.1:(\d+)/;

  const onChunk = (buf) => {
    const text = buf.toString('utf8');
    logLines.push(text);
    if (VERBOSE) process.stdout.write(`[daemon] ${text}`);
    const m = portRegex.exec(text);
    if (m && port === null) port = Number(m[1]);
  };
  child.stdout.on('data', onChunk);
  child.stderr.on('data', onChunk);

  let exitedEarly = null;
  child.on('exit', (code, signal) => {
    if (port === null) exitedEarly = { code, signal };
  });

  // Poll for the listener.
  const deadline = Date.now() + TIMEOUT_SEC * 1000;
  while (port === null && Date.now() < deadline) {
    if (exitedEarly) {
      err(`daemon exited before binding a port (code=${exitedEarly.code}, signal=${exitedEarly.signal})`);
      err(`captured output:\n${logLines.join('')}`);
      rmSync(stavrHome, { recursive: true, force: true });
      process.exit(2);
    }
    await sleep(250);
  }
  if (port === null) {
    err(`daemon did not print a listening port within ${TIMEOUT_SEC}s`);
    err(`captured output:\n${logLines.join('')}`);
    killTree(child);
    rmSync(stavrHome, { recursive: true, force: true });
    process.exit(2);
  }
  log(`daemon listening on 127.0.0.1:${port}`);

  // /status with a few retries — even after the bind, the app may have
  // a few more middlewares to wire.
  let status = null;
  let lastErr = null;
  for (let i = 0; i < 10; i++) {
    try {
      status = await getJson(`http://127.0.0.1:${port}/status`);
      break;
    } catch (e) {
      lastErr = e;
      await sleep(300);
    }
  }
  if (!status) {
    err(`/status never responded: ${lastErr?.message ?? 'unknown error'}`);
    killTree(child);
    rmSync(stavrHome, { recursive: true, force: true });
    process.exit(2);
  }
  log(`/status response: ${JSON.stringify(status)}`);

  let pass = true;
  if (status.ok !== true) {
    err(`/status.ok !== true (got ${JSON.stringify(status.ok)})`);
    pass = false;
  }
  if (typeof status.version !== 'string') {
    err(`/status.version is not a string (got ${JSON.stringify(status.version)})`);
    pass = false;
  } else if (status.version !== expectedVersion) {
    err(`/status.version mismatch: expected ${JSON.stringify(expectedVersion)}, got ${JSON.stringify(status.version)}`);
    pass = false;
  } else {
    log(`PASS: /status.version (${status.version}) == package.json#version (${expectedVersion})`);
  }

  killTree(child);
  // Give the daemon a moment to release the SQLite WAL on Windows.
  await sleep(500);
  try {
    rmSync(stavrHome, { recursive: true, force: true });
  } catch {
    // Windows WAL handles can linger briefly; not material to the assertion.
  }

  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  err(`unexpected error: ${e?.stack ?? e?.message ?? e}`);
  process.exit(2);
});
