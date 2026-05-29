import { randomUUID } from 'node:crypto';
import type { Database } from '../db/index.js';
import type { EventStore } from '../persistence.js';
import { scopeCovers } from './matcher.js';
import type {
  ActionMatcher,
  BudgetDecrementResult,
  GrantResolution,
  ProposeInput,
  ScopeActionRecord,
  ScopeReporting,
  TrustScope,
  TrustScopeStatus,
} from './types.js';

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_REPORTING: ScopeReporting = {
  cadence: 'every-5-actions',
  channels: ['chat', 'event-log'],
};

interface TrustScopeRow {
  id: string;
  title: string;
  description: string;
  granted_by: string;
  granted_at: string;
  expires_at: string;
  expires_after_actions: number | null;
  allowed_actions_json: string;
  forbidden_actions_json: string | null;
  reporting_json: string;
  status: string;
  spec_url: string | null;
  proposed_at: string | null;
  actions_executed: number;
  completed_at: string | null;
  // worker-dispatch Phase 4 — additive columns (all nullable).
  actor_id: string | null;
  covered_tools_json: string | null;
  covered_targets_json: string | null;
  budget_remaining: number | null;
}

interface ScopeActionRow {
  id: string;
  scope_id: string;
  tool_name: string;
  args_json: string;
  result_json: string | null;
  executed_at: string;
}

export interface RecordedScopeAction {
  scope: TrustScope;
  reachedCap: boolean;
  expiredByTime: boolean;
}

export class TrustStore {
  private readonly db: Database;

  constructor(eventStore: EventStore) {
    this.db = eventStore.rawDb;
  }

  createProposal(input: ProposeInput): TrustScope {
    const id = `ts-${randomUUID()}`;
    const now = new Date();
    const expiresAt = input.expires_at ?? new Date(now.getTime() + DEFAULT_TTL_MS).toISOString();
    const reporting = input.reporting ?? DEFAULT_REPORTING;
    this.db
      .prepare(
        `INSERT INTO trust_scopes
          (id, title, description, granted_by, granted_at, expires_at,
           expires_after_actions, allowed_actions_json, forbidden_actions_json,
           reporting_json, status, spec_url, proposed_at, actions_executed, completed_at,
           actor_id, covered_tools_json, covered_targets_json, budget_remaining)
         VALUES (?, ?, ?, '', '', ?, ?, ?, ?, ?, 'proposed', ?, ?, 0, NULL, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.title,
        input.description,
        expiresAt,
        input.expires_after_actions ?? null,
        JSON.stringify(input.allowed_actions),
        input.forbidden_actions ? JSON.stringify(input.forbidden_actions) : null,
        JSON.stringify(reporting),
        input.spec_url ?? null,
        now.toISOString(),
        // worker-dispatch Phase 4 fields — all nullable for back-compat.
        input.actor_id ?? null,
        input.covered_tools !== undefined ? JSON.stringify(input.covered_tools) : null,
        input.covered_targets !== undefined ? JSON.stringify(input.covered_targets) : null,
        input.budget_remaining ?? null,
      );
    return this.get(id)!;
  }

  grant(id: string, grantedBy: string): TrustScope | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    if (existing.status !== 'proposed') return existing;
    const grantedAt = new Date();
    // If the proposed expires_at was relative to proposal time and has now passed,
    // bump it so the scope has at least its declared lifetime from grant moment.
    const proposedExpiry = new Date(existing.expires_at);
    let expiresAt = existing.expires_at;
    if (proposedExpiry.getTime() <= grantedAt.getTime()) {
      expiresAt = new Date(grantedAt.getTime() + DEFAULT_TTL_MS).toISOString();
    }
    this.db
      .prepare(
        `UPDATE trust_scopes SET status='active', granted_by=?, granted_at=?, expires_at=? WHERE id=?`,
      )
      .run(grantedBy, grantedAt.toISOString(), expiresAt, id);
    return this.get(id);
  }

  revoke(id: string): TrustScope | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    if (existing.status === 'revoked' || existing.status === 'completed' || existing.status === 'expired') {
      return existing;
    }
    const at = new Date().toISOString();
    this.db
      .prepare(`UPDATE trust_scopes SET status='revoked', completed_at=? WHERE id=?`)
      .run(at, id);
    return this.get(id);
  }

  extend(
    id: string,
    opts: { expires_at?: string; expires_after_actions?: number },
  ): TrustScope | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    if (existing.status !== 'active') return existing;
    const newExpiresAt = opts.expires_at ?? existing.expires_at;
    const newCap =
      opts.expires_after_actions !== undefined
        ? opts.expires_after_actions
        : existing.expires_after_actions ?? null;
    this.db
      .prepare(`UPDATE trust_scopes SET expires_at=?, expires_after_actions=? WHERE id=?`)
      .run(newExpiresAt, newCap, id);
    return this.get(id);
  }

  get(id: string): TrustScope | undefined {
    const row = this.db.prepare(`SELECT * FROM trust_scopes WHERE id=?`).get(id) as
      | TrustScopeRow
      | undefined;
    return row ? rowToScope(row) : undefined;
  }

  list(filter?: { status?: TrustScopeStatus }): TrustScope[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter?.status) {
      where.push(`status=?`);
      params.push(filter.status);
    }
    const sql = `SELECT * FROM trust_scopes ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY proposed_at DESC`;
    const rows = this.db.prepare(sql).all(...params) as TrustScopeRow[];
    return rows.map(rowToScope);
  }

  listActions(scopeId: string): ScopeActionRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM scope_actions WHERE scope_id=? ORDER BY executed_at ASC`)
      .all(scopeId) as ScopeActionRow[];
    return rows.map((r) => ({
      id: r.id,
      scope_id: r.scope_id,
      tool_name: r.tool_name,
      args: JSON.parse(r.args_json),
      result: r.result_json ? JSON.parse(r.result_json) : null,
      executed_at: r.executed_at,
    }));
  }

