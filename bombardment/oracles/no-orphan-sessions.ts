/**
 * Oracle: no orphaned broker sessions.
 *
 * After a workload's burst phase has drained, `broker.sessionCount()` must
 * return to baseline. This is the v0.6.x memory-leak signature generalized:
 * the leak existed because stateless POSTs to /mcp retained the
 * McpServer + transport in `broker.subscribers`. The oneshot-mcp-leak
 * regression test catches that specific burst pattern; this oracle
 * runs continuously across every soak workload so we catch the next
 * leak shape on its first appearance.
 *
 * `subscriptionCount()` is also checked — if it grows without bound while
 * `sessionCount()` is stable, that means kind-subscriptions are being
 * registered per session-lifetime instead of cleaned up.
 *
 * Tolerance: baseline + slack (default 2) because the soak's own
 * dashboard fetches may briefly hold an SSE handle.
 */

import type { Oracle, OracleResult } from './types.js';

const SLACK = 2;

export const noOrphanSessions: Oracle = async (ctx) => {
  const start = Date.now();
  if (ctx.kind !== 'in-process') {
    return { name: 'no_orphan_sessions', ok: null, reason: 'requires in-process ctx', durationMs: Date.now() - start };
  }
  const baselineSessions = ctx.baseline?.sessionCount ?? 0;
  const baselineSubs = ctx.baseline?.subscriptionCount ?? 0;
  const currentSessions = ctx.broker.sessionCount();
  const currentSubs = ctx.broker.subscriptionCount();

  const sessionsOk = currentSessions <= baselineSessions + SLACK;
  const subsOk = currentSubs <= baselineSubs + SLACK;
  const ok = sessionsOk && subsOk;

  const result: OracleResult = {
    name: 'no_orphan_sessions',
    ok,
    durationMs: Date.now() - start,
  };
  if (!ok) {
    result.reason = sessionsOk
      ? `subscription leak: ${currentSubs} > baseline ${baselineSubs} + slack ${SLACK}`
      : `session leak: ${currentSessions} > baseline ${baselineSessions} + slack ${SLACK}`;
    result.evidence = {
      baseline_sessions: baselineSessions,
      current_sessions: currentSessions,
      baseline_subscriptions: baselineSubs,
      current_subscriptions: currentSubs,
    };
  }
  return result;
};
