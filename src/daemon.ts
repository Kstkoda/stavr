import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { safeWrite } from './util/atomic.js';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventStore } from './persistence.js';
import { Broker } from './broker.js';
import { mountTransports, type MountedTransports } from './transports.js';
import { defaultDbPath } from './paths.js';
import { getLogger } from './log.js';
import { STEWARD_MEMORY_ROOT } from './steward/tools.js';
import { loadMasterKey } from './credentials/vault.js';
import { CredentialStore } from './credentials/store.js';
import { setCredentialStore } from './server.js';
import { loadStewardConfig } from './steward/config.js';
import { makeAnthropicProvider } from './steward/providers/anthropic.js';
import { makeClaudeCodeProvider } from './steward/providers/claude-code.js';
import { startStewardLoop, type RunningLoop } from './steward/loop.js';
import type { StewardProvider } from './steward/providers/types.js';
import {
  mergeUserAdditions,
  setLiveNoGoList,
  STARTER_NO_GO_LIST,
  type NoGoEntry,
} from './trust/no-go-list.js';
import { start as startWorkerWatchdog } from './workers/watchdog.js';
import { loadConfig } from './config.js';
import { wireV02Subsystem, type V02SubsystemHandle } from './steward/v02-wiring.js';

export interface DaemonOptions {
  port: number;
  db: string;
  detach: boolean;
  force?: boolean;
  logFormat?: 'text' | 'json';
  /** Host to bind HTTP/SSE on. Defaults to `127.0.0.1` (spec 52). */
  bindHost?: string;
  /** Refuse non-loopback bind without auth. Defaults to true. */
  requireAuthWhenNonLocal?: boolean;
  /** Pairing/auth subsystem readiness. A1 always passes false; A2 wires it. */
  authConfigured?: boolean;
}

