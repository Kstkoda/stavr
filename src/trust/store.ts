import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { EventStore } from '../persistence.js';
import { scopeCovers } from './matcher.js';
import type {
  ActionMatcher,
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
  private readonly db: Database.Database;

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
           reporting_json, status, spec_url, proposed_at, actions_executed, completed_at)
         VALUES (?, ?, ?, '', '', ?, ?, ?, ?, ?, 'proposed', ?, ?, 0, NULL)`,
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
  };
}
