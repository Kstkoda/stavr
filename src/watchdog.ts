#!/usr/bin/env node
/**
 * Daemon watchdog (ADR-020). Pings `/healthz` every 30s; after 3 consecutive
 * failures it restarts the daemon by invoking the cowire CLI.
 *
 * Stays simple on purpose:
 *  - Plain Node, no extra deps.
 *  - Single-file log at `~/.cowire/watchdog.log`. Newline-delimited JSON.
 *  - Re-uses `cowire daemon start --detach` / `cowire daemon stop` so we
 *    don't duplicate PID management.
 *  - Runs `forever` when registered via OS scheduler; in tests we can run it
 *    once via `runWatchdogOnce`.
 *
 * Config:
 *  - COWIRE_WATCHDOG_URL (default http://127.0.0.1:7777/healthz)
 *  - COWIRE_WATCHDOG_INTERVAL_MS (default 30000)
 *  - COWIRE_WATCHDOG_FAIL_THRESHOLD (default 3)
 *  - COWIRE_WATCHDOG_PORT (default 7777, used when invoking `cowire daemon start`)
 */
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WATCHDOG_DIR = join(homedir(), '.cowire');
export const WATCHDOG_LOG_PATH = join(WATCHDOG_DIR, 'watchdog.log');
export const WATCHDOG_PID_PATH = join(WATCHDOG_DIR, 'watchdog.pid');

export interface WatchdogConfig {
  healthUrl: string;
  intervalMs: number;
  failThreshold: number;
  /** Minimum gap between two restart attempts. Protects against tight crash loops. */
  restartCooldownMs: number;
  cliEntry: string;
  /** How long to wait for a ping before timing it out. */
  pingTimeoutMs: number;
  /** Daemon port to use when restarting via `cowire daemon start --port`. */
  port: number;
}

export function defaultWatchdogConfig(): WatchdogConfig {
  const here = dirname(fileURLToPath(import.meta.url));
  return {
    healthUrl: process.env.COWIRE_WATCHDOG_URL ?? 'http://127.0.0.1:7777/healthz',
    intervalMs: parseInt(process.env.COWIRE_WATCHDOG_INTERVAL_MS ?? '30000', 10),
    failThreshold: parseInt(process.env.COWIRE_WATCHDOG_FAIL_THRESHOLD ?? '3', 10),
    restartCooldownMs: parseInt(process.env.COWIRE_WATCHDOG_COOLDOWN_MS ?? '60000', 10),
    cliEntry: join(here, 'cli.js'),
    pingTimeoutMs: parseInt(process.env.COWIRE_WATCHDOG_PING_TIMEOUT_MS ?? '5000', 10),
    port: parseInt(process.env.COWIRE_WATCHDOG_PORT ?? '7777', 10),
  };
}

