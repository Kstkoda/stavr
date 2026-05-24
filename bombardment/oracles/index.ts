/**
 * Bombardment Phase 1 — oracle registry + driver.
 *
 * Public API:
 *   - `defaultOracles()` — the continuously-assertable seed set used by
 *     the soak harness (no end-of-run-only oracles).
 *   - `runOracles(ctx, oracles?)` — run a list (or the default set) and
 *     return their results.
 *   - Each oracle is also exported individually for targeted unit tests.
 *
 * Sequencing: oracles run sequentially (not in parallel). The cost of
 * each is dominated by a single SQLite scan or one HTTP probe; running
 * concurrently against a busy daemon under soak would only add noise,
 * and the cumulative wall-clock is well under a sample window.
 *
 * Continuous-mode invariant: every oracle in `defaultOracles()` MUST
 * be safe to run mid-load — no writes, no destructive side-effects,
 * no long blocking calls. End-of-run-only oracles (e.g.
 * `workersReachTerminal({ requireAllTerminal: true })`) are not in
 * the default set and must be invoked explicitly by the harness.
 */

export type { Oracle, OracleCtx, OracleResult, InProcessOracleCtx, HttpOracleCtx } from './types.js';

import type { Oracle, OracleCtx, OracleResult } from './types.js';
import { noOrphanSessions } from './no-orphan-sessions.js';
import { noLiveRevokedScopes } from './no-live-revoked-scopes.js';
import { workersReachTerminal, makeWorkersReachTerminal } from './workers-reach-terminal.js';
import { healthzImpliesLive } from './healthz-implies-live.js';
import { retentionBounds, makeRetentionBounds } from './retention-bounds.js';
import { eventLogConsistency } from './event-log-consistency.js';

export {
  noOrphanSessions,
  noLiveRevokedScopes,
  workersReachTerminal,
  makeWorkersReachTerminal,
  healthzImpliesLive,
  retentionBounds,
  makeRetentionBounds,
  eventLogConsistency,
};

export function defaultOracles(): Oracle[] {
  return [
    noOrphanSessions,
    noLiveRevokedScopes,
    workersReachTerminal,
    healthzImpliesLive,
    retentionBounds,
    eventLogConsistency,
  ];
}

export interface OracleRunSummary {
  passed: number;
  failed: number;
  declined: number;
  durationMs: number;
  results: OracleResult[];
}

export async function runOracles(ctx: OracleCtx, oracles: Oracle[] = defaultOracles()): Promise<OracleRunSummary> {
  const start = Date.now();
  const results: OracleResult[] = [];
  for (const oracle of oracles) {
    // Soak driver runs this every sample window. A bug in one oracle —
    // unexpected SQL throw, JSON.parse crash on a corrupt payload, etc.
    // — must NOT crash the driver and lose the rest of the window's
    // signal. Treat any uncaught throw as `ok: null` with the error
    // captured in `reason`, so triage sees the failure as a declined
    // oracle (not a violation) and the soak keeps running.
    const oracleStart = Date.now();
    try {
      results.push(await oracle(ctx));
    } catch (err) {
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      process.stderr.write(`[bombardment/oracles] ${oracle.name || '<anonymous>'} threw: ${message}\n`);
      results.push({
        name: oracle.name || '<anonymous>',
        ok: null,
        reason: `oracle threw: ${message}`,
        durationMs: Date.now() - oracleStart,
      });
    }
  }
  let passed = 0;
  let failed = 0;
  let declined = 0;
  for (const r of results) {
    if (r.ok === true) passed++;
    else if (r.ok === false) failed++;
    else declined++;
  }
  return { passed, failed, declined, durationMs: Date.now() - start, results };
}