  /**
   * Look up an active scope that covers (tool, args) RIGHT NOW. Lazily transitions
   * time-expired or cap-exhausted scopes to 'expired'/'completed' as a side effect.
   */
  findActiveScopeFor(args: { tool: string; args: unknown }, now: Date = new Date()): TrustScope | undefined {
    const rows = this.db
      .prepare(`SELECT * FROM trust_scopes WHERE status='active' ORDER BY granted_at ASC`)
      .all() as TrustScopeRow[];
    for (const row of rows) {
      const scope = rowToScope(row);
      if (this.isExpired(scope, now)) {
        this.markExpired(scope.id, now);
        continue;
      }
      if (scope.expires_after_actions !== undefined && scope.actions_executed >= scope.expires_after_actions) {
        this.markCompleted(scope.id, now);
        continue;
      }
      if (scopeCovers(scope, args.tool, args.args)) {
        return scope;
      }
    }
    return undefined;
  }

  isExpired(scope: TrustScope, now: Date = new Date()): boolean {
    return new Date(scope.expires_at).getTime() <= now.getTime();
  }

  markExpired(id: string, now: Date = new Date()): TrustScope | undefined {
    this.db
      .prepare(`UPDATE trust_scopes SET status='expired', completed_at=? WHERE id=? AND status='active'`)
      .run(now.toISOString(), id);
    return this.get(id);
  }

  markCompleted(id: string, now: Date = new Date()): TrustScope | undefined {
    this.db
      .prepare(`UPDATE trust_scopes SET status='completed', completed_at=? WHERE id=? AND status='active'`)
      .run(now.toISOString(), id);
    return this.get(id);
  }

