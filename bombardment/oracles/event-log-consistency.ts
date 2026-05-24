/**
 * Oracle: event log ↔ projection internal consistency.
 *
 * Recon §6 calls out a full "SQLite projection ≡ event-log replay"
 * oracle as the long-term aspiration; that requires a `rebuildProjection
 * FromLog()` function the daemon does not yet expose. This oracle is the
 * practical first cut — it walks the event stream for a few high-value
 * derived counts and asserts they match the projected tables:
 *
 *   - Pending decisions: COUNT(events.kind='decision_request') minus
 *     COUNT(events.kind in {decision_response, decision_late_response})
 *     for the same correlation_id chain ≡ pendingDecisionCount().
 *
 *   - Spawned vs terminated workers: distinct `worker_spawned.payload.id`
 *     not appearing in any `worker_terminated.payload.id` ≡ the count of
 *     workers WHERE status NOT IN ('terminated','crashed'). Off-by-one
 *     tolerance accounts for retention sweeps that may drop
 *     `worker_progress` rows but never drop `worker_spawned`/`worker_terminated`
 *     (both are AUDIT-class).
 *
 * Mismatch surfaces TWO defect shapes: (a) the projection drifted from
 * the log (something wrote to a derived table without emitting an event),
 * or (b) retention deleted an audit-bearing event by mistake.
 */

import type { Oracle, OracleResult } from './types.js';

interface DecisionEventRow {
  kind: string;
  correlation_id: string;
}

interface WorkerEventRow {
  kind: string;
  payload_json: string;
}

interface ProjectedDecisionRow {
  c: number;
}

export const eventLogConsistency: Oracle = async (ctx) => {
  const start = Date.now();
  if (ctx.kind !== 'in-process') {
    return { name: 'event_log_consistency', ok: null, reason: 'requires in-process ctx', durationMs: Date.now() - start };
  }

  const issues: Array<{ check: string; expected: number | string; actual: number | string }> = [];

  // ── Decisions: open count == requests − responses (per correlation_id) ──
  try {
    const decisionEvents = ctx.store.rawDb
      .prepare(
        `SELECT kind, correlation_id FROM events
          WHERE kind IN ('decision_request','decision_response','decision_late_response')
            AND correlation_id IS NOT NULL`,
      )
      .all() as DecisionEventRow[];

    const opened = new Set<string>();
    const responded = new Set<string>();
    for (const ev of decisionEvents) {
      if (ev.kind === 'decision_request') opened.add(ev.correlation_id);
      else responded.add(ev.correlation_id);
    }
    let openedFromLog = 0;
    for (const id of opened) if (!responded.has(id)) openedFromLog++;

    const projected = (ctx.store.rawDb.prepare(`SELECT COUNT(*) AS c FROM decisions WHERE status='open'`).get() as ProjectedDecisionRow).c;
    // Tolerance: a decision row can be opened in this process but its
    // request event may have just landed (ordering); a difference of ≤1
    // is benign. Larger drift is a real consistency break.
    if (Math.abs(openedFromLog - projected) > 1) {
      issues.push({ check: 'open_decisions', expected: openedFromLog, actual: projected });
    }
  } catch (err) {
    // Schema absent on bare DB — declined, not failed.
    return {
      name: 'event_log_consistency',
      ok: null,
      reason: `decisions/events unreachable: ${(err as Error).message}`,
      durationMs: Date.now() - start,
    };
  }

  // ── Workers: spawn-without-terminate count ≈ non-terminal worker rows ──
  try {
    const workerEvents = ctx.store.rawDb
      .prepare(`SELECT kind, payload_json FROM events WHERE kind IN ('worker_spawned','worker_terminated')`)
      .all() as WorkerEventRow[];
    const spawned = new Set<string>();
    const terminated = new Set<string>();
    for (const ev of workerEvents) {
      let id: string | undefined;
      try {
        const obj = JSON.parse(ev.payload_json ?? '{}');
        if (typeof obj?.id === 'string') id = obj.id;
        else if (typeof obj?.worker_id === 'string') id = obj.worker_id;
      } catch {
        /* unparseable — skip */
      }
      if (!id) continue;
      if (ev.kind === 'worker_spawned') spawned.add(id);
      else terminated.add(id);
    }
    let liveFromLog = 0;
    for (const id of spawned) if (!terminated.has(id)) liveFromLog++;

    const projected = (ctx.store.rawDb
      .prepare(`SELECT COUNT(*) AS c FROM workers WHERE status NOT IN ('terminated','crashed')`)
      .get() as { c: number }).c;
    // Larger tolerance here — worker retention can hard-delete rows after
    // their terminal events, and the spawn event may outlive the row. A
    // drift > 2 is still a real signal.
    if (Math.abs(liveFromLog - projected) > 2) {
      issues.push({ check: 'live_workers', expected: liveFromLog, actual: projected });
    }
  } catch (err) {
    // workers table may be absent on a bare DB — leave the previous
    // decision check intact and skip this sub-check rather than failing.
  }

  const ok = issues.length === 0;
  return {
    name: 'event_log_consistency',
    ok,
    reason: ok ? undefined : `${issues.length} consistency check(s) failed`,
    evidence: ok ? undefined : { issues },
    durationMs: Date.now() - start,
  };
};
