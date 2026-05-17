/**
 * Layer 0 — operator runtime capability master switch.
 *
 * Sits ABOVE every other authorisation check in the 5-layer model:
 *   1. Lex Insculpta hard check (source-code constants)
 *   2. No-Go list (source-code seeded patterns)
 *   3. Layer 0 capability check    ← this module
 *   4. Per-actor permission tier (Layer 3 — see actor-permissions.ts)
 *   5. Trust scope grant (Layer 4 — see trust-scopes.ts / trust/store.ts)
 *
 * What it does: the operator can mark a tool `disabled-permanent` or
 * `disabled-temporary` (with an `until` timestamp). When the runtime gate
 * inspects a call against that tool, the result is DENY regardless of
 * what scope or per-actor tier says. Re-enabling lifts the gate.
 *
 * What it does NOT do: it does not change the catalog (tools stay
 * registered + visible). It does not delete the actor's trust scope (a
 * scope can outlive a Layer 0 disable; the scope auto-resumes effective
 * status when Layer 0 is re-enabled).
 *
 * Edits: only through this module's API (called by the Permissions UI
 * `src/dashboard/data/permissions-data.ts`). An MCP-tool path to
 * `capability_overrides` is a hard NO — only the operator (via the
 * dashboard session) edits this table. The BOM's hard rule #8 is
 * enforced at the transport layer.
 */

import type { Database } from 'better-sqlite3';

export type CapabilityState =
  | 'enabled'
  | 'disabled-temporary'
  | 'disabled-permanent';

export interface CapabilityOverrideRow {
  tool_id: string;
  state: CapabilityState;
  disabled_until: number | null;
  reason: string | null;
  set_by: string;
  set_at: number;
}

export interface CapabilityCheckResult {
  /** True if the tool is currently allowed by Layer 0. */
  allowed: boolean;
  /** Present when `allowed === false` — explains why. */
  reason?: string;
  /** Set when state has expired since the last write (caller may re-store). */
  expired?: boolean;
}

/**
 * Storage + check operations against `capability_overrides`. Single
 * instance per broker, attached via the existing per-broker pattern in
 * server.ts.
 */
export class CapabilityOverrideStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /** Return every override row, sorted by tool_id. */
  list(): CapabilityOverrideRow[] {
    return this.db
      .prepare(
        `SELECT tool_id, state, disabled_until, reason, set_by, set_at
         FROM capability_overrides ORDER BY tool_id ASC`,
      )
      .all() as CapabilityOverrideRow[];
  }

  /** Fetch one override row by tool id, or undefined. */
  get(toolId: string): CapabilityOverrideRow | undefined {
    return this.db
      .prepare(
        `SELECT tool_id, state, disabled_until, reason, set_by, set_at
         FROM capability_overrides WHERE tool_id = ?`,
      )
      .get(toolId) as CapabilityOverrideRow | undefined;
  }

  /**
   * Disable a tool permanently. Operator can re-enable via `enable()`.
   * `reason` is shown back in the dashboard + serialised to YAML mirror.
   */
  disablePermanent(toolId: string, opts: { reason?: string; setBy: string }): void {
    this.upsert(toolId, {
      state: 'disabled-permanent',
      disabled_until: null,
      reason: opts.reason ?? null,
      set_by: opts.setBy,
    });
  }

  /**
   * Disable a tool until `untilMs` (unix ms). After expiry the row stays
   * but `check()` returns allowed = true (and flags `expired = true` so
   * the caller can drop the row).
   */
  disableTemporary(
    toolId: string,
    opts: { untilMs: number; reason?: string; setBy: string },
  ): void {
    this.upsert(toolId, {
      state: 'disabled-temporary',
      disabled_until: opts.untilMs,
      reason: opts.reason ?? null,
      set_by: opts.setBy,
    });
  }

  /**
   * Re-enable a previously disabled tool. Idempotent — re-enabling an
   * already-enabled tool is a no-op (no row written, no audit noise).
   */
  enable(toolId: string, setBy: string): void {
    this.upsert(toolId, {
      state: 'enabled',
      disabled_until: null,
      reason: null,
      set_by: setBy,
    });
  }

  /**
   * Drop an override row entirely. Equivalent to "no override at all";
   * the runtime gate falls through to Layer 3 (per-actor) for the tool.
   * Mostly useful for cleanup; `enable()` is the operator-facing path.
   */
  remove(toolId: string): void {
    this.db.prepare(`DELETE FROM capability_overrides WHERE tool_id = ?`).run(toolId);
  }

  /**
   * Layer 0 gate. Called by the runtime authorisation flow BEFORE the
   * per-actor / trust-scope checks. Returns allowed = false when the
   * tool is disabled (and the disable hasn't expired).
   */
  check(toolId: string, nowMs: number = Date.now()): CapabilityCheckResult {
    const row = this.get(toolId);
    if (!row) return { allowed: true };
    if (row.state === 'enabled') return { allowed: true };
    if (row.state === 'disabled-permanent') {
      return {
        allowed: false,
        reason:
          row.reason ?? `tool ${toolId} is disabled permanently by operator (Layer 0)`,
      };
    }
    // disabled-temporary: enforce until disabled_until
    if (row.disabled_until != null && nowMs >= row.disabled_until) {
      return { allowed: true, expired: true };
    }
    return {
      allowed: false,
      reason:
        row.reason ??
        `tool ${toolId} is temporarily disabled by operator (Layer 0); until ${row.disabled_until}`,
    };
  }

  /** True if the tool has any non-enabled override currently in force. */
  isDisabled(toolId: string, nowMs: number = Date.now()): boolean {
    return !this.check(toolId, nowMs).allowed;
  }

  /**
   * Total active-disable count. Used by the operator UI's header pill —
   * "3 tools disabled" surfaces a glance-able number.
   */
  activeDisabledCount(nowMs: number = Date.now()): number {
    return this.list().filter((r) => this.check(r.tool_id, nowMs).allowed === false)
      .length;
  }

  private upsert(
    toolId: string,
    fields: {
      state: CapabilityState;
      disabled_until: number | null;
      reason: string | null;
      set_by: string;
    },
  ): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO capability_overrides (tool_id, state, disabled_until, reason, set_by, set_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(tool_id) DO UPDATE SET
           state          = excluded.state,
           disabled_until = excluded.disabled_until,
           reason         = excluded.reason,
           set_by         = excluded.set_by,
           set_at         = excluded.set_at`,
      )
      .run(toolId, fields.state, fields.disabled_until, fields.reason, fields.set_by, now);
  }
}
