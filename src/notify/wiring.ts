// v0.6 P2 — emit-hook wiring.
//
// Rather than editing every event-emitting site, we subscribe to the broker's
// internal fanout and translate selected event kinds into notifications. This
// keeps the notifier orthogonal to existing code paths (BOM rule: minimize
// surface area in P2).
//
// Mappings:
//   decision_request          → kind=decision_required (with approve/deny/ignore actions)
//   trust_scope_revoked       → kind=scope_expired
//   trust_scope_completed     → kind=scope_expired (severity=info — expected end-of-life)
//   worker_terminated         → kind=work_complete (filtered: notify_on_complete metadata flag)
//
// The watchdog feed is handled by `notifyHealthState()` because watchdog
// transitions aren't published as broker events today.

import type { Broker } from '../broker.js';
import type { StoredEvent } from '../persistence.js';
import { getLogger } from '../log.js';
import type { Notifier } from './notifier.js';
import type { NotificationAction, NotificationSeverity } from './types.js';

export interface WiringOpts {
  /** Base URL the daemon serves /notify/reply on (built into reply links). */
  dashboardBaseUrl?: string;
}

export function wireNotifications(broker: Broker, notifier: Notifier, opts: WiringOpts = {}): () => void {
  const off = broker.onEvent((ev) => {
    void handleEvent(ev, notifier, opts).catch((err) => {
      getLogger().warn('notify wiring: handler threw', {
        kind: ev.kind,
        error: (err as Error).message,
      });
    });
  });
  return off;
}

async function handleEvent(ev: StoredEvent, notifier: Notifier, opts: WiringOpts): Promise<void> {
  switch (ev.kind) {
    case 'decision_request':
      await emitDecisionRequired(ev, notifier, opts);
      break;
    case 'trust_scope_revoked':
      await emitScopeEnded(ev, notifier, 'warn', 'Trust scope revoked');
      break;
    case 'trust_scope_completed':
      await emitScopeEnded(ev, notifier, 'info', 'Trust scope completed');
      break;
    case 'worker_terminated':
      await emitWorkComplete(ev, notifier, opts);
      break;
    default:
      break;
  }
}

async function emitDecisionRequired(ev: StoredEvent, notifier: Notifier, opts: WiringOpts): Promise<void> {
  const payload = ev.payload as {
    question?: string;
    options?: Array<{ id: string; label: string }>;
    default_option_id?: string;
    deadline_seconds?: number;
  };
  if (!payload?.question || !ev.correlation_id) return;
  const actions: NotificationAction[] = [];
  const opts2 = payload.options ?? [];
  // Build approve/deny semantics from the offered options. Many decisions
  // are binary (approve/deny), some are pick-one. We expose up to 4 buttons
  // and rely on the reply-router to call respond_to_decision with the picked id.
  for (const opt of opts2.slice(0, 4)) {
    const lc = opt.label.toLowerCase();
    const kind = lc.includes('approve') || lc.includes('allow') || lc.includes('grant') || lc === 'yes'
      ? 'approve'
      : lc.includes('deny') || lc.includes('block') || lc === 'no'
        ? 'deny'
        : 'ignore';
    actions.push({
      label: opt.label,
      action_id: `decision:${opt.id}`,
      kind,
      target_id: ev.correlation_id,
    });
  }
  if (opts.dashboardBaseUrl) {
    actions.push({
      label: 'Open dashboard',
      action_id: 'open:dashboard',
      kind: 'link',
      url: `${opts.dashboardBaseUrl}/dashboard/decide`,
    });
  }
  const timeout = payload.deadline_seconds ?? 300;
  await notifier.notify({
    kind: 'decision_required',
    severity: 'warn',
    title: 'Decision required',
    body: payload.question,
    actions,
    sourceEventId: ev.id,
    ttlMs: Math.min(timeout * 1000, 30 * 60 * 1000),
  });
}

async function emitScopeEnded(
  ev: StoredEvent,
  notifier: Notifier,
  severity: NotificationSeverity,
  title: string,
): Promise<void> {
  const p = ev.payload as { scope_id?: string; reason?: string };
  if (!p?.scope_id) return;
  await notifier.notify({
    kind: 'scope_expired',
    severity,
    title,
    body: `Scope ${p.scope_id}${p.reason ? `: ${p.reason}` : ''}`,
    sourceEventId: ev.id,
  });
}

async function emitWorkComplete(ev: StoredEvent, notifier: Notifier, opts: WiringOpts): Promise<void> {
  const p = ev.payload as { id?: string; reason?: string };
  if (!p?.id) return;
  // Filter: notify_on_complete metadata flag on the originating worker record.
  // Today we don't have access to the worker row here; for v0.6 we conservatively
  // only notify on `terminated_by_user` or `crashed` (operator-relevant) and skip
  // routine `completed`. The digest captures all completions for the morning summary.
  if (p.reason === 'completed') return;
  const severity: NotificationSeverity = p.reason === 'crashed' ? 'warn' : 'info';
  const actions: NotificationAction[] = [];
  if (opts.dashboardBaseUrl) {
    actions.push({
      label: 'View worker',
      action_id: 'open:worker',
      kind: 'link',
      url: `${opts.dashboardBaseUrl}/dashboard/workers/${p.id}`,
    });
  }
  await notifier.notify({
    kind: 'work_complete',
    severity,
    title: `Worker ${p.reason}`,
    body: `Worker ${p.id} ${p.reason}`,
    actions,
    sourceEventId: ev.id,
  });
}

/**
 * Direct hook for the watchdog → notifier path. Called from the daemon when
 * health state transitions to warn or crit. info transitions (back to healthy)
 * are not pushed live — the digest captures them.
 */
export async function notifyHealthState(
  notifier: Notifier,
  state: { severity: NotificationSeverity; reason: string; details?: string },
): Promise<void> {
  if (state.severity === 'info') return;
  await notifier.notify({
    kind: 'health_alert',
    severity: state.severity,
    title: `Health: ${state.reason}`,
    body: state.details ?? state.reason,
  });
}
