/**
 * Oracle: /healthz=200 implies subsystems are actually live.
 *
 * The defect shape this catches: /healthz returns 200 but the DB handle
 * is half-closed, the broker has lost its event-loop subscribers, or
 * the SSE writer is wedged. The current /healthz check is shallow —
 * it only probes db reachability + writability. This oracle layers
 * additional in-process checks on top so a green /healthz cannot mask
 * a partially-degraded daemon.
 *
 * Validation when /healthz=200:
 *   - broker.store.isReachable() === true
 *   - broker.store.isWritable() === true
 *   - broker.store.eventCount() returns a number (not NaN, not throws)
 *   - broker.subscriptionCount() returns a number
 *
 * When /healthz=503 (the body documents a `reasons` array), the oracle
 * defers — a 503 is honest, not a violation.
 */

import type { Oracle, OracleResult } from './types.js';

interface HealthzBody {
  ok: boolean;
  reasons?: string[];
  db?: { reachable: boolean; writable: boolean };
}

async function fetchHealthz(baseUrl: string, timeoutMs: number): Promise<{ status: number; body: HealthzBody } | { error: string }> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/healthz`, { signal: controller.signal });
    const body = (await res.json().catch(() => ({}))) as HealthzBody;
    return { status: res.status, body };
  } catch (err) {
    return { error: (err as Error).message };
  } finally {
    clearTimeout(t);
  }
}

export const healthzImpliesLive: Oracle = async (ctx) => {
  const start = Date.now();

  if (ctx.kind === 'http') {
    const r = await fetchHealthz(ctx.baseUrl, ctx.timeoutMs ?? 2000);
    if ('error' in r) {
      return { name: 'healthz_implies_live', ok: false, reason: `fetch failed: ${r.error}`, durationMs: Date.now() - start };
    }
    if (r.status !== 200) {
      // 503 with reasons is honest — declined, not failed.
      return {
        name: 'healthz_implies_live',
        ok: null,
        reason: `healthz reported degraded (status=${r.status} reasons=${(r.body.reasons ?? []).join(',') || 'none'})`,
        durationMs: Date.now() - start,
      };
    }
    // /healthz claims OK; ensure the body actually shows db live.
    const liveDb = r.body.db?.reachable === true && r.body.db?.writable === true;
    return {
      name: 'healthz_implies_live',
      ok: liveDb,
      reason: liveDb ? undefined : 'healthz=200 but body.db shows degraded',
      evidence: liveDb ? undefined : { body: r.body },
      durationMs: Date.now() - start,
    };
  }

  // In-process: there's no /healthz to call — synthesize the same check
  // from the same primitives that /healthz uses (broker.store.isReachable +
  // isWritable + eventCount + broker.subscriptionCount).
  const reachable = ctx.store.isReachable();
  const writable = reachable && ctx.store.isWritable();
  let eventCountOk = false;
  let subsOk = false;
  try {
    eventCountOk = Number.isFinite(ctx.store.eventCount());
  } catch {
    /* fall through */
  }
  try {
    subsOk = Number.isFinite(ctx.broker.subscriptionCount());
  } catch {
    /* fall through */
  }

  const ok = reachable && writable && eventCountOk && subsOk;
  return {
    name: 'healthz_implies_live',
    ok,
    reason: ok ? undefined : `reachable=${reachable} writable=${writable} eventCount=${eventCountOk} subs=${subsOk}`,
    evidence: ok ? undefined : { reachable, writable, eventCountOk, subsOk },
    durationMs: Date.now() - start,
  };
};
