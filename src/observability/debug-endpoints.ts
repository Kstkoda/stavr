// src/observability/debug-endpoints.ts
//
// On-demand diagnostic endpoints for incident response. Spec:
// bom-diagnostics-2026.md C3.
//
// Three POST routes, all loopback-only AND gated by `STAVR_DEBUG_ENABLED=1`:
//
//   POST /debug/heap-snapshot      — writes a .heapsnapshot to tmp/heap-snapshots
//   POST /debug/cpu-profile?duration=N  — captures an N-second CPU profile
//   POST /debug/diagnostic-report  — writes a node Diagnostic Report
//
// When the gate is off OR the request is not from loopback, every route
// returns 404 (not 403 — we don't want to leak the existence of these
// endpoints to an unauthenticated probe). The loopback check is
// defense-in-depth on top of the daemon's 127.0.0.1 bind default.
//
// Each endpoint is rate-limited to one invocation per minute, per endpoint,
// to prevent an authenticated caller from DoS'ing the daemon by triggering
// repeated 30-second CPU profiles or 100MB+ heap snapshots back-to-back.

import { writeHeapSnapshot } from 'node:v8';
import { Session } from 'node:inspector';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import type { Request, Response } from 'express';
import type { Express } from 'express';
import { getLogger } from '../log.js';

const RATE_LIMIT_WINDOW_MS = 60_000;
const lastInvocation = new Map<string, number>();

export interface MountDebugEndpointsOpts {
  /** Override `Date.now()` for the rate-limit clock. Test seam. */
  now?: () => number;
  /** Override `process.env.STAVR_DEBUG_ENABLED` lookup. Test seam. */
  env?: NodeJS.ProcessEnv;
  /** Override `process.cwd()` for output directories. Test seam. */
  cwd?: () => string;
  /**
   * v0.4 — runtime toggle reader. When provided, the guard checks the
   * runtime_toggles row for `STAVR_DEBUG_ENABLED` (and per-endpoint
   * subkeys) BEFORE falling back to the environment. Lets operators flip
   * diagnostics from the dashboard without a PM2 restart while keeping
   * the env-var path working for headless / non-DB callers.
   */
  readToggle?: (key: string) => string | null;
  /**
   * v0.4 — fire-and-forget audit event emitter. When provided, each
   * successful /debug/* invocation emits `{heap_snapshot,cpu_profile,
   * diagnostic_report}_taken` with the output file path so Settings →
   * Diagnostics can list recent captures.
   */
  emitEvent?: (kind: string, payload: Record<string, unknown>) => void;
}

/**
 * v0.4 — granular per-endpoint toggle keys layered on top of the master.
 * An endpoint guard checks the master OR the per-endpoint key; either
 * being '1' opens the gate. This lets an operator enable JUST heap
 * snapshots from the dashboard while keeping the others off.
 */
export const DEBUG_TOGGLE_MASTER = 'STAVR_DEBUG_ENABLED';
export const DEBUG_TOGGLE_HEAP   = 'STAVR_DEBUG_HEAP';
export const DEBUG_TOGGLE_CPU    = 'STAVR_DEBUG_CPU';
export const DEBUG_TOGGLE_REPORT = 'STAVR_DEBUG_REPORT';

export function isDebugEnabled(
  env: NodeJS.ProcessEnv = process.env,
  readToggle?: (key: string) => string | null,
  perEndpointKey?: string,
): boolean {
  // Runtime toggle takes precedence — per the brief, the master is the
  // primary gate and the per-endpoint key is layered on top.
  if (readToggle) {
    const master = readToggle(DEBUG_TOGGLE_MASTER);
    if (master === '1' || master === 'true') return true;
    if (perEndpointKey) {
      const ep = readToggle(perEndpointKey);
      if (ep === '1' || ep === 'true') return true;
    }
  }
  const v = env.STAVR_DEBUG_ENABLED;
  return v === '1' || v === 'true';
}

export function isLoopbackReq(req: Request): boolean {
  const raw = req.socket.remoteAddress ?? '';
  const ip = raw.replace(/^::ffff:/, '');
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost' || ip === '';
}

export function checkRateLimit(key: string, now: () => number = Date.now): boolean {
  const last = lastInvocation.get(key);
  const t = now();
  if (last !== undefined && t - last < RATE_LIMIT_WINDOW_MS) return false;
  lastInvocation.set(key, t);
  return true;
}

