/**
 * Tool categorisation + default-tier / reversibility heuristics.
 *
 * The MCP tools stavR exposes are registered across ~11 subsystem files
 * (`adapters/github*`, `workers/tools`, `trust/tools`, `credentials/tools`,
 * `steward/tools`, etc.). The `ToolRegistry` records every registration but
 * each registration site doesn't carry "what kind of tool is this?" or
 * "what's a safe default approval tier?" metadata — those are policy
 * concerns owned by the security layer, not by the subsystem author.
 *
 * This module is the policy table: a name → category + default tier +
 * reversibility map, with fallbacks for unknown tools so adding a new
 * subsystem doesn't crash the registry.
 *
 * Conservative bias: when in doubt, default to a stricter tier. Operators
 * can always loosen via the per-actor matrix (v0.6.9 PR #2). Defaults
 * exist so the FIRST time a new tool is added, it isn't accidentally
 * AUTO-approved for every actor.
 */

/**
 * Categories surface in the `/dashboard/tools` page header filter + the
 * Topology permissions overlay (PR #2). Keep the set small and meaningful
 * — operators should be able to scan it without re-reading docs.
 */
export type ToolCategory =
  | 'worker'        // worker_spawn, worker_terminate, worker_get_status, …
  | 'scope'         // trust_scope_*
  | 'github'        // github_* — read + write
  | 'steward'       // steward_*
  | 'credentials'   // credential_*
  | 'subscription'  // subscribe_to_events, unsubscribe, get_events
  | 'event'         // emit_event
  | 'decision'      // respond_to_decision, await_decision
  | 'shell'         // host_exec
  | 'plan'          // propose_plan, steward_ask
  | 'other';

/**
 * 4-tier approval model (CLAUDE.md / project_stavr_four_tier_approval_model).
 *
 * AUTO    — execute without operator interaction (safe / read-only / scoped)
 * CONFIRM — execute after operator clicks "Confirm" (reversible writes)
 * EXPLICIT— operator must type a friction string (irreversible / destructive)
 * NO_GO   — never executable from this actor regardless of scope; only
 *           Lex Insculpta or operator action can lift
 */
export const TIERS = ['AUTO', 'CONFIRM', 'EXPLICIT', 'NO_GO'] as const;
export type Tier = (typeof TIERS)[number];

/**
 * Map well-known tool ids to their category. Anything not in this map
 * falls through to a prefix-based heuristic (`worker_*` → worker, etc.)
 * and finally to `'other'`.
 */
const EXPLICIT_CATEGORY: Record<string, ToolCategory> = {
  emit_event: 'event',
  subscribe_to_events: 'subscription',
  unsubscribe: 'subscription',
  get_events: 'subscription',
  respond_to_decision: 'decision',
  await_decision: 'decision',
  host_exec: 'shell',
  propose_plan: 'plan',
  steward_ask: 'plan',
};

/**
 * Pure prefix-based fallback. Order matters — longest-match wins (so
 * `trust_scope_*` resolves to `scope` not `steward`).
 *
 * Each entry lists ALL separator variants the adapter might have used.
 * GitHub tools in particular are registered as `github.create_pr`
 * (MCP namespace convention) but historical code and trust-scope
 * `scopeCheck` payloads use `github_create_pr` — both must categorize
 * to `github`. The variants array is iterated, first match wins.
 */
const PREFIX_CATEGORY: Array<[ReadonlyArray<string>, ToolCategory]> = [
  [['trust_scope_', 'trust_scope.'], 'scope'],
  // worker-dispatch Phase 3b — job_* tools share the 'worker' category with
  // their legacy worker_* counterparts. 3c renames the category itself when
  // the bespoke worker subsystem is deleted; for now both prefixes route here
  // so the dashboard filter chip + permissions matrix list the pair together.
  [['worker_', 'worker.', 'job_', 'job.'], 'worker'],
  [['github_', 'github.'], 'github'],
  [['steward_', 'steward.'], 'steward'],
  [['credential_', 'credential.'], 'credentials'],
];