  recordScopeAction(
    scopeId: string,
    toolName: string,
    args: unknown,
    result: unknown,
  ): RecordedScopeAction | undefined {
    const scope = this.get(scopeId);
    if (!scope) return undefined;
    const actionId = randomUUID();
    const executedAt = new Date().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO scope_actions (id, scope_id, tool_name, args_json, result_json, executed_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          actionId,
          scopeId,
          toolName,
          JSON.stringify(args),
          result === undefined ? null : JSON.stringify(result),
          executedAt,
        );
      this.db
        .prepare(`UPDATE trust_scopes SET actions_executed = actions_executed + 1 WHERE id=?`)
        .run(scopeId);
    })();
    const updated = this.get(scopeId)!;
    let reachedCap = false;
    if (
      updated.expires_after_actions !== undefined &&
      updated.actions_executed >= updated.expires_after_actions &&
      updated.status === 'active'
    ) {
      this.markCompleted(scopeId);
      reachedCap = true;
    }
    const finalScope = this.get(scopeId)!;
    return { scope: finalScope, reachedCap, expiredByTime: false };
  }

  /**
   * worker-dispatch Phase 4 — resolve a grant for a JobOrchestrator.dispatch
   * call. Implements the locked composition (operator 10-3-1, 2026-05-29):
   *
   *   - For peer:* actors, explicit grant_id is REQUIRED. Missing → caller
   *     should treat as `grant_required`; we do not auto-resolve for peers.
   *   - For operator-shape actors, auto-resolve the most-permissive active
   *     grant covering (tool, target). If none matches, return the synthetic
   *     `'sentinel'` shape (always covers, never budgeted, NEVER persisted).
   *   - Coverage is two-tier set membership: `covered_tools` must include
   *     the MCP tool name AND `covered_targets` must include the binding
   *     target. Wildcard `'*'` membership matches anything; `undefined`
   *     covered_* (NULL on disk) means "no Phase-4 constraint" and matches
   *     too (back-compat for pre-Phase-4 grants).
   *   - Actor binding: grant.actor_id, when set, must match the requester.
   *     Mismatch → `grant_not_for_actor` denial.
   *   - Wall-clock expiry + status check applied; expired grants lazy-
   *     promote via `markExpired` (same pattern as findActiveScopeFor).
   *
   * The CALLER (JobOrchestrator) is responsible for the budget decrement
   * after this returns `kind: 'real'` — that's a separate atomic op via
   * decrementBudget so the orchestrator can wedge it between admission
   * pipeline stages without holding a DB transaction across binding code.
   */
  resolveGrant(args: {
    actor_id: string;
    tool: string;
    binding_target: string;
    grant_id?: string;
    now?: Date;
  }): GrantResolution {
    const now = args.now ?? new Date();
    const isOperatorShape = isOperatorShapeActor(args.actor_id);

    // Peer:* always needs an explicit grant_id. No fallback, no auto-resolve.
    if (!isOperatorShape && !args.grant_id) {
      return { kind: 'denied', reason: 'grant_required' };
    }

    if (args.grant_id) {
      // Explicit grant_id path — peer:* OR operator pinned a specific grant.
      const scope = this.get(args.grant_id);
      if (!scope) return { kind: 'denied', reason: 'grant_not_found', grant_id: args.grant_id };
      const denial = denyIfNotUsable(scope, args.actor_id, args.tool, args.binding_target, now);
      if (denial) {
        // Lazy-promote a time-expired grant to status='expired' so subsequent
        // queries see the right state (mirrors findActiveScopeFor's pattern).
        if (denial === 'grant_expired' && scope.status === 'active') {
          this.markExpired(scope.id, now);
        }
        return { kind: 'denied', reason: denial, grant_id: args.grant_id };
      }
      return {
        kind: 'real',
        grant_id: scope.id,
        budget_before: scope.budget_remaining ?? null,
        expires_at: scope.expires_at,
      };
    }

    // Operator-shape auto-resolve. Walk active grants in granted_at order,
    // pick the first one that covers + matches actor binding. "Most
    // permissive" reduces to "first match" here because coverage is set
    // membership, not range-comparable.
    const rows = this.db
      .prepare(
        `SELECT * FROM trust_scopes
          WHERE status='active'
            AND (actor_id IS NULL OR actor_id = ?)
          ORDER BY granted_at ASC`,
      )
      .all(args.actor_id) as TrustScopeRow[];
    for (const row of rows) {
      const scope = rowToScope(row);
      // Lazy expiry promotion (same as findActiveScopeFor).
      if (this.isExpired(scope, now)) {
        this.markExpired(scope.id, now);
        continue;
      }
      // Coverage check — both sides must pass.
      if (!toolIsCovered(scope, args.tool)) continue;
      if (!targetIsCovered(scope, args.binding_target)) continue;
      // Found one. Budget check is deferred to decrementBudget; resolveGrant
      // surfaces budget_before so the orchestrator's audit payload can carry
      // it on grant_consumed without a second read.
      return {
        kind: 'real',
        grant_id: scope.id,
        budget_before: scope.budget_remaining ?? null,
        expires_at: scope.expires_at,
      };
    }
    // No covering grant found for this operator — return the internal
    // sentinel. JobOrchestrator interprets this as "operator's local hot
    // path; allow without persisting a grant_id and without emitting a
    // grant_consumed event."
    return { kind: 'sentinel' };
  }

  /**
   * worker-dispatch Phase 4 — atomic budget decrement. Wraps the
   * SELECT-and-UPDATE in a better-sqlite3 transaction so two concurrent
   * decrement calls on a grant with budget=1 cannot both succeed.
   *
   * Unbudgeted grants (budget_remaining IS NULL — back-compat for pre-
   * Phase-4 grants and operator-set unbudgeted grants) always succeed
   * with `budget_after: null`.
   *
   * Re-checks status + expiry inside the transaction so a grant that gets
   * revoked or expires between resolveGrant and decrementBudget surfaces
   * the right structured reason. JobOrchestrator's audit payload carries
   * the reason verbatim onto the `grant_denied` event.
   */
  decrementBudget(grantId: string, now: Date = new Date()): BudgetDecrementResult {
    const nowIso = now.toISOString();
    let result: BudgetDecrementResult = { ok: false, reason: 'grant_not_found' };
    this.db.transaction(() => {
      const row = this.db
        .prepare(`SELECT * FROM trust_scopes WHERE id=?`)
        .get(grantId) as TrustScopeRow | undefined;
      if (!row) {
        result = { ok: false, reason: 'grant_not_found' };
        return;
      }
      // Expired by wall-clock during the transaction window — lazy-promote
      // and surface the reason.
      if (row.status === 'active' && row.expires_at <= nowIso) {
        this.db
          .prepare(`UPDATE trust_scopes SET status='expired', completed_at=? WHERE id=?`)
          .run(nowIso, grantId);
        result = { ok: false, reason: 'grant_expired' };
        return;
      }
      if (row.status !== 'active') {
        // Revoked / completed / proposed — all surface as grant_revoked
        // for the purposes of the audit event (the operator-facing
        // semantic is "this grant is not consumable right now").
        result = { ok: false, reason: 'grant_revoked' };
        return;
      }
      if (row.budget_remaining === null) {
        // Unbudgeted grant — succeeds without a decrement write.
        result = { ok: true, budget_after: null };
        return;
      }
      if (row.budget_remaining <= 0) {
        result = { ok: false, reason: 'budget_exhausted' };
        return;
      }
      const next = row.budget_remaining - 1;
      this.db
        .prepare(`UPDATE trust_scopes SET budget_remaining=? WHERE id=?`)
        .run(next, grantId);
      result = { ok: true, budget_after: next };
    })();
    return result;
  }

  /**
   * Sweep all active scopes whose wall-clock expiry has passed. Returns the ones flipped to 'expired'.
   */
  sweepExpired(now: Date = new Date()): TrustScope[] {
    const rows = this.db
      .prepare(`SELECT * FROM trust_scopes WHERE status='active' AND expires_at < ?`)
      .all(now.toISOString()) as TrustScopeRow[];
    const out: TrustScope[] = [];
    for (const r of rows) {
      const updated = this.markExpired(r.id, now);
      if (updated) out.push(updated);
    }
    return out;
  }
}