export interface DaemonPidFile {
  pid: number;
  port: number;
  started_at: string;
  db: string;
  bind_host?: string;
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

function stavrHomeDir(): string {
  return process.env.STAVR_HOME?.trim() || join(homedir(), '.stavr');
}

function pidDir(): string {
  return stavrHomeDir();
}

function pidFile(): string {
  return join(pidDir(), 'daemon.pid');
}

export function pidFilePath(): string {
  return pidFile();
}

export function readPidFile(): DaemonPidFile | undefined {
  const f = pidFile();
  if (!existsSync(f)) return undefined;
  try {
    const raw = readFileSync(f, 'utf8');
    return JSON.parse(raw) as DaemonPidFile;
  } catch {
    return undefined;
  }
}

function writePidFileAtomic(record: DaemonPidFile): void {
  safeWrite(pidFile(), JSON.stringify(record, null, 2));
}

function removePidFile(): void {
  try {
    unlinkSync(pidFile());
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
  const stalePid = existing && !isProcessAlive(existing.pid) ? existing : undefined;
  if (existing && isProcessAlive(existing.pid) && !opts.force) {
    throw new Error(
      `daemon already running (pid ${existing.pid} on port ${existing.port}). ` +
        `Use --force to override or 'stavr daemon stop' first.`,
    );
  }
  const logger = getLogger();
  if (stalePid) {
    logger.warn('stale PID file detected; daemon will overwrite it', {
      dead_pid: stalePid.pid,
    });
  }

  const store = new EventStore();
  const initResult = store.init(opts.db);
  const broker = new Broker(store);

  // Spec 51: emit a structured event so dashboards / oncall see the recovery.
  if (stalePid) {
    try {
      await broker.publish({
        kind: 'stale_pid_cleaned',
        at: new Date().toISOString(),
        source_agent: 'stavr-daemon',
        payload: {
          dead_pid: stalePid.pid,
          port: stalePid.port,
          pid_file_path: pidFile(),
        },
      });
    } catch (err) {
      logger.error('failed to emit stale_pid_cleaned', { error: (err as Error).message });
    }
  }

  // Spec 48 Layer 1: ensure the Steward memory root exists so per-steward
  // subdirs created at claim time have a stable parent. Contents are opaque
  // to the daemon — Stewards own their working memory format.
  mkdirSync(STEWARD_MEMORY_ROOT, { recursive: true });

  // Spec 48 Layer 2: load the master key once on boot. Required before any
  // credential_use call can decrypt a stored secret. If the OS keychain isn't
  // available we fall back to ~/.stavr/master.key and emit credential_unsafe_storage.
  try {
    const keyResult = await loadMasterKey();
    setCredentialStore(broker, new CredentialStore(store, keyResult.key));
    if (keyResult.unsafeStorageReason) {
      try {
        await broker.publish({
          kind: 'credential_unsafe_storage',
          at: new Date().toISOString(),
          source_agent: 'stavr-daemon',
          payload: {
            reason: keyResult.unsafeStorageReason,
            fallback_path: 'master-key-file',
          },
        });
      } catch (err) {
        getLogger().error('failed to emit credential_unsafe_storage', {
          error: (err as Error).message,
        });
      }
    }
  } catch (err) {
    getLogger().error('credential vault key load failed; credential tools disabled', {
      error: (err as Error).message,
    });
  }

  // Spec 48 Layer 3: load optional User additions from ~/.stavr/no-go-additions.ts.
  // Users can ADD entries; mergeUserAdditions() refuses to override built-ins.
  await loadNoGoAdditions();

  // If we just had to quarantine a corrupt DB, surface the event so subscribers
  // (dashboard, oncall) see it. Best-effort; the daemon must come up either way.
  if (initResult.recoveredFromCorruption) {
    try {
      await broker.publish({
        kind: 'error',
        at: new Date().toISOString(),
        source_agent: 'stavr-daemon',
        payload: {
          message: 'db corrupted; quarantined and rebuilt from empty schema',
          recoverable: true,
          attempted_recovery: `renamed to ${initResult.recoveredFromCorruption}; started fresh`,
        },
      });
    } catch (err) {
      logger.error('failed to emit db-recovery event', { error: (err as Error).message });
    }
  }

  const bindHost = opts.bindHost ?? '127.0.0.1';
  // Re-compute authConfigured from the freshly-opened store so the detached
  // child sees the same state the parent CLI did. Spec 52 A2.
  const authConfigured = opts.authConfigured ?? store.countActiveDevices() > 0;
  const transports = await mountTransports(broker, {
    mode: 'daemon',
    port: opts.port,
    bindHost,
    requireAuthWhenNonLocal: opts.requireAuthWhenNonLocal,
    authConfigured,
  });

  writePidFileAtomic({
    pid: process.pid,
    port: opts.port,
    started_at: new Date().toISOString(),
    db: opts.db,
    bind_host: bindHost,
  });
  logger.info('daemon ready', {
    address: `${bindHost}:${opts.port}`,
    db: opts.db,
    pid: process.pid,
  });

  installCrashHandler(store);

  // Spec 49 Layer 1: daemon-hosted Steward. Spawns only if
  // ~/.stavr/steward-config.yaml exists AND `steward.enabled: true`.
  let stewardLoop: RunningLoop | undefined;
  try {
    const cfgResult = loadStewardConfig();
    if (cfgResult.config?.steward.enabled) {
      const provider = makeProviderFromConfig(cfgResult.config);
      stewardLoop = await startStewardLoop({
        broker,
        provider,
        config: cfgResult.config,
        toolDispatcher: async (_tool, _args) => {
          // v1: in-process tool dispatcher is a no-op placeholder. The
          // tool surface gets wired in spec 49 Layer 2 (operator channels).
          return undefined;
        },
      });
      logger.info('steward subprocess started', {
        provider: cfgResult.config.steward.provider,
        model: cfgResult.config.steward.model,
      });
    } else if (cfgResult.error) {
      logger.warn('steward-config.yaml present but invalid; steward disabled', {
        path: cfgResult.path,
        error: cfgResult.error,
      });
    }
  } catch (err) {
    logger.error('failed to start steward; daemon continues without it', {
      error: (err as Error).message,
    });
  }

  const workerWatchdog = startWorkerWatchdog(broker, store);

  // v0.2 — planner + executor + connector registry. Gated by experimental.planner.
  // When the flag is off, this whole subsystem stays dormant.
  let v02: V02SubsystemHandle | undefined;
  try {
    const cfg = loadConfig();
    if (cfg.config.experimental?.planner) {
      v02 = wireV02Subsystem({ broker, store });
    } else {
      logger.info('experimental.planner is false; v0.2 subsystem dormant', {
        source: cfg.source,
        path: cfg.path,
      });
    }
  } catch (err) {
    logger.error('failed to wire v0.2 subsystem; daemon continues without it', {
      error: (err as Error).message,
    });
  }

  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal: sig });
    if (stewardLoop) {
      try {
        await stewardLoop.stop('shutdown');
      } catch {
        /* best effort */
      }
    }
    workerWatchdog.stop();
    if (v02) {
      try { v02.stop(); } catch { /* best effort */ }
    }
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
  if (opts.logFormat) args.push('--log-format', opts.logFormat);
  if (opts.bindHost) args.push('--bind-host', opts.bindHost);
  if (opts.requireAuthWhenNonLocal === false) args.push('--allow-non-local-without-auth');

