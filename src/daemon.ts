import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventStore } from './persistence.js';
import { Broker } from './broker.js';
import { mountTransports, type MountedTransports } from './transports.js';
import { defaultDbPath } from './paths.js';

export interface DaemonOptions {
  port: number;
  db: string;
  detach: boolean;
  force?: boolean;
}

export interface DaemonPidFile {
  pid: number;
  port: number;
  started_at: string;
  db: string;
}

export interface DaemonStatusResult {
  running: boolean;
  pid?: number;
  port?: number;
  started_at?: string;
  db?: string;
  uptime_sec?: number;
  connected_clients?: number;
  event_count?: number;
  pending_decisions?: number;
}

const PID_DIR = join(homedir(), '.cowire');
const PID_FILE = join(PID_DIR, 'daemon.pid');

export function pidFilePath(): string {
  return PID_FILE;
}

export function readPidFile(): DaemonPidFile | undefined {
  if (!existsSync(PID_FILE)) return undefined;
  try {
    const raw = readFileSync(PID_FILE, 'utf8');
    return JSON.parse(raw) as DaemonPidFile;
  } catch {
    return undefined;
  }
}

function writePidFileAtomic(record: DaemonPidFile): void {
  mkdirSync(PID_DIR, { recursive: true });
  const tmp = PID_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(record, null, 2));
  renameSync(tmp, PID_FILE);
}

function removePidFile(): void {
  try {
    unlinkSync(PID_FILE);
  } catch {
    /* ignore */
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 doesn't deliver — only checks permission/existence.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    // EPERM means the process exists but we can't signal it; treat as alive.
    return e.code === 'EPERM';
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Start the Switch daemon in the current process. Binds HTTP/SSE on 127.0.0.1:port,
 * writes a PID file, and installs signal handlers for graceful shutdown.
 * Used when `--detach` is NOT set (foreground) or, internally, by the detached child.
 */
export async function startDaemonForeground(opts: DaemonOptions): Promise<MountedTransports> {
  const existing = readPidFile();
  if (existing && isProcessAlive(existing.pid) && !opts.force) {
    throw new Error(
      `daemon already running (pid ${existing.pid} on port ${existing.port}). ` +
        `Use --force to override or 'cowire daemon stop' first.`,
    );
  }
  if (existing && !isProcessAlive(existing.pid)) {
    console.error(`[cowire] stale PID file for dead pid ${existing.pid}; overwriting`);
  }

  const store = new EventStore();
  store.init(opts.db);
  const broker = new Broker(store);

  const transports = await mountTransports(broker, {
    mode: 'daemon',
    port: opts.port,
  });

  writePidFileAtomic({
    pid: process.pid,
    port: opts.port,
    started_at: new Date().toISOString(),
    db: opts.db,
  });
  console.error(`[cowire] daemon ready on 127.0.0.1:${opts.port}, db=${opts.db}, pid=${process.pid}`);

  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[cowire] received ${sig}; shutting down`);
    await transports.shutdown();
    removePidFile();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  return transports;
}

/**
 * Public entry point used by the CLI. Either runs the daemon in the foreground or
 * forks a detached child that does. In the foreground case this never returns
 * normally — it blocks until the process is signalled.
 */
export async function startDaemon(opts: DaemonOptions): Promise<{ pid: number; detached: boolean }> {
  if (opts.detach) {
    return spawnDetachedDaemon(opts);
  }
  await startDaemonForeground(opts);
  // Foreground: block until shutdown handler exits.
  await new Promise(() => {});
  return { pid: process.pid, detached: false }; // unreachable
}

function spawnDetachedDaemon(opts: DaemonOptions): { pid: number; detached: true } {
  // Locate the compiled CLI entry point. This module lives under dist/ at runtime,
  // so cli.js sits beside us.
  const here = dirname(fileURLToPath(import.meta.url));
  const cliEntry = join(here, 'cli.js');

  const args = ['daemon', 'start', '--port', String(opts.port), '--db', opts.db];
  if (opts.force) args.push('--force');

  const child = spawn(process.execPath, [cliEntry, ...args], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, COWIRE_DAEMON_DETACHED_CHILD: '1' },
  });
  child.unref();
  if (typeof child.pid !== 'number') {
    throw new Error('failed to spawn detached daemon');
  }
  return { pid: child.pid, detached: true };
}

/**
 * Stop a running daemon by sending SIGTERM, then SIGKILL after a 10s grace period.
 */
export async function stopDaemon(): Promise<{ pid: number; stopped: boolean }> {
  const record = readPidFile();
  if (!record) {
    return { pid: 0, stopped: false };
  }
  if (!isProcessAlive(record.pid)) {
    removePidFile();
    return { pid: record.pid, stopped: true };
  }

  try {
    process.kill(record.pid, 'SIGTERM');
  } catch {
    /* already gone */
  }

  const deadlineMs = Date.now() + 10_000;
  while (Date.now() < deadlineMs) {
    if (!isProcessAlive(record.pid)) {
      removePidFile();
      return { pid: record.pid, stopped: true };
    }
    await sleep(200);
  }

  // Last resort.
  try {
    process.kill(record.pid, 'SIGKILL');
  } catch {
    /* ignore */
  }
  await sleep(300);
  const stopped = !isProcessAlive(record.pid);
  if (stopped) removePidFile();
  return { pid: record.pid, stopped };
}

/**
 * Inspect daemon state. If alive, fetches `/status` from the daemon's HTTP server
 * to surface live counts (connected clients, events, pending decisions). Falls back
 * to PID-file-only info if the HTTP call fails.
 */
export async function daemonStatus(): Promise<DaemonStatusResult> {
  const record = readPidFile();
  if (!record) return { running: false };
  if (!isProcessAlive(record.pid)) return { running: false };

  const uptime_sec = Math.floor((Date.now() - new Date(record.started_at).getTime()) / 1000);
  const base: DaemonStatusResult = {
    running: true,
    pid: record.pid,
    port: record.port,
    started_at: record.started_at,
    db: record.db,
    uptime_sec,
  };

  try {
    const live = await fetchStatus(record.port);
    return { ...base, ...live };
  } catch {
    return base;
  }
}

async function fetchStatus(
  port: number,
): Promise<Pick<DaemonStatusResult, 'connected_clients' | 'event_count' | 'pending_decisions'>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/status`, { signal: controller.signal });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const body = (await res.json()) as {
      sse_sessions?: number;
      events?: number;
      pending_decisions?: number;
    };
    return {
      connected_clients: body.sse_sessions ?? 0,
      event_count: body.events ?? 0,
      pending_decisions: body.pending_decisions ?? 0,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Stop the daemon and start a fresh one with the same port/db as the previous run. */
export async function restartDaemon(): Promise<{ pid: number; port: number; db: string }> {
  const prev = readPidFile();
  if (!prev) throw new Error('no daemon to restart (no PID file)');
  await stopDaemon();
  const { pid } = await startDaemon({
    port: prev.port,
    db: prev.db,
    detach: true,
  });
  // Wait briefly for the child to write its PID file.
  for (let i = 0; i < 25; i++) {
    const rec = readPidFile();
    if (rec && isProcessAlive(rec.pid)) {
      return { pid: rec.pid, port: rec.port, db: rec.db };
    }
    await sleep(200);
  }
  return { pid, port: prev.port, db: prev.db };
}

export function getDefaultDbPath(): string {
  return defaultDbPath();
}