/**
 * worker-dispatch Phase 4 — coverage check for `covered_tools`. The
 * back-compat semantic is documented on `TrustScope.covered_tools`:
 * `undefined` (NULL on disk) = wildcard; `[]` = covers nothing
 * (fail-closed); explicit `'*'` membership = wildcard; otherwise the
 * tool name must appear literally in the array.
 */
function toolIsCovered(scope: TrustScope, tool: string): boolean {
  const list = scope.covered_tools;
  if (list === undefined) return true; // pre-Phase-4 grant; no constraint
  // Empty array is the explicit fail-closed sentinel.
  if (list.length === 0) return false;
  return list.includes('*') || list.includes(tool);
}

/** Same shape as `toolIsCovered`, applied to `covered_targets`. */
function targetIsCovered(scope: TrustScope, target: string): boolean {
  const list = scope.covered_targets;
  if (list === undefined) return true;
  if (list.length === 0) return false;
  return list.includes('*') || list.includes(target);
}

/**
 * worker-dispatch Phase 4 — single-grant usability check used by
 * `resolveGrant`'s explicit-grant_id path. Returns the structured denial
 * reason if the grant is not consumable, or `undefined` if it passes.
 */
function denyIfNotUsable(
  scope: TrustScope,
  actorId: string,
  tool: string,
  bindingTarget: string,
  now: Date,
): import('./types.js').GrantDenialReason | undefined {
  // Actor binding: NULL actor_id = global (any actor). Set value must match.
  if (scope.actor_id !== undefined && scope.actor_id !== actorId) {
    return 'grant_not_for_actor';
  }
  // Status check (revoked/expired/completed/proposed all surface as
  // grant_revoked for the audit semantic). Wall-clock expiry takes
  // precedence over status so a stale-active grant surfaces the
  // grant_expired reason rather than grant_revoked.
  if (new Date(scope.expires_at).getTime() <= now.getTime()) {
    return 'grant_expired';
  }
  if (scope.status !== 'active') {
    return 'grant_revoked';
  }
  if (!toolIsCovered(scope, tool)) return 'tool_not_covered';
  if (!targetIsCovered(scope, bindingTarget)) return 'target_not_covered';
  return undefined;
}