/**
 * Map a tool id to a category. Used by both the registry (at record-time)
 * and any future filter UI that wants to bucket tools without trusting
 * the registration site to have set `meta.category` correctly.
 */
export function categorize(toolId: string): ToolCategory {
  const direct = EXPLICIT_CATEGORY[toolId];
  if (direct) return direct;
  // longest-prefix wins; PREFIX_CATEGORY is already ordered most-specific-first
  for (const [prefixes, cat] of PREFIX_CATEGORY) {
    for (const prefix of prefixes) {
      if (toolId.startsWith(prefix)) return cat;
    }
  }
  return 'other';
}

/**
 * Default tier per tool. Operators see this as the "baseline" tier in the
 * matrix UI (PR #2). Per-actor overrides live in the `actor_permissions`
 * table; this is the registration-time fallback.
 *
 * Conservative bias: anything that names a write/destroy/spawn verb gets
 * CONFIRM+; anything obviously read-only gets AUTO. host_exec is EXPLICIT
 * (arbitrary shell). credentials_* is EXPLICIT (touches secrets).
 */
const EXPLICIT_TIER: Record<string, Tier> = {
  // Reads / subscriptions / event publishers
  emit_event: 'AUTO',
  subscribe_to_events: 'AUTO',
  unsubscribe: 'AUTO',
  get_events: 'AUTO',
  worker_list_types: 'AUTO',
  worker_list: 'AUTO',
  worker_status: 'AUTO',
  steward_ask: 'AUTO',
  // Writes / spawns
  worker_spawn: 'CONFIRM',
  worker_dispatch: 'CONFIRM',
  worker_terminate: 'CONFIRM',
  // worker-dispatch Phase 3b — job_* tier mirrors its worker_* counterpart
  // (parity is the contract: operator grants in actor_permissions that name
  // worker_* IDs must resolve identically when they migrate to job_*).
  // The pairing per recon §3:
  //   job_list_bindings  ≡ worker_list_types
  //   job_list           ≡ worker_list
  //   job_status         ≡ worker_status
  //   job_dispatch       ≡ worker_spawn        (start a new run)
  //   job_inject         ≡ worker_dispatch     (mid-flight injection)
  //   job_terminate      ≡ worker_terminate
  job_list_bindings: 'AUTO',
  job_list: 'AUTO',
  job_status: 'AUTO',
  job_dispatch: 'CONFIRM',
  job_inject: 'CONFIRM',
  job_terminate: 'CONFIRM',
  // Shell / credentials
  host_exec: 'EXPLICIT',
  propose_plan: 'CONFIRM',
  await_decision: 'AUTO',
  respond_to_decision: 'AUTO',
};

/**
 * Phase 3b parity table — legacy worker_* IDs ↔ canonical job_* IDs.
 *
 * Operator-authored grants in actor_permissions reference tool IDs by
 * string. During the deprecation window both names must resolve to the
 * same tier so existing grants don't silently break when callers migrate
 * one tool at a time. The constant is exported so the runtime gate can
 * also use it to translate when looking up actor-specific overrides on
 * one name but the call comes in on the other.
 *
 * Map shape: legacy → canonical.
 */
export const WORKER_TO_JOB_TOOL_ID_ALIAS: Readonly<Record<string, string>> = {
  worker_list_types: 'job_list_bindings',
  worker_list: 'job_list',
  worker_status: 'job_status',
  worker_spawn: 'job_dispatch',
  worker_dispatch: 'job_inject',
  worker_terminate: 'job_terminate',
};

/**
 * The reverse alias table — built once at module load so the actor-permissions
 * resolver and the deprecation-log helper can look up parity in either
 * direction without re-computing.
 */
export const JOB_TO_WORKER_TOOL_ID_ALIAS: Readonly<Record<string, string>> =
  Object.freeze(
    Object.fromEntries(
      Object.entries(WORKER_TO_JOB_TOOL_ID_ALIAS).map(([w, j]) => [j, w]),
    ),
  );

