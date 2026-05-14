// src/types/cowire-bom.ts
//
// Canonical type module for the v0.2 substrate: risk classes, capability tags,
// profile modes (with default routing tables), BOM artifacts. Pure types +
// const tables — zero runtime cost. Imported by the planner, executor,
// connector framework, and dashboard.
//
// Event kinds and their Zod payload schemas live in src/event-types.ts.

// ============================================================
// RISK CLASSES — the trust dimension every action carries
// ============================================================

/**
 * Risk classes are the canonical taxonomy of "what kind of thing is this
 * action." Every gated action (decision_request, BOM step, connector exec)
 * carries a risk_class. The no-go list matches against risk_class +
 * action_pattern. Trust scopes are envelopes of allowed risk classes.
 */
export type RiskClass =
  | 'read-only'
  | 'write-local'
  | 'write-remote'
  | 'execute'
  | 'external-comm'
  | 'financial'
  | 'credential'
  | 'destructive';

export const RISK_CLASSES: readonly RiskClass[] = [
  'read-only',
  'write-local',
  'write-remote',
  'execute',
  'external-comm',
  'financial',
  'credential',
  'destructive',
] as const;

/**
 * Risk classes that ALWAYS require explicit approval, even under permissive
 * profile modes. Steps with these classes generate individual
 * decision_request events regardless of scope envelope.
 */
export const ALWAYS_GATED_CLASSES: readonly RiskClass[] = [
  'destructive',
  'credential',
  'financial',
] as const;

// ============================================================
// CAPABILITY TAGS — the routing dimension
// ============================================================

/**
 * Capability tags describe what kind of cognitive work a step needs. The
 * planner uses these to pick a model: code-reasoning → opus, cheap-classifier
 * → llama-8b. Each profile mode declares an ordered routing list per tag.
 */
export type CapabilityTag =
  | 'reading'
  | 'cheap-classifier'
  | 'code-execution'
  | 'code-reasoning'
  | 'long-context'
  | 'multimodal-vision'
  | 'multimodal-audio'
  | 'tool-use-heavy'
  | 'simple-summary'
  | 'no-model';

export const CAPABILITY_TAGS: readonly CapabilityTag[] = [
  'reading',
  'cheap-classifier',
  'code-execution',
  'code-reasoning',
  'long-context',
  'multimodal-vision',
  'multimodal-audio',
  'tool-use-heavy',
  'simple-summary',
  'no-model',
] as const;

// ============================================================
// PROFILE MODES — Turbo / Balanced / Eco
// ============================================================

export type ProfileMode = 'turbo' | 'balanced' | 'eco';

export interface ProfileConfig {
  label: string;
  description: string;
  budget_daily_soft_usd: number;
  budget_daily_hard_usd: number;
  budget_per_job_soft_usd: number;
  on_capability_miss: 'refuse-notify' | 'auto-promote' | 'silent-fallback';
  approval_policy: 'always-ask' | 'auto-unless-flagged' | 'fully-auto';
  routing: Record<CapabilityTag, string[]>;
  steward_brain: string;
}

/**
 * Default profile configurations. Seeded into profile_config on init. The
 * routing tables list models in preference order — first available wins.
 * Update when new models drop.
 */
export const DEFAULT_PROFILES: Record<ProfileMode, ProfileConfig> = {
  turbo: {
    label: 'Turbo',
    description: 'Best model for every step. No cost cap. Re-plans up on failure.',
    budget_daily_soft_usd: 50,
    budget_daily_hard_usd: Number.POSITIVE_INFINITY,
    budget_per_job_soft_usd: 5,
    on_capability_miss: 'auto-promote',
    approval_policy: 'fully-auto',
    routing: {
      reading: ['claude-haiku-4-5', 'claude-sonnet-4-6'],
      'cheap-classifier': ['claude-haiku-4-5', 'claude-sonnet-4-6'],
      'code-execution': ['claude-sonnet-4-6', 'claude-opus-4-7'],
      'code-reasoning': ['claude-opus-4-7', 'claude-sonnet-4-6'],
      'long-context': ['claude-opus-4-7', 'claude-sonnet-4-6'],
      'multimodal-vision': ['claude-opus-4-7', 'claude-sonnet-4-6'],
      'multimodal-audio': ['claude-opus-4-7'],
      'tool-use-heavy': ['claude-opus-4-7', 'claude-sonnet-4-6'],
      'simple-summary': ['claude-haiku-4-5'],
      'no-model': [],
    },
    steward_brain: 'claude-opus-4-7',
  },

  balanced: {
    label: 'Balanced',
    description: 'Cheapest model that fits each step. Promotes on failure. Default mode.',
    budget_daily_soft_usd: 20,
    budget_daily_hard_usd: 40,
    budget_per_job_soft_usd: 0.5,
    on_capability_miss: 'auto-promote',
    approval_policy: 'auto-unless-flagged',
    routing: {
      reading: ['claude-haiku-4-5', 'claude-sonnet-4-6'],
      'cheap-classifier': ['claude-haiku-4-5'],
      'code-execution': ['claude-sonnet-4-6', 'claude-opus-4-7'],
      'code-reasoning': ['claude-opus-4-7', 'claude-sonnet-4-6'],
      'long-context': ['claude-sonnet-4-6', 'claude-opus-4-7'],
      'multimodal-vision': ['claude-sonnet-4-6'],
      'multimodal-audio': ['claude-sonnet-4-6'],
      'tool-use-heavy': ['claude-sonnet-4-6', 'claude-opus-4-7'],
      'simple-summary': ['claude-haiku-4-5'],
      'no-model': [],
    },
    steward_brain: 'claude-sonnet-4-6',
  },

  eco: {
    label: 'Eco',
    description: 'Local AI first. Refuses paid calls without your nod. Cheapest possible.',
    budget_daily_soft_usd: 5,
    budget_daily_hard_usd: 10,
    budget_per_job_soft_usd: 0.1,
    on_capability_miss: 'refuse-notify',
    approval_policy: 'always-ask',
    routing: {
      reading: ['llama-3.1-8b', 'claude-haiku-4-5'],
      'cheap-classifier': ['llama-3.1-8b'],
      'code-execution': ['claude-haiku-4-5'],
      'code-reasoning': ['claude-haiku-4-5'],
      'long-context': ['claude-haiku-4-5'],
      'multimodal-vision': ['claude-haiku-4-5'],
      'multimodal-audio': [],
      'tool-use-heavy': ['claude-haiku-4-5'],
      'simple-summary': ['llama-3.1-8b'],
      'no-model': [],
    },
    steward_brain: 'claude-haiku-4-5',
  },
};