  const child = spawn(process.execPath, [cliEntry, ...args], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, STAVR_DAEMON_DETACHED_CHILD: '1' },
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

function makeProviderFromConfig(config: {
  steward: { provider: 'anthropic' | 'claude-code'; model: string };
}): StewardProvider {
  if (config.steward.provider === 'anthropic') {
    const apiKey = process.env.ANTHROPIC_API_KEY ?? '';
    return makeAnthropicProvider({ apiKey, model: config.steward.model });
  }
  return makeClaudeCodeProvider({ model: config.steward.model });
}

/**
 * Load `~/.stavr/no-go-additions.ts` (or .js) if it exists and `export default
 * NoGoEntry[]`. Best-effort: parse / type errors are logged and the daemon
 * boots with just the built-in list. Built-in entries can never be overridden
 * — mergeUserAdditions strips duplicate ids before installing the live list.
 */
async function loadNoGoAdditions(): Promise<void> {
  const candidates = [
    join(homedir(), '.stavr', 'no-go-additions.ts'),
    join(homedir(), '.stavr', 'no-go-additions.js'),
    join(homedir(), '.stavr', 'no-go-additions.mjs'),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const url = `file://${path.replace(/\\/g, '/')}`;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = (await import(/* @vite-ignore */ url)) as { default?: NoGoEntry[] };
      const extras = mod.default ?? [];
      if (!Array.isArray(extras)) {
        getLogger().warn('no-go-additions: default export is not an array; ignoring', { path });
        return;
      }
      setLiveNoGoList(mergeUserAdditions(extras));
      getLogger().info('no-go-additions loaded', { path, added: extras.length });
      return;
    } catch (err) {
      getLogger().error('failed to load no-go-additions; sticking to built-ins', {
        path,
        error: (err as Error).message,
      });
      setLiveNoGoList(STARTER_NO_GO_LIST);
      return;
    }
  }
}

/**
 * Top-level uncaughtException / unhandledRejection trap. Writes a JSON crash
 * dump under ~/.stavr/crash-<ts>.json and exits 1 so the watchdog (ADR-020)
 * restarts. Pulls the last 100 events for postmortem; failures during dump
 * generation are swallowed — we'd rather die than infinitely loop on errors.
 */
let crashHandlerInstalled = false;
export function installCrashHandler(store: EventStore): void {
  if (crashHandlerInstalled) return;
  crashHandlerInstalled = true;

  const dump = (label: 'uncaughtException' | 'unhandledRejection', err: unknown) => {
    const e = err instanceof Error ? err : new Error(String(err));
    let recent: unknown[] = [];
    try {
      recent = store.getEvents({ limit: 100 }).events;
    } catch {
      /* DB might be the thing that broke */
    }
    const payload = {
      label,
      timestamp: new Date().toISOString(),
      error: { message: e.message, stack: e.stack },
      pid: process.pid,
      recent_events: recent,
    };
    try {
      mkdirSync(pidDir(), { recursive: true });
      const path = join(pidDir(), `crash-${Date.now()}.json`);
      safeWrite(path, JSON.stringify(payload, null, 2));
      getLogger().error('crash dump written', { path, label, message: e.message });
    } catch (dumpErr) {
      getLogger().error('failed to write crash dump', {
        label,
        original: e.message,
        dump_error: (dumpErr as Error).message,
      });
    }
    process.exit(1);
  };

  process.on('uncaughtException', (err) => dump('uncaughtException', err));
  process.on('unhandledRejection', (reason) => dump('unhandledRejection', reason));
}
