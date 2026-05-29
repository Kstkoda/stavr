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

import type { Database } from '../db/index.js';
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

/**
 * Phase 5.6 — explicit allowlist predicate. An actor is operator-shape
 * iff it is a loopback-stamped identity (verified by the kernel boundary
 * or the stdio default) OR one of the well-known agent labels in
 * KNOWN_ACTORS. Everything else (paired peers `peer:*`, the transport's
 * `'unknown'` stamp, any future unrecognized actor_id shape) is NOT
 * operator-shape and falls through to default-deny in `resolve()`.
 *
 * Inlined here (rather than imported from src/security/respond-policy.ts)
 * to keep this module's import surface minimal — actor-permissions has
 * no other dependencies on respond-policy, and the loopback-shape check
 * is two string operations.
 */
function isOperatorShapeActor(actorId: string): boolean {
  if (actorId === 'unstamped-loopback') return true;
  if (actorId.startsWith('loopback:')) return true;
  return (KNOWN_ACTORS as readonly string[]).includes(actorId);
}

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
  /**
   * Where the tier came from — for the UI to label correctly and for
   * audit reasons in chokepoint deny messages.
   *
   *   `matrix`        — operator set this cell explicitly.
   *   `default`       — operator-shape actor (loopback-stamped, the
   *                     `unstamped-loopback` stdio default, or one of
   *                     the well-known agent labels in `KNOWN_ACTORS`:
   *                     operator, cc, cowork-claude, steward) with no
   *                     matrix row → falls through to `defaultTierFor()`
   *                     (categories.ts conservative bias).
   *   `default-deny`  — anything else with no matrix row: paired peer
   *                     (`peer:*`), the transport's `'unknown'` stamp
   *                     for non-loopback requests without a verified
   *                     device, or any future unrecognized actor_id
   *                     shape. Phase 5.6 made the operator branch an
   *                     explicit allowlist; this is the catch-all
   *                     default-deny that resolves to NO_GO so the
   *                     chokepoint hard-denies until the operator
   *                     explicitly grants a tier via the matrix UI.
   *                     (Was `default-deny-peer` in Phase 5.5 when the
   *                     branch only covered paired peers; Phase 5.6
   *                     widened the catch-all and renamed accordingly.)
   */
  source: 'default' | 'matrix' | 'default-deny';
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
   * Resolve the effective tier for (actor, tool). Matrix row beats every
   * fall-through. With no row, the operator-shape check is an EXPLICIT
   * ALLOWLIST (Phase 5.6) — anything not on the list resolves to
   * default-deny.
   *
   * Operator-shape (defaultTierFor):
   *   - Loopback-stamped actors: `loopback:<corr>` (HTTP /mcp loopback
   *     verified by the transport) or `unstamped-loopback` (the stdio
   *     default when no HTTP middleware runs). Loopback is the kernel-
   *     enforced ADR-006 boundary; a peer cannot fake it.
   *   - Well-known agent labels in KNOWN_ACTORS: `operator`,
   *     `cowork-claude`, `cc`, `steward`. These are operator-proxies
   *     that run in-process on the daemon host; the dashboard matrix
   *     UI relies on them resolving to defaultTierFor so the operator
   *     can see and edit baseline tiers per row.
   *
   * Anything else (paired peers `peer:*`, the transport's `'unknown'`
   * stamp for non-loopback requests without a verified device, future
   * unrecognized actor_id shapes) → default-deny: tier NO_GO, source
   * `'default-deny'`. The chokepoint hard-denies NO_GO before the
   * gatedAction trust-scope check runs, matching the existing "NO_GO
   * is a hard floor regardless of scope" semantics in
   * src/tools/categories.ts. Trust-scope-driven authorization for
   * default-denied actors would be a future widening (chokepoint
   * scope-aware override or a new tier-resolution layer).
   */
  resolve(actorId: string, toolId: string): ResolvedTier {
    const row = this.get(actorId, toolId);
    if (row) return { tier: row.tier, source: 'matrix' };
    // worker-dispatch Phase 3c.2 — the worker_*/job_* alias-aware fallback
    // branch deleted. The bespoke worker subsystem is gone; legacy
    // worker_* tool IDs no longer exist as registered tools, so an alias
    // lookup has nothing to resolve to. Operators with stale matrix rows
    // referencing `worker_spawn` etc. land on direct-hit (the row still
    // exists in the table — see ResolvedTier.matrix), but no tool invokes
    // those names anymore so the row is inert data until cleaned up.
    if (isOperatorShapeActor(actorId)) {
      return { tier: defaultTierFor(toolId), source: 'default' };
    }
    return { tier: 'NO_GO', source: 'default-deny' };
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
