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
    case 'trust_scope_proposed':
      // v0.6.X bonus — operator sees scope proposals on the same channels
      // as decisions. Without this, every cowork-claude / steward scope
      // proposal forced the operator to open the dashboard.
      await emitScopeProposed(ev, notifier, opts);
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
    case 'worker_dispatch_failed':
      await emitWorkerDispatchFailed(ev, notifier, opts);
      break;
    case 'host_exec_denied':
      await emitHostExecDenied(ev, notifier, opts);
      break;
    case 'cc_quota_warning':
      await emitCcQuotaWarning(ev, notifier, opts);
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

// v0.6.X bonus — extended outbound coverage emitters.

async function emitScopeProposed(ev: StoredEvent, notifier: Notifier, opts: WiringOpts): Promise<void> {
  const p = ev.payload as { scope_id?: string; title?: string; description?: string };
  if (!p?.scope_id) return;
  const actions: NotificationAction[] = [
    { label: 'Grant', action_id: 'scope:grant', kind: 'grant_scope', target_id: p.scope_id },
    { label: 'Reject', action_id: 'scope:reject', kind: 'reject_scope', target_id: p.scope_id },
  ];
  if (opts.dashboardBaseUrl) {
    actions.push({
      label: 'Open dashboard',
      action_id: 'open:dashboard',
      kind: 'link',
      url: `${opts.dashboardBaseUrl}/dashboard/topology?scope=${encodeURIComponent(p.scope_id)}`,
    });
  }
  const body = p.description?.trim()
    ? `${p.title ?? 'Trust scope'}: ${p.description}`
    : (p.title ?? `Trust scope ${p.scope_id}`);
  await notifier.notify({
    kind: 'scope_proposed',
    severity: 'warn',
    title: 'Trust scope proposed',
    body,
    actions,
    sourceEventId: ev.id,
  });
}

async function emitHostExecDenied(ev: StoredEvent, notifier: Notifier, opts: WiringOpts): Promise<void> {
  const p = ev.payload as { command?: string; reason?: string; actor?: string };
  // Per BOM: no remediation button — just a link to the audit. Operator
  // investigates from the dashboard if needed.
  const actions: NotificationAction[] = [];
  if (opts.dashboardBaseUrl) {
    actions.push({
      label: 'View audit',
      action_id: 'open:audit',
      kind: 'link',
      url: `${opts.dashboardBaseUrl}/dashboard/streams?kind=host_exec_denied`,
    });
  }
  const actor = p?.actor ? `[${p.actor}] ` : '';
  const cmd = p?.command ? p.command.slice(0, 80) : 'unknown command';
  const reason = p?.reason ? ` — ${p.reason}` : '';
  await notifier.notify({
    kind: 'host_exec_denied',
    severity: 'warn',
    title: 'host_exec blocked by policy',
    body: `${actor}${cmd}${reason}`,
    actions,
    sourceEventId: ev.id,
  });
}

async function emitWorkerDispatchFailed(ev: StoredEvent, notifier: Notifier, opts: WiringOpts): Promise<void> {
  const p = ev.payload as { target_worker_id?: string; name?: string; reason?: string; detail?: string };
  if (!p?.target_worker_id) return;
  const actions: NotificationAction[] = [];
  if (opts.dashboardBaseUrl) {
    actions.push({
      label: 'View logs',
      action_id: 'open:logs',
      kind: 'link',
      url: `${opts.dashboardBaseUrl}/dashboard/workers/${encodeURIComponent(p.target_worker_id)}`,
    });
  }
  const namePart = p.name ? `${p.name} (${p.target_worker_id})` : p.target_worker_id;
  const reasonPart = p.reason ? `: ${p.reason}` : '';
  const detailPart = p.detail ? ` — ${p.detail.slice(0, 80)}` : '';
  await notifier.notify({
    kind: 'worker_dispatch_failed',
    severity: 'crit',
    title: 'Worker dispatch failed',
    body: `${namePart}${reasonPart}${detailPart}`,
    actions,
    sourceEventId: ev.id,
  });
}

async function emitCcQuotaWarning(ev: StoredEvent, notifier: Notifier, opts: WiringOpts): Promise<void> {
  const p = ev.payload as { percent?: number; remaining?: number; resets_at?: string; detail?: string };
  const pct = typeof p?.percent === 'number' ? p.percent : 0;
  const actions: NotificationAction[] = [];
  if (opts.dashboardBaseUrl) {
    actions.push({
      label: 'View status',
      action_id: 'open:status',
      kind: 'link',
      url: `${opts.dashboardBaseUrl}/dashboard/helm`,
    });
  }
  const resetsPart = p?.resets_at ? ` · resets ${p.resets_at}` : '';
  const remainingPart = typeof p?.remaining === 'number' ? ` · ${p.remaining} calls left` : '';
  await notifier.notify({
    kind: 'cc_quota_warning',
    severity: pct >= 95 ? 'crit' : 'warn',
    title: `CC quota at ${pct}%`,
    body: `${p?.detail ?? 'Claude Code quota threshold hit'}${remainingPart}${resetsPart}`,
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