// ============================================================
// BOM (Bill of Materials) — the planning artifact
// ============================================================

export type BomStatus =
  | 'proposed'
  | 'approved'
  | 'running'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'rejected';

export type BomStepStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'failed'
  | 'skipped';

export type BomVersionReason =
  | 'initial'
  | 'replan_on_failure'
  | 'manual_edit'
  | 'capability_escalation';

export interface BomStep {
  step_no: number;
  title: string;
  description?: string;
  capability: CapabilityTag;
  risk_class: RiskClass;
  /** Which brick handles this step — connector id, 'steward', or 'cc'. */
  brick_id: string;
  model: string;
  cost_estimate: number;
  duration_sec_est: number;
  depends_on: number[];
}

export interface BomVersion {
  bom_id: string;
  version: number;
  reason: BomVersionReason;
  replan_trigger_step?: number;
  steps: BomStep[];
  planner_model: string;
  planner_cost: number;
  created_at: string;
}

export interface Bom {
  id: string;
  goal: string;
  requester: string;
  correlation_id: string;
  status: BomStatus;
  active_version: number;
  cost_estimate: number;
  cost_max: number;
  duration_sec: number;
  cost_actual: number;
  steps_done: number;
  steps_total: number;
  profile_mode: ProfileMode;
  scope_id?: string;
  risk_envelope: RiskClass[];
  proposed_at: string;
  approved_at?: string;
  started_at?: string;
  ended_at?: string;
  is_draft: boolean;
}

// ============================================================
// EVENT PAYLOAD TYPES — full Zod schemas live in src/event-types.ts
// ============================================================

export interface PayloadBomProposed {
  bom_id: string;
  version: number;
  goal: string;
  steps_count: number;
  cost_estimate: number;
  cost_max: number;
  duration_sec_est: number;
  risk_envelope: RiskClass[];
  profile_mode: ProfileMode;
  planner_model: string;
}

export interface PayloadBomApproved {
  bom_id: string;
  version: number;
  scope_id: string;
  approver: string;
}

export interface PayloadBomRejected {
  bom_id: string;
  version: number;
  rejected_by: string;
  reason?: string;
}

export interface PayloadBomCancelled {
  bom_id: string;
  cancelled_by: string;
  reason?: string;
}

export interface PayloadBomCompleted {
  bom_id: string;
  version: number;
  cost_actual: number;
  steps_done: number;
  duration_sec: number;
  ended_at: string;
}

export interface PayloadBomFailed {
  bom_id: string;
  version: number;
  reason: string;
  last_step_no?: number;
}

export interface PayloadBomReplanned {
  bom_id: string;
  from_version: number;
  to_version: number;
  reason: BomVersionReason;
  trigger_step?: number;
}

export interface PayloadBomEdited {
  bom_id: string;
  version: number;
  edited_by: string;
}

export interface PayloadBomStepStarted {
  bom_id: string;
  version: number;
  step_no: number;
  worker_id: string;
  model: string;
}

export interface PayloadBomStepProgress {
  bom_id: string;
  version: number;
  step_no: number;
  message: string;
}

export interface PayloadBomStepCompleted {
  bom_id: string;
  version: number;
  step_no: number;
  cost_actual: number;
  tokens_in: number;
  tokens_out: number;
  duration_sec: number;
}

export interface PayloadBomStepFailed {
  bom_id: string;
  version: number;
  step_no: number;
  error_message: string;
  retry_count: number;
  will_replan: boolean;
}

export interface PayloadBomStepSkipped {
  bom_id: string;
  version: number;
  step_no: number;
  reason: string;
}

export interface PayloadBomStepPromoted {
  bom_id: string;
  version: number;
  step_no: number;
  from_model: string;
  to_model: string;
  reason: string;
}

export interface PayloadProfileModeSwitched {
  from_mode: ProfileMode;
  to_mode: ProfileMode;
  switched_by: string;
  reason?: string;
}
