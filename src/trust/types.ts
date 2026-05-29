export interface ActionMatcher {
  tool: string;
  param_constraints?: Record<string, unknown>;
  reason?: string;
}

export type ScopeCadence =
  | 'every-action'
  | 'every-5-actions'
  | 'every-15-min'
  | 'on-completion-only';

export type ScopeChannel = 'chat' | 'event-log' | 'dashboard' | 'slack' | 'email';

export interface ScopeReporting {
  cadence: ScopeCadence;
  channels: ScopeChannel[];
}

export type TrustScopeStatus = 'proposed' | 'active' | 'expired' | 'revoked' | 'completed';

export interface TrustScope {
  id: string;
  title: string;
  description: string;
  granted_by: string;
  granted_at: string;
  expires_at: string;
  expires_after_actions?: number;
  allowed_actions: ActionMatcher[];
  forbidden_actions?: ActionMatcher[];
  reporting: ScopeReporting;
  status: TrustScopeStatus;
  spec_url?: string;
  proposed_at?: string;
  actions_executed: number;
  completed_at?: string;
  // worker-dispatch Phase 4 — grant-scope-aware enforcement on
  // JobOrchestrator.dispatch.
  /**
   * Actor this grant applies to. `undefined` (NULL on disk) means the
   * grant is a global capability — any actor whose dispatch matches the
   * tool+target coverage may use it. Set to a specific actor id (e.g.
   * `'peer:fresh-laptop'`) to bind the grant; mismatch at resolution
   * denies with reason `'grant_not_for_actor'`.
   */
  actor_id?: string;
  /**
   * MCP tool names this grant covers. `undefined` = wildcard `'*'` for
   * back-compat with pre-Phase-4 grants. `[]` = covers NOTHING
   * (fail-closed). Explicit `['*']` membership = wildcard. Otherwise:
   * the requested MCP tool name (e.g. `'job_dispatch'`) must appear
   * literally in the array.
   */
  covered_tools?: string[];
  /**
   * Binding targets this grant covers (see binding-target catalogue in
   * src/jobs/types.ts). Same `undefined`/`[]`/`'*'` semantics as
   * `covered_tools` above.
   */
  covered_targets?: string[];
  /**
   * Dispatch budget remaining for JobOrchestrator.dispatch. `undefined`
   * = unbudgeted / infinite (back-compat). Decremented atomically per
   * successful dispatch via `TrustStore.decrementBudget`. Distinct from
   * `expires_after_actions` (which is the gated-action cap used by
   * trust_scope_grant / github-writes / host_exec) — dispatch-budget
   * and action-cap are independent counters by design.
   */
  budget_remaining?: number;
}

export interface ScopeActionRecord {
  id: string;
  scope_id: string;
  tool_name: string;
  args: unknown;
  result: unknown;
  executed_at: string;
}

export interface ProposeInput {
  title: string;
  description: string;
  allowed_actions: ActionMatcher[];
  forbidden_actions?: ActionMatcher[];
  reporting?: ScopeReporting;
  expires_at?: string;
  expires_after_actions?: number;
  spec_url?: string;
  // worker-dispatch Phase 4 — optional Phase-4 grant fields. All
  // back-compat: omitting them yields a pre-Phase-4-shaped grant that
  // still works for the existing trust_scope_grant / gated-action path.
  actor_id?: string;
  covered_tools?: string[];
  covered_targets?: string[];
  budget_remaining?: number;
}

/**
 * Phase 4 — denial reasons for `TrustStore.resolveGrant` /
 * `TrustStore.decrementBudget`. Surface verbatim on the `grant_denied`
 * audit event so operators / external auditors can correlate denials
 * across the audit log without parsing free-form messages.
 */
export type GrantDenialReason =
  | 'grant_required'        // peer:* actor with no grant_id
  | 'grant_not_found'       // grant_id refers to a non-existent scope
  | 'grant_not_for_actor'   // grant.actor_id set but doesn't match requester
  | 'tool_not_covered'      // grant.covered_tools doesn't include the MCP tool
  | 'target_not_covered'    // grant.covered_targets doesn't include the binding_target
  | 'budget_exhausted'      // grant.budget_remaining = 0 at decrement time
  | 'grant_expired'         // grant.expires_at <= now
  | 'grant_revoked';        // grant.status in {'revoked','expired','completed','proposed'}

/**
 * Result of `TrustStore.resolveGrant` — either a real grant (with its
 * pre-decrement budget snapshot), the synthetic `'sentinel'` shape for
 * operator-shape actors with no covering grant (always covers, never
 * budgeted, never persisted), or a structured denial.
 *
 * The sentinel shape is purely internal — it is never written as
 * `JobRecord.grant_id` and never emits a `grant_consumed` event. It
 * exists so JobOrchestrator's dispatch path has a uniform return type
 * regardless of whether the operator pinned a grant.
 */
export type GrantResolution =
  | { kind: 'real'; grant_id: string; budget_before: number | null; expires_at: string }
  | { kind: 'sentinel' }
  | { kind: 'denied'; reason: GrantDenialReason; grant_id?: string };

/**
 * Result of `TrustStore.decrementBudget` — either an atomic success
 * (budget_after is the post-decrement value, NULL for unbudgeted
 * grants), or a structured failure. Reasons mirror `GrantDenialReason`
 * where applicable so the orchestrator can pass them through to the
 * audit event without translation.
 */
export type BudgetDecrementResult =
  | { ok: true; budget_after: number | null }
  | { ok: false; reason: 'budget_exhausted' | 'grant_expired' | 'grant_revoked' | 'grant_not_found' };