/**
 * worker-dispatch Phase 4 — actor-shape predicate. Mirrors the
 * Phase-5.6 allowlist semantic in `src/security/actor-permissions.ts`:
 * loopback-stamped actors and well-known agent labels are
 * "operator-shape" (eligible for auto-resolve + sentinel fallback);
 * everything else (peer:*, transport's 'unknown' stamp, future shapes)
 * is not (and must claim an explicit grant_id). Kept inline rather than
 * importing from actor-permissions to keep this module's import surface
 * minimal.
 */
function isOperatorShapeActor(actorId: string): boolean {
  if (actorId === 'unstamped-loopback') return true;
  if (actorId.startsWith('loopback:')) return true;
  return KNOWN_OPERATOR_ACTORS.has(actorId);
}

const KNOWN_OPERATOR_ACTORS: ReadonlySet<string> = new Set([
  'operator',
  'cowork-claude',
  'cc',
  'steward',
]);

function rowToScope(row: TrustScopeRow): TrustScope {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    granted_by: row.granted_by,
    granted_at: row.granted_at,
    expires_at: row.expires_at,
    expires_after_actions: row.expires_after_actions ?? undefined,
    allowed_actions: JSON.parse(row.allowed_actions_json) as ActionMatcher[],
    forbidden_actions: row.forbidden_actions_json
      ? (JSON.parse(row.forbidden_actions_json) as ActionMatcher[])
      : undefined,
    reporting: JSON.parse(row.reporting_json) as ScopeReporting,
    status: row.status as TrustScopeStatus,
    spec_url: row.spec_url ?? undefined,
    proposed_at: row.proposed_at ?? undefined,
    actions_executed: row.actions_executed,
    completed_at: row.completed_at ?? undefined,
    // worker-dispatch Phase 4 fields. NULL on disk → undefined here, which
    // the coverage check + actor-id check treat as wildcard / global per
    // the back-compat semantic documented on TrustScope.
    actor_id: row.actor_id ?? undefined,
    covered_tools: row.covered_tools_json
      ? (JSON.parse(row.covered_tools_json) as string[])
      : undefined,
    covered_targets: row.covered_targets_json
      ? (JSON.parse(row.covered_targets_json) as string[])
      : undefined,
    budget_remaining: row.budget_remaining ?? undefined,
  };
}
