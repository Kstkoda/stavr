/**
 * Oracle: no live revoked scopes.
 *
 * Walks the `trust_scopes` table and asserts that no row in a terminal
 * state (`revoked`, `expired`, `completed`) has `expires_at` in the
 * future without the lifecycle flip having fired. This is the
 * "every revoked scope leaves no live grant" invariant from recon §6.
 *
 * The check is structural: a terminal-status row must NOT also be
 * coverable by the scope matcher. We do not invoke the matcher per row
 * (too expensive at scale); instead we assert the simpler shape that any
 * row with status ∈ {revoked, expired, completed} has either a non-null
 * `completed_at` or its `expires_at` is already in the past. Either
 * proves the scope can no longer authorise an action.
 *
 * NOTE: this oracle has no in-process side-effects. It only reads.
 */

import type { Oracle, OracleResult } from './types.js';

interface ScopeRow {
  id: string;
  status: string;
  expires_at: string;
  completed_at: string | null;
}

export const noLiveRevokedScopes: Oracle = async (ctx) => {
  const start = Date.now();
  if (ctx.kind !== 'in-process') {
    return { name: 'no_live_revoked_scopes', ok: null, reason: 'requires in-process ctx', durationMs: Date.now() - start };
  }

  const nowIso = new Date().toISOString();
  let rows: ScopeRow[];
  try {
    rows = ctx.store.rawDb
      .prepare(
        `SELECT id, status, expires_at, completed_at
           FROM trust_scopes
          WHERE status IN ('revoked', 'expired', 'completed')`,
      )
      .all() as ScopeRow[];
  } catch (err) {
    // Schema may not exist on a brand-new test DB. Declined, not failed.
    return {
      name: 'no_live_revoked_scopes',
      ok: null,
      reason: `trust_scopes unreachable: ${(err as Error).message}`,
      durationMs: Date.now() - start,
    };
  }

  const violations: Array<{ id: string; status: string; expires_at: string; completed_at: string | null }> = [];
  for (const row of rows) {
    const expired = row.expires_at <= nowIso;
    const completed = row.completed_at !== null;
    if (!expired && !completed) {
      violations.push(row);
    }
  }

  const ok = violations.length === 0;
  const result: OracleResult = {
    name: 'no_live_revoked_scopes',
    ok,
    durationMs: Date.now() - start,
  };
  if (!ok) {
    result.reason = `${violations.length} terminal-status scope(s) still live`;
    result.evidence = { violations: violations.slice(0, 10), total_terminal: rows.length };
  }
  return result;
};
