// v0.6 P3 — reply router.
//
// Translates a verified (notification, action_id) reply into the same underlying
// action a dashboard click would perform. The audit trail is identical to the
// dashboard path: respond_to_decision publishes `decision_response`, trust-scope
// extensions publish `trust_scope_extended`. No bypass, no special-casing.
//
// family-mode-phase-1 Phase 4.6 — this module's `routeDecision` now routes
// through `mayRespond` (src/security/respond-policy.ts) before calling
// `respondToDecision`, exactly like the MCP tool layer and the dashboard
// endpoint do. The HMAC sigil verification stays HERE (the inbound
// pipeline that gates which replies even reach the router); only the
// AUTHORIZATION decision moves into mayRespond — so notify:* is now a
// first-class verified-remote identity, not a parallel store-level
// carve-out.

import type { Broker } from '../broker.js';
import type { TrustStore } from '../trust/store.js';
import { getLogger } from '../log.js';
import { mayRespond } from '../security/respond-policy.js';
import type { NotificationAction } from './types.js';

export type ReplySource = 'webhook' | 'telegram' | 'cli';

export interface RouteOpts {
  notificationId: string;
  notificationCorrelationId: string;
  source: ReplySource;
  /** IP for webhook replies, chat_id for telegram. Used for audit only. */
  sourceLabel: string;
  /** The action_id that came back (e.g. 'decision:yes'). */
  actionId: string;
  /** Notification's full action list (parsed from actions_json). */
  actions: NotificationAction[];
}

export type RouteResult =
  | { ok: true; kind: 'decision'; outcome: 'responded' | 'late' | 'invalid'; decisionId: string; chosenOptionId: string }
  | { ok: true; kind: 'scope_extended'; scopeId: string }
  | { ok: true; kind: 'scope_granted'; scopeId: string }
  | { ok: true; kind: 'scope_rejected'; scopeId: string }
  | { ok: true; kind: 'ignore' }
  | { ok: true; kind: 'link' }
  | { ok: false; error: 'unknown_action' | 'action_not_in_notification' | 'no_target' | 'downstream_failed' | 'wrong_state' };

export class ReplyRouter {
  constructor(
    private readonly broker: Broker,
    private readonly trustStore?: TrustStore,
  ) {}

  async route(opts: RouteOpts): Promise<RouteResult> {
    const action = opts.actions.find((a) => a.action_id === opts.actionId);
    if (!action) return { ok: false, error: 'action_not_in_notification' };

    // Audit always — emit the reply event before the underlying call so a
    // downstream failure still leaves a record that the reply was received.
    await this.publishReplyAudit(opts, action);

    switch (action.kind) {
      case 'approve':
      case 'deny':
      case 'ignore':
        if (opts.actionId.startsWith('decision:')) {
          return this.routeDecision(opts, action);
        }
        if (action.kind === 'ignore') return { ok: true, kind: 'ignore' };
        return { ok: false, error: 'unknown_action' };
      case 'grant_extension':
        return this.routeScopeExtension(opts, action);
      case 'grant_scope':
        return this.routeScopeGrant(opts, action);
      case 'reject_scope':
        return this.routeScopeReject(opts, action);
      case 'link':
        return { ok: true, kind: 'link' };
      default:
        return { ok: false, error: 'unknown_action' };
    }
  }

