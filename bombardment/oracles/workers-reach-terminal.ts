/**
 * Oracle: every spawned worker reaches a terminal state (eventually).
 *
 * Terminal states: 'terminated', 'crashed'. Non-terminal: 'starting',
 * 'running', 'idle'. The oracle counts non-terminal workers whose
 * `last_activity_at` is older than the stuck threshold (default 5 min).
 * Anything matching is a zombie — spawned, never reached terminal, and
 * not making progress.
 *
 * Slack: workers actively serving load are fine — only stuck ones are
 * a violation. The "stuck" definition mirrors the watchdog: no activity
 * for STAVR_WORKER_STUCK_THRESHOLD_MS (default 5 min). At end-of-soak,
 * pass `requireAllTerminal` to fail on any non-terminal row at all.
 */

import type { Oracle, OracleResult } from './types.js';

const TERMINAL = new Set(['terminated', 'crashed']);
const STUCK_THRESHOLD_MS = Number.parseInt(process.env.STAVR_WORKER_STUCK_THRESHOLD_MS ?? `${5 * 60_000}`, 10) || 5 * 60_000;

export interface WorkersReachTerminalOpts {
  /** End-of-soak mode: any non-terminal worker is a violation, ignoring activity. */
  requireAllTerminal?: boolean;
}

export function makeWorkersReachTerminal(opts: WorkersReachTerminalOpts = {}): Oracle {
  return async (ctx) => {
    const start = Date.now();
    if (ctx.kind !== 'in-process') {
      return {
        name: 'workers_reach_terminal',
        ok: null,
        reason: 'requires in-process ctx',
        durationMs: Date.now() - start,
      };
    }
    let rows: Array<{ id: string; status: string; started_at: string | null; last_activity_at: string | null }>;
    try {
      rows = ctx.store.rawDb
        .prepare(`SELECT id, status, started_at, last_activity_at FROM workers`)
        .all() as Array<{ id: string; status: string; started_at: string | null; last_activity_at: string | null }>;
    } catch (err) {
      return {
        name: 'workers_reach_terminal',
        ok: null,
        reason: `workers table unreachable: ${(err as Error).message}`,
        durationMs: Date.now() - start,
      };
    }

    const nowMs = Date.now();
    const violations: Array<{ id: string; status: string; idle_ms: number | null; clock: 'last_activity_at' | 'started_at' | 'none' }> = [];
    for (const row of rows) {
      if (TERMINAL.has(row.status)) continue;
      // Fall back to started_at when last_activity_at is NULL. A worker
      // that crashed before recording its first activity (the
      // updateWorkerStatus path that writes last_activity_at never ran)
      // would otherwise evade detection forever: `null` would skip the
      // stuck check, the worker sits in 'starting'/'running' indefinitely.
      // With the fallback, alive-time-since-spawn becomes the floor.
      const clockSource: 'last_activity_at' | 'started_at' | 'none' = row.last_activity_at
        ? 'last_activity_at'
        : row.started_at
          ? 'started_at'
          : 'none';
      const idleMs =
        clockSource === 'last_activity_at'
          ? nowMs - Date.parse(row.last_activity_at!)
          : clockSource === 'started_at'
            ? nowMs - Date.parse(row.started_at!)
            : null;
      const stuck = opts.requireAllTerminal || (idleMs !== null && idleMs > STUCK_THRESHOLD_MS);
      if (stuck) {
        violations.push({ id: row.id, status: row.status, idle_ms: idleMs, clock: clockSource });
      }
    }

    const ok = violations.length === 0;
    const result: OracleResult = {
      name: 'workers_reach_terminal',
      ok,
      durationMs: Date.now() - start,
    };
    if (!ok) {
      result.reason = opts.requireAllTerminal
        ? `${violations.length} worker(s) non-terminal at end-of-run`
        : `${violations.length} worker(s) stuck (no activity > ${STUCK_THRESHOLD_MS}ms)`;
      result.evidence = { violations: violations.slice(0, 10), total_workers: rows.length, stuck_threshold_ms: STUCK_THRESHOLD_MS };
    }
    return result;
  };
}

/** Default continuous-mode oracle (stuck threshold only). */
export const workersReachTerminal: Oracle = makeWorkersReachTerminal();
