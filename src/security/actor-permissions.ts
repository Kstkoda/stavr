/**
 * Layer 3 — per-actor permissions matrix.
 *
 * Operator-settable tier per (actor, tool). Falls through to the tool's
 * registered default tier (`src/tools/categories.ts::defaultTierFor`) when
 * no row exists. Operators read/write this matrix via the `/dashboard/
 * permissions` page (v0.6.9 PR #2).
 *
 * Tier semantics (from `src/tools/categories.ts`):
 *   - AUTO     — execute without operator interaction
 *   - CONFIRM  — operator clicks "Confirm" before each call
 *   - EXPLICIT — operator types a friction string before each call
 *   - NO_GO    — never executable from this actor regardless of scope
 *
 * Default actors (operator-facing labels in the matrix UI):
 *   - operator       — you (the dashboard operator)
 *   - cowork-claude  — your Cowork-Claude MCP session
 *   - cc             — Claude Code workers (treated as a group; per-worker
 *                      sub-ids land in v0.7+)
 *   - steward        — the Steward subprocess
 *   - peer:<spawn>   — federated peers (ADR-035) — auto-registered on
 *                      first sight, never seeded
 */

import type { Database } from 'better-sqlite3';
import { defaultTierFor, type Tier } from '../tools/categories.js';

/**
 * Stable actor identifiers used as PRIMARY KEY in `actor_permissions`.
 * `peer:<spawn>` is dynamic; the others are well-known.
 */
export const KNOWN_ACTORS = [
  'operator',
  'cowork-claude',
  'cc',
  'steward',
] as const;
export type KnownActor = (typeof KNOWN_ACTORS)[number];

export interface ActorPermissionRow {
  actor_id: string;
  tool_id: string;
  tier: Tier;
  set_by: string;
  set_at: number;
}

export interface ResolvedTier {
  /** The tier in force for (actor, tool). */
  tier: Tier;
  /** Where it came from — for the UI to label "default" vs "operator-set". */
  source: 'default' | 'matrix';
}

export class ActorPermissionStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /** Every row in the matrix, sorted by (actor, tool). */
  list(): ActorPermissionRow[] {
    return this.db
      .prepare(
        `SELECT actor_id, tool_id, tier, set_by, set_at
         FROM actor_permissions ORDER BY actor_id ASC, tool_id ASC`,
      )
      .all() as ActorPermissionRow[];
  }

  /** All rows for one actor, sorted by tool_id. */
  byActor(actorId: string): ActorPermissionRow[] {
    return this.db
      .prepare(
        `SELECT actor_id, tool_id, tier, set_by, set_at
         FROM actor_permissions WHERE actor_id = ? ORDER BY tool_id ASC`,
      )
      .all(actorId) as ActorPermissionRow[];
  }

  /**
   * Distinct actor ids present in the matrix. Used by the UI to seed the
   * "Actor" dropdown along with `KNOWN_ACTORS`.
   */
  actors(): string[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT actor_id FROM actor_permissions`)
      .all() as Array<{ actor_id: string }>;
    return rows.map((r) => r.actor_id);
  }

  /**
   * Look up a single (actor, tool) cell. Returns the operator-set row if
   * present, otherwise undefined (caller falls back to default tier).
   */
  get(actorId: string, toolId: string): ActorPermissionRow | undefined {
    return this.db
      .prepare(
        `SELECT actor_id, tool_id, tier, set_by, set_at
         FROM actor_permissions WHERE actor_id = ? AND tool_id = ?`,
      )
      .get(actorId, toolId) as ActorPermissionRow | undefined;
  }

  /**
   * Resolve the effective tier for (actor, tool). Matrix row beats the
   * registered default; if no matrix row exists, returns the default with
   * `source = 'default'`.
   */
  resolve(actorId: string, toolId: string): ResolvedTier {
    const row = this.get(actorId, toolId);
    if (row) return { tier: row.tier, source: 'matrix' };
    return { tier: defaultTierFor(toolId), source: 'default' };
  }

  /**
   * Upsert a tier choice. `setBy` is the operator identifier (always
   * `'operator'` from the dashboard session; MCP-tool writes are
   * blocked at the transport layer).
   */
  set(actorId: string, toolId: string, tier: Tier, setBy: string): void {
    this.db
      .prepare(
        `INSERT INTO actor_permissions (actor_id, tool_id, tier, set_by, set_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(actor_id, tool_id) DO UPDATE SET
           tier   = excluded.tier,
           set_by = excluded.set_by,
           set_at = excluded.set_at`,
      )
      .run(actorId, toolId, tier, setBy, Date.now());
  }

  /**
   * Reset (actor, tool) to its registered default — drops the matrix row.
   */
  reset(actorId: string, toolId: string): void {
    this.db
      .prepare(`DELETE FROM actor_permissions WHERE actor_id = ? AND tool_id = ?`)
      .run(actorId, toolId);
  }

  /** Drop every row for an actor. */
  resetActor(actorId: string): void {
    this.db
      .prepare(`DELETE FROM actor_permissions WHERE actor_id = ?`)
      .run(actorId);
  }
}