  // v0.6.X bonus — operator grants a proposed scope from out-of-band reply.
  private async routeScopeGrant(opts: RouteOpts, action: NotificationAction): Promise<RouteResult> {
    const scopeId = action.target_id;
    if (!scopeId) return { ok: false, error: 'no_target' };
    if (!this.trustStore) return { ok: false, error: 'downstream_failed' };
    const existing = this.trustStore.get(scopeId);
    if (!existing) return { ok: false, error: 'no_target' };
    // The notification path uses the same TrustStore.grant() call the
    // dashboard path uses — no notification-specific bypass. If the scope
    // isn't `proposed` (already granted, revoked, expired), grant() is a
    // no-op on status; signal that with wrong_state.
    if (existing.status !== 'proposed') {
      return { ok: false, error: 'wrong_state' };
    }
    try {
      const granted = this.trustStore.grant(scopeId, `notify:${opts.source}`);
      if (!granted) return { ok: false, error: 'downstream_failed' };
      await this.broker.publish({
        kind: 'trust_scope_granted',
        at: new Date().toISOString(),
        correlation_id: scopeId,
        source_agent: `notify:${opts.source}`,
        payload: {
          scope_id: scopeId,
          title: granted.title ?? '',
          granted_by: `notify:${opts.source}`,
          granted_at: granted.granted_at ?? new Date().toISOString(),
          expires_at: granted.expires_at,
        },
      });
      return { ok: true, kind: 'scope_granted', scopeId };
    } catch (err) {
      getLogger().warn('reply-router: scope grant failed', {
        scope_id: scopeId,
        error: (err as Error).message,
      });
      return { ok: false, error: 'downstream_failed' };
    }
  }

  // v0.6.X bonus — operator rejects a proposed scope. There's no dedicated
  // 'rejected' status in TrustStore today; we mark the row revoked and emit
  // a dedicated `trust_scope_rejected` event for audit clarity.
  private async routeScopeReject(opts: RouteOpts, action: NotificationAction): Promise<RouteResult> {
    const scopeId = action.target_id;
    if (!scopeId) return { ok: false, error: 'no_target' };
    if (!this.trustStore) return { ok: false, error: 'downstream_failed' };
    const existing = this.trustStore.get(scopeId);
    if (!existing) return { ok: false, error: 'no_target' };
    if (existing.status !== 'proposed') {
      return { ok: false, error: 'wrong_state' };
    }
    try {
      // Revoke transitions status → revoked, completing the lifecycle.
      // The trust_scope_rejected event below is the operator-relevant
      // audit; the trust_scope_revoked the underlying revoke() emits
      // (if any) is purely technical.
      this.trustStore.revoke(scopeId);
      await this.broker.publish({
        kind: 'trust_scope_rejected',
        at: new Date().toISOString(),
        correlation_id: scopeId,
        source_agent: `notify:${opts.source}`,
        payload: {
          scope_id: scopeId,
          rejected_by: `notify:${opts.source}`,
        },
      });
      return { ok: true, kind: 'scope_rejected', scopeId };
    } catch (err) {
      getLogger().warn('reply-router: scope reject failed', {
        scope_id: scopeId,
        error: (err as Error).message,
      });
      return { ok: false, error: 'downstream_failed' };
    }
  }