export function appendWatchdogLog(entry: Record<string, unknown>): void {
  try {
    mkdirSync(WATCHDOG_DIR, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
    appendFileSync(WATCHDOG_LOG_PATH, line);
  } catch {
    /* swallow — the watchdog must never throw because it can't log */
  }
}

export async function pingDaemon(url: string, timeoutMs: number): Promise<{ ok: boolean; status?: number; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

export function restartDaemonViaCli(cfg: WatchdogConfig): Promise<{ ok: boolean; code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    let stderr = '';
    // Best-effort stop first (no-op if not running). Then start detached.
    const stop = spawn(process.execPath, [cfg.cliEntry, 'daemon', 'stop'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    stop.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
    stop.on('close', () => {
      const start = spawn(
        process.execPath,
        [cfg.cliEntry, 'daemon', 'start', '--detach', '--port', String(cfg.port), '--log-format', 'json'],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      start.stderr?.on('data', (d) => {
        stderr += d.toString();
      });
      start.on('close', (code) => {
        resolve({ ok: code === 0, code, stderr });
      });
      start.on('error', (err) => {
        resolve({ ok: false, code: null, stderr: stderr + String(err) });
      });
    });
    stop.on('error', () => {
      // Stop failed — still try start.
      const start = spawn(
        process.execPath,
        [cfg.cliEntry, 'daemon', 'start', '--detach', '--port', String(cfg.port), '--log-format', 'json'],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      start.stderr?.on('data', (d) => {
        stderr += d.toString();
      });
      start.on('close', (code) => {
        resolve({ ok: code === 0, code, stderr });
      });
    });
  });
}

export interface RunWatchdogOnceResult {
  ok: boolean;
  consecutive_failures: number;
  restarted: boolean;
  restart_count: number;
  last_status?: number;
  last_error?: string;
}

/**
 * Single-iteration runner exposed for tests and `watchdog-status`. Mutates
 * `state` in place. Returns a snapshot suitable for logging.
 */
export interface WatchdogState {
  consecutiveFailures: number;
  lastRestartAt: number;
  restartCount: number;
}

export async function runWatchdogOnce(
  state: WatchdogState,
  cfg: WatchdogConfig,
): Promise<RunWatchdogOnceResult> {
  const ping = await pingDaemon(cfg.healthUrl, cfg.pingTimeoutMs);
  if (ping.ok) {
    state.consecutiveFailures = 0;
    appendWatchdogLog({ event: 'ping', ok: true, status: ping.status });
    return {
      ok: true,
      consecutive_failures: 0,
      restarted: false,
      restart_count: state.restartCount,
      last_status: ping.status,
    };
  }

  state.consecutiveFailures += 1;
  appendWatchdogLog({
    event: 'ping',
    ok: false,
    status: ping.status,
    error: ping.error,
    consecutive_failures: state.consecutiveFailures,
  });

  const now = Date.now();
  const shouldRestart =
    state.consecutiveFailures >= cfg.failThreshold && now - state.lastRestartAt >= cfg.restartCooldownMs;
  if (!shouldRestart) {
    return {
      ok: false,
      consecutive_failures: state.consecutiveFailures,
      restarted: false,
      restart_count: state.restartCount,
      last_status: ping.status,
      last_error: ping.error,
    };
  }

  appendWatchdogLog({ event: 'restart_begin', after_consecutive_failures: state.consecutiveFailures });
  const restart = await restartDaemonViaCli(cfg);
  state.lastRestartAt = Date.now();
  state.consecutiveFailures = 0;
  state.restartCount += 1;
  appendWatchdogLog({
    event: 'restart_end',
    ok: restart.ok,
    code: restart.code,
    stderr: restart.stderr.slice(-512),
    restart_count: state.restartCount,
  });
  return {
    ok: false,
    consecutive_failures: 0,
    restarted: true,
    restart_count: state.restartCount,
    last_status: ping.status,
    last_error: ping.error,
  };
}

async function main(): Promise<void> {
  const cfg = defaultWatchdogConfig();
  const state: WatchdogState = {
    consecutiveFailures: 0,
    lastRestartAt: 0,
    restartCount: 0,
  };
  // Mark our PID so `daemon watchdog-status` can find us.
  try {
    mkdirSync(WATCHDOG_DIR, { recursive: true });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      WATCHDOG_PID_PATH,
      JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }, null, 2),
    );
  } catch {
    /* non-fatal */
  }
  appendWatchdogLog({ event: 'watchdog_start', pid: process.pid, config: cfg });

  // SIGTERM/SIGINT: log and exit cleanly so install/uninstall cycles don't lie.
  const stop = (sig: string) => {
    appendWatchdogLog({ event: 'watchdog_stop', signal: sig });
    process.exit(0);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  // Loop forever. We avoid setInterval so we never overlap iterations on a
  // slow ping/restart.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await runWatchdogOnce(state, cfg);
    await new Promise((r) => setTimeout(r, cfg.intervalMs));
  }
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((err) => {
    appendWatchdogLog({ event: 'watchdog_fatal', error: (err as Error).message });
    process.exit(1);
  });
}
