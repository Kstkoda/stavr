// v0.6.9 P6 — Named permission policies.
//
// A named policy is a preset of per-tool tier choices that the operator
// can apply to one actor in a single click. Three policies ship in v0.6.9:
//
//   - tight        — everything CONFIRM or stricter; reads stay AUTO
//   - developer    — relaxed for the actor running developer workloads:
//                    worker_spawn / propose_plan AUTO, host_exec still
//                    EXPLICIT (irreversible shell never goes below EXPLICIT)
//   - review-only  — every actionable tool downgraded to CONFIRM or NO_GO;
//                    reads + subscribes remain AUTO so the dashboard still
//                    surfaces activity, but nothing mutates without a click
//
// Applying a policy writes one matrix row per tool to the
// `actor_permissions` table for the target actor — equivalent to the
// operator setting every dropdown manually, but atomically and
// deterministically. Tools NOT mentioned by the policy are left
// untouched (their existing tier or default stays).
//
// Custom policies (operator-defined "save current as my-team-strict")
// live in a separate `permission_policies` table the dispatch's P6
// explicitly mentions; that's a follow-up. v0.6.9 ships the three
// built-ins so operators have a baseline immediately.

import type { ActorPermissionStore } from './actor-permissions.js';
import type { Tier } from '../tools/categories.js';

/** Stable preset identifiers — referenced by the API + dashboard UI. */
export const POLICY_PRESET_IDS = ['tight', 'developer', 'review-only'] as const;
export type PolicyPresetId = (typeof POLICY_PRESET_IDS)[number];

export interface PolicyPreset {
  id: PolicyPresetId;
  /** Human-friendly label for the dashboard dropdown. */
  label: string;
  /** One-line description shown when the operator hovers / selects. */
  description: string;
  /** Per-tool tier choices. Tools not listed here keep their current
   *  matrix row (or fall through to the registered default). */
  tiers: Record<string, Tier>;
}

/**
 * The three built-in presets. Tier choices are intentionally
 * conservative — every preset MUST keep host_exec at EXPLICIT or
 * stricter (per the BOM's "operator can make stricter, not looser than
 * irreversibility implies" guidance).
 */
