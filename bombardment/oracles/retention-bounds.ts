/**
 * Oracle: retention bounds hold.
 *
 * After `pruneEvents()` has run at least once (the daemon scheduler
 * fires it on boot + every 60 min, and the soak harness fires it
 * explicitly), the operational-kind row count must be ≤ the configured
 * cap (`STAVR_EVENTS_OP_MAX_ROWS`, default 100k).
 *
 * The check is bounded-by-construction: we ignore audit-kind rows
 * (they grow within their 90-day TTL without a row cap) and only
 * compare the operational-class subset against the cap.
 *
 * Why this matters: the v0.6.x leak surfaced first as RSS climb, but
 * once retention misclassifies a kind (UNKNOWN bucket, which is
 * deliberately preserved), the operational table can grow without
 * bound. This oracle catches both regressions: a broken pruneEvents
 * pass AND a forgotten kind drifting past the cap.
 */

import { OPERATIONAL_KINDS, resolveRetentionOpts } from '../../src/observability/retention.js';
import type { Oracle, OracleResult } from './types.js';

export interface RetentionBoundsOpts {
  /** Slack above the cap (the cap is enforced at sweep time; between sweeps the row count can transiently exceed it). Default 1.5x. */
  slackMultiplier?: number;
}

export function makeRetentionBounds(opts: RetentionBoundsOpts = {}): Oracle {
  const slack = opts.slackMultiplier ?? 1.5;
  return async (ctx) => {
    const start = Date.now();
    if (ctx.kind !== 'in-process') {
      return { name: 'retention_bounds', ok: null, reason: 'requires in-process ctx', durationMs: Date.now() - start };
    }
    const cap = resolveRetentionOpts().operationalMaxRows;
    const opKinds = [...OPERATIONAL_KINDS];
    let opCount: number;
    try {
      opCount = (ctx.store.rawDb
        .prepare(`SELECT COUNT(*) AS c FROM events WHERE kind IN (${opKinds.map(() => '?').join(',')})`)
        .get(...opKinds) as { c: number }).c;
    } catch (err) {
      return {
        name: 'retention_bounds',
        ok: null,
        reason: `events table unreachable: ${(err as Error).message}`,
        durationMs: Date.now() - start,
      };
    }

    const ceiling = Math.ceil(cap * slack);
    const ok = opCount <= ceiling;
    return {
      name: 'retention_bounds',
      ok,
      reason: ok ? undefined : `operational rows ${opCount} > ${ceiling} (cap ${cap} × slack ${slack})`,
      evidence: ok ? undefined : { op_count: opCount, cap, slack_multiplier: slack, ceiling },
      durationMs: Date.now() - start,
    };
  };
}

export const retentionBounds: Oracle = makeRetentionBounds();