/** Test seam: clear the rate-limit map between tests. Not exported in d.ts boundary docs. */
export function _resetRateLimitsForTest(): void {
  lastInvocation.clear();
}

export function mountDebugEndpoints(app: Express, opts: MountDebugEndpointsOpts = {}): void {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const cwd = opts.cwd ?? (() => process.cwd());
  const readToggle = opts.readToggle;
  const emit = opts.emitEvent ?? (() => { /* no-op when not wired */ });
  const logger = getLogger();

  const gated = (req: Request, res: Response, perEndpointKey?: string): boolean => {
    if (!isDebugEnabled(env, readToggle, perEndpointKey) || !isLoopbackReq(req)) {
      res.status(404).end();
      return false;
    }
    return true;
  };

  app.post('/debug/heap-snapshot', (req: Request, res: Response) => {
    if (!gated(req, res, DEBUG_TOGGLE_HEAP)) return;
    if (!checkRateLimit('heap-snapshot', now)) {
      res.status(429).json({ ok: false, error: 'rate_limited', retry_after_seconds: 60 });
      return;
    }
    try {
      const dir = resolvePath(cwd(), 'tmp', 'heap-snapshots');
      mkdirSync(dir, { recursive: true });
      const file = writeHeapSnapshot(resolvePath(dir, `snapshot-${now()}.heapsnapshot`));
      const size = statSync(file).size;
      logger.info('heap snapshot written', { file, size_bytes: size });
      emit('heap_snapshot_taken', { file, size_bytes: size });
      res.json({ ok: true, file, size_bytes: size });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  app.post('/debug/cpu-profile', async (req: Request, res: Response) => {
    if (!gated(req, res, DEBUG_TOGGLE_CPU)) return;
    if (!checkRateLimit('cpu-profile', now)) {
      res.status(429).json({ ok: false, error: 'rate_limited', retry_after_seconds: 60 });
      return;
    }
    const raw = Number(req.query.duration ?? 30);
    const duration = Math.min(Math.max(Number.isFinite(raw) && raw > 0 ? raw : 30, 1), 120);
    let session: Session | undefined;
    try {
      session = new Session();
      session.connect();
      await postPromise(session, 'Profiler.enable');
      await postPromise(session, 'Profiler.start');
      await new Promise<void>((r) => {
        const h = setTimeout(r, duration * 1000);
        h.unref?.();
      });
      const stopped = await postPromise<{ profile: unknown }>(session, 'Profiler.stop');
      const dir = resolvePath(cwd(), 'tmp', 'cpu-profiles');
      mkdirSync(dir, { recursive: true });
      const file = resolvePath(dir, `profile-${now()}.cpuprofile`);
      writeFileSync(file, JSON.stringify(stopped.profile));
      const size = statSync(file).size;
      logger.info('cpu profile written', { file, duration_seconds: duration, size_bytes: size });
      emit('cpu_profile_taken', { file, duration_seconds: duration, size_bytes: size });
      res.json({ ok: true, file, duration_seconds: duration, size_bytes: size });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    } finally {
      try { session?.disconnect(); } catch { /* already disconnected */ }
    }
  });

  app.post('/debug/diagnostic-report', (req: Request, res: Response) => {
    if (!gated(req, res, DEBUG_TOGGLE_REPORT)) return;
    if (!checkRateLimit('diagnostic-report', now)) {
      res.status(429).json({ ok: false, error: 'rate_limited', retry_after_seconds: 60 });
      return;
    }
    try {
      const dir = resolvePath(cwd(), 'tmp', 'diag-reports');
      mkdirSync(dir, { recursive: true });
      const target = resolvePath(dir, `report-${now()}.json`);
      const written = (process as unknown as { report: { writeReport: (p: string) => string } }).report.writeReport(target);
      const size = statSync(written).size;
      logger.info('diagnostic report written', { file: written, size_bytes: size });
      emit('diagnostic_report_taken', { file: written, size_bytes: size });
      res.json({ ok: true, file: written, size_bytes: size });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });
}

function postPromise<T = unknown>(session: Session, method: string, params?: Record<string, unknown>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    session.post(method, params ?? {}, (err: Error | null, result: unknown) => {
      if (err) reject(err);
      else resolve(result as T);
    });
  });
}