/**
 * Return the alias counterpart for a tool id (either direction), or
 * undefined when the id has no counterpart in the rename pair table.
 * Bi-directional: 'worker_spawn' → 'job_dispatch'; 'job_dispatch' →
 * 'worker_spawn'.
 *
 * Used at the actor-permissions resolver (security/actor-permissions.ts)
 * so an operator-written matrix row for one name applies to the other
 * during the deprecation window — otherwise a stale grant for worker_spawn
 * would silently NOT apply when a caller migrates to job_dispatch.
 */
export function aliasCounterpartFor(toolId: string): string | undefined {
  return WORKER_TO_JOB_TOOL_ID_ALIAS[toolId] ?? JOB_TO_WORKER_TOOL_ID_ALIAS[toolId];
}

/**
 * Look up the default tier for a tool, falling back to category-based
 * defaults if the id isn't in `EXPLICIT_TIER`.
 */
export function defaultTierFor(toolId: string): Tier {
  const explicit = EXPLICIT_TIER[toolId];
  if (explicit) return explicit;
  const cat = categorize(toolId);
  switch (cat) {
    case 'github':
      // github_* is split read/write at the adapter level; without that
      // signal we default to CONFIRM since the write tools dominate in
      // operator-mental-model risk.
      return 'CONFIRM';
    case 'credentials':
      return 'EXPLICIT';
    case 'scope':
      return 'CONFIRM';
    case 'steward':
      return 'AUTO';
    case 'worker':
      return 'CONFIRM';
    case 'shell':
      return 'EXPLICIT';
    case 'plan':
      return 'CONFIRM';
    case 'decision':
      return 'AUTO';
    case 'subscription':
    case 'event':
      return 'AUTO';
    default:
      return 'CONFIRM';
  }
}

/**
 * Tools split into "reversible" (read, subscribe, propose without execute)
 * and "irreversible" (delete, push, write, spawn). Drives operator UI
 * affordances — irreversible actions get the friction string treatment.
 */
const EXPLICIT_REVERSIBILITY: Record<string, 'reversible' | 'irreversible'> = {
  emit_event: 'reversible',
  subscribe_to_events: 'reversible',
  unsubscribe: 'reversible',
  get_events: 'reversible',
  worker_list_types: 'reversible',
  worker_list: 'reversible',
  worker_status: 'reversible',
  steward_ask: 'reversible',
  propose_plan: 'reversible',
  await_decision: 'reversible',
  respond_to_decision: 'irreversible',
  worker_spawn: 'irreversible',
  worker_dispatch: 'irreversible',
  worker_terminate: 'irreversible',
  // Phase 3b parity — see WORKER_TO_JOB_TOOL_ID_ALIAS above.
  job_list_bindings: 'reversible',
  job_list: 'reversible',
  job_status: 'reversible',
  job_dispatch: 'irreversible',
  job_inject: 'irreversible',
  job_terminate: 'irreversible',
  host_exec: 'irreversible',
};

export function reversibilityFor(toolId: string): 'reversible' | 'irreversible' {
  const explicit = EXPLICIT_REVERSIBILITY[toolId];
  if (explicit) return explicit;
  const cat = categorize(toolId);
  switch (cat) {
    // Anything that touches GitHub at the write layer is irreversible (a
    // squashed merge can't be unsquashed); the read tools are reversible
    // but we conservatively treat the whole `github_*` family as
    // irreversible at the category level. PR-#2's per-tool overrides
    // can refine this for the specific read tools.
    case 'github':
      return 'irreversible';
    case 'credentials':
      return 'irreversible';
    case 'worker':
      return 'irreversible';
    case 'shell':
      return 'irreversible';
    case 'scope':
      // trust_scope_grant is reversible (revoke); trust_scope_revoke
      // itself is reversible (re-grant); the family stays reversible.
      return 'reversible';
    case 'steward':
    case 'plan':
    case 'decision':
    case 'subscription':
    case 'event':
      return 'reversible';
    default:
      return 'reversible';
  }
}