export const BUILT_IN_POLICIES: Record<PolicyPresetId, PolicyPreset> = {
  tight: {
    id: 'tight',
    label: 'Tight',
    description: 'Read-only AUTO; every mutating tool CONFIRM+. host_exec EXPLICIT.',
    tiers: {
      // reads / subscriptions / event publishers — AUTO
      emit_event: 'AUTO',
      subscribe_to_events: 'AUTO',
      unsubscribe: 'AUTO',
      get_events: 'AUTO',
      worker_list: 'AUTO',
      worker_list_types: 'AUTO',
      worker_status: 'AUTO',
      steward_ask: 'AUTO',
      await_decision: 'AUTO',
      respond_to_decision: 'CONFIRM',
      // writes / spawns — CONFIRM
      worker_spawn: 'CONFIRM',
      worker_dispatch: 'CONFIRM',
      worker_terminate: 'CONFIRM',
      // worker-dispatch Phase 3b — job_* parity mirrors worker_* in every
      // preset so applying a policy writes consistent rows for both wire
      // names. See WORKER_TO_JOB_TOOL_ID_ALIAS in tools/categories.ts.
      job_list: 'AUTO',
      job_list_bindings: 'AUTO',
      job_status: 'AUTO',
      job_dispatch: 'CONFIRM',
      job_inject: 'CONFIRM',
      job_terminate: 'CONFIRM',
      propose_plan: 'CONFIRM',
      // dangerous — EXPLICIT
      host_exec: 'EXPLICIT',
    },
  },
  developer: {
    id: 'developer',
    label: 'Developer',
    description: 'Worker spawn AUTO; plan + dispatch CONFIRM; host_exec stays EXPLICIT.',
    tiers: {
      emit_event: 'AUTO',
      subscribe_to_events: 'AUTO',
      unsubscribe: 'AUTO',
      get_events: 'AUTO',
      worker_list: 'AUTO',
      worker_list_types: 'AUTO',
      worker_status: 'AUTO',
      steward_ask: 'AUTO',
      await_decision: 'AUTO',
      respond_to_decision: 'AUTO',
      // dev hot-path
      worker_spawn: 'AUTO',
      worker_dispatch: 'CONFIRM',
      worker_terminate: 'CONFIRM',
      // Phase 3b parity — see 'tight' for the rationale.
      job_list: 'AUTO',
      job_list_bindings: 'AUTO',
      job_status: 'AUTO',
      job_dispatch: 'AUTO',
      job_inject: 'CONFIRM',
      job_terminate: 'CONFIRM',
      propose_plan: 'AUTO',
      // host_exec NEVER drops below EXPLICIT — arbitrary shell deserves
      // friction even when the operator has signed off on the actor
      host_exec: 'EXPLICIT',
    },
  },
  'review-only': {
    id: 'review-only',
    label: 'Review-only',
    description: 'Every mutating tool CONFIRM or NO_GO. Reads still AUTO to keep the dashboard alive.',
    tiers: {
      emit_event: 'AUTO',
      subscribe_to_events: 'AUTO',
      unsubscribe: 'AUTO',
      get_events: 'AUTO',
      worker_list: 'AUTO',
      worker_list_types: 'AUTO',
      worker_status: 'AUTO',
      steward_ask: 'AUTO',
      await_decision: 'AUTO',
      respond_to_decision: 'CONFIRM',
      // mutations blocked entirely
      worker_spawn: 'NO_GO',
      worker_dispatch: 'NO_GO',
      worker_terminate: 'CONFIRM',
      // Phase 3b parity — see 'tight'.
      job_list: 'AUTO',
      job_list_bindings: 'AUTO',
      job_status: 'AUTO',
      job_dispatch: 'NO_GO',
      job_inject: 'NO_GO',
      job_terminate: 'CONFIRM',
      propose_plan: 'CONFIRM',
      host_exec: 'NO_GO',
    },
  },
};

/** Lookup by id with a typed error when not found. */
export function getPolicyPreset(id: string): PolicyPreset {
  const preset = (BUILT_IN_POLICIES as Record<string, PolicyPreset | undefined>)[id];
  if (!preset) {
    throw new Error(`unknown policy preset: ${id} (known: ${POLICY_PRESET_IDS.join(', ')})`);
  }
  return preset;
}

/** List all built-in presets — used by the dashboard dropdown. */
export function listPolicyPresets(): PolicyPreset[] {
  return POLICY_PRESET_IDS.map((id) => BUILT_IN_POLICIES[id]);
}

export interface ApplyPolicyResult {
  /** Number of (actor, tool) cells written. */
  cellsWritten: number;
  /** Per-tool before / after view of the writes for audit-event emission. */
  changes: Array<{
    tool_id: string;
    from_tier: Tier | null;
    to_tier: Tier;
  }>;
}

/**
 * Apply a preset to an actor by upserting every (actor, tool) row from
 * `preset.tiers`. Existing matrix rows for tools NOT mentioned in the
 * preset are LEFT UNTOUCHED — partial presets are valid.
 *
 * Returns the list of changes so the caller can emit one audit event
 * per affected tool (or one summary event with the full delta).
 */
export function applyPolicyToActor(
  preset: PolicyPreset,
  actorId: string,
  perms: ActorPermissionStore,
  setBy: string,
): ApplyPolicyResult {
  const changes: ApplyPolicyResult['changes'] = [];
  for (const [toolId, toTier] of Object.entries(preset.tiers)) {
    const prior = perms.get(actorId, toolId);
    const fromTier = prior ? prior.tier : null;
    if (fromTier === toTier) continue;
    perms.set(actorId, toolId, toTier, setBy);
    changes.push({ tool_id: toolId, from_tier: fromTier, to_tier: toTier });
  }
  return { cellsWritten: changes.length, changes };
}