  private async routeDecision(opts: RouteOpts, action: NotificationAction): Promise<RouteResult> {
    const decisionId = action.target_id;
    if (!decisionId) return { ok: false, error: 'no_target' };
    const optionId = opts.actionId.slice('decision:'.length);
    const verifiedCaller = `notify:${opts.source}`;

    // Phase 4.6 — mayRespond is the single authority. HMAC verification
    // happens upstream (the inbound pipeline only forwards a verified
    // reply here); this gate enforces the self-approval invariant against
    // a notify channel that somehow tried to answer a decision it had
    // itself opened (theoretical today, defensive in depth).
    const existing = this.broker.store.getDecision(decisionId);
    if (existing) {
      const policy = mayRespond(existing, verifiedCaller);
      if (!policy.ok) {
        await this.broker.publish({
          kind: 'decision_self_approval_rejected',
          at: new Date().toISOString(),
          correlation_id: decisionId,
          source_agent: verifiedCaller,
          payload: {
            error: policy.error,
            attempted_responder: verifiedCaller,
            verified_caller: verifiedCaller,
            decision_source_agent: existing.source_agent,
            decision_tier: existing.tier,
            chosen_option_id: optionId,
            reason: policy.reason,
          },
        });
        getLogger().warn('reply-router: mayRespond refused', {
          decision_id: decisionId,
          chosen: optionId,
          error: policy.error,
        });
        return {
          ok: true,
          kind: 'decision',
          outcome: 'invalid',
          decisionId,
          chosenOptionId: optionId,
        };
      }
    }

    const result = this.broker.store.respondToDecision(
      decisionId,
      optionId,
      `reply via ${opts.source}`,
      verifiedCaller,
    );
    if (!result.ok) {
      const outcome = result.error === 'already_responded' ? 'late' : 'invalid';
      // Late replies still emit decision_late_response so the original
      // dashboard-click path's audit posture is preserved.
      if (result.error === 'already_responded') {
        await this.broker.publish({
          kind: 'decision_late_response',
          at: new Date().toISOString(),
          correlation_id: decisionId,
          source_agent: verifiedCaller,
          payload: {
            chosen_option_id: optionId,
            reason: `reply via ${opts.source}`,
            responder: verifiedCaller,
          },
        });
      }
      getLogger().warn('reply-router: respondToDecision failed', {
        decision_id: decisionId,
        chosen: optionId,
        error: result.error,
      });
      return { ok: true, kind: 'decision', outcome, decisionId, chosenOptionId: optionId };
    }
    await this.broker.publish({
      kind: 'decision_response',
      at: result.result.responded_at,
      correlation_id: decisionId,
      source_agent: `notify:${opts.source}`,
      payload: {
        chosen_option_id: optionId,
        reason: `reply via ${opts.source}`,
        responder: `notify:${opts.source}`,
      },
    });
    return { ok: true, kind: 'decision', outcome: 'responded', decisionId, chosenOptionId: optionId };
  }

  private async routeScopeExtension(opts: RouteOpts, action: NotificationAction): Promise<RouteResult> {
    const scopeId = action.target_id;
    if (!scopeId) return { ok: false, error: 'no_target' };
    if (!this.trustStore) return { ok: false, error: 'downstream_failed' };
    try {
      // Scope-cap is enforced by TrustStore.extendScope (P4 hard rule #4).
      // We rely on its existing checks — no notification-specific bypass.
      // Default extension when operator approves from out-of-band: +1h on
      // expires_at. Operator can override from dashboard for finer-grained control.
      const scope = this.trustStore.get(scopeId);
      if (!scope) return { ok: false, error: 'no_target' };
      const newExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const updated = this.trustStore.extend(scopeId, { expires_at: newExpiry });
      if (!updated) return { ok: false, error: 'downstream_failed' };
      await this.broker.publish({
        kind: 'trust_scope_extended',
        at: new Date().toISOString(),
        correlation_id: scopeId,
        source_agent: `notify:${opts.source}`,
        payload: {
          scope_id: scopeId,
          new_expires_at: newExpiry,
          extended_by: `notify:${opts.source}`,
        },
      });
      return { ok: true, kind: 'scope_extended', scopeId };
    } catch (err) {
      getLogger().warn('reply-router: scope extension failed', {
        scope_id: scopeId,
        error: (err as Error).message,
      });
      return { ok: false, error: 'downstream_failed' };
    }
  }

  private async publishReplyAudit(opts: RouteOpts, action: NotificationAction): Promise<void> {
    try {
      await this.broker.publish({
        kind: 'progress',
        at: new Date().toISOString(),
        correlation_id: opts.notificationCorrelationId.slice(0, 32),
        source_agent: `notify:${opts.source}`,
        payload: {
          stage: 'notification_reply',
          detail: JSON.stringify({
            notification_id: opts.notificationId,
            source: opts.source,
            source_label: opts.sourceLabel,
            action_id: opts.actionId,
            action_kind: action.kind,
            target_id: action.target_id,
          }),
        },
      });
    } catch {
      // Audit failures must not block routing. Logger will pick up any persistence error.
    }
  }
}
