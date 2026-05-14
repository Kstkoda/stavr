// types.ts — proposed additions to stavr's type system
//
// Merge the event-kind additions into src/event-types.ts.
// Move the rest into src/types/ (one file per concept if you prefer).
// Everything here is zero-runtime — pure TypeScript types and small const tables.

// ============================================================
// RISK CLASSES — the trust dimension every action carries
// ============================================================

/**
 * Risk classes are the canonical taxonomy of "what kind of thing is this action."
 * Every gated action (decision_request, BOM step, connector exec) carries a risk_class.
 * The no-go list matches against risk_class + action_pattern.
 * Trust scopes are envelopes of allowed risk classes.
 */
export type RiskClass =
  | 'read-only'        // Read, Grep, Glob, github_read_*, query — no state change
  | 'write-local'      // Edit/Write in worktree, local branch ops
  | 'write-remote'     // git push (non-force), PR open, github_create_*, comment
  | 'execute'          // npm test, build scripts, anything in a shell that produces side effects
  | 'external-comm'    // Send email, slack, discord, any message to outside party
  | 'financial'        // Payment, subscription change, paid-API spend above threshold
  | 'credential'       // Add/rotate/revoke credentials, secret access outside vault
  | 'destructive';     // Force push, rm -rf, DROP TABLE, schema migration, prod deploy

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
 * Risk classes that ALWAYS require explicit approval, even under Rapid mode.
 * Steps with these classes generate individual decision_request events
 * regardless of whether a scope is open.
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
 * Capability tags describe what kind of cognitive work a step needs.
 * The planner uses these to pick a model: code-reasoning → opus, cheap-classifier → llama-8b.
 * Each model declares which capabilities it can serve.
 */
export type CapabilityTag =
  | 'reading'              // Just reading files / docs / metadata
  | 'cheap-classifier'     // Yes/no / categorize / extract — local model fits
  | 'code-execution'       // Apply edits, run tests, scripted work
  | 'code-reasoning'       // Design refactor, debug complex issues, architecture
  | 'long-context'         // > 100k token inputs, document synthesis
  | 'multimodal-vision'    // Image / screenshot analysis
  | 'multimodal-audio'     // Audio transcription / analysis
  | 'tool-use-heavy'       // Many sequential tool calls, agentic
  | 'simple-summary'       // Summarize 1-3 short docs
  | 'no-model';            // Step doesn't need an LLM (e.g., wait for CI, run a shell command)

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
  /** Display label */
  label: string;
  /** Short description shown in UI */
  description: string;
  /** Daily soft budget cap in USD — warning, doesn't stop */
  budget_daily_soft_usd: number;
  /** Daily hard budget cap in USD — stops new spawns at this limit */
  budget_daily_hard_usd: number;
  /** Per-job soft cap — BOMs estimated over this require approval even under Rapid mode */
  budget_per_job_soft_usd: number;
  /** What to do when a cheap model can't do a step's capability */
  on_capability_miss: 'refuse-notify' | 'auto-promote' | 'silent-fallback';
  /** Approval policy for BOMs proposed under this mode */
  approval_policy: 'always-ask' | 'auto-unless-flagged' | 'fully-auto';
  /** Routing table: capability tag → ordered list of preferred models */
  routing: Record<CapabilityTag, string[]>;
  /** Steward's own brain (the model that produces plans) for this mode */
  steward_brain: string;
}

/**
 * Default profile configurations. Land into profile_config table on init.
 * Routing tables list models in preference order — first available wins.
 */
export const DEFAULT_PROFILES: Record<ProfileMode, ProfileConfig> = {
  turbo: {
    label: 'Turbo',
    description: 'Best model for every step. No cost cap. Re-plans up on failure.',
    budget_daily_soft_usd: 50,
    budget_daily_hard_usd: Infinity,
    budget_per_job_soft_usd: 5,
    on_capability_miss: 'auto-promote',
    approval_policy: 'fully-auto',
    routing: {
      'reading':              ['claude-haiku-4', 'gemini-2.5-flash'],
      'cheap-classifier':     ['claude-haiku-4', 'claude-sonnet-4.8'],
      'code-execution':       ['claude-sonnet-4.8', 'claude-opus-4.8'],
      'code-reasoning':       ['claude-opus-4.8', 'gpt-5.5'],
      'long-context':         ['gemini-2.5-pro', 'claude-opus-4.8'],
      'multimodal-vision':    ['claude-opus-4.8', 'gemini-2.5-pro'],
      'multimodal-audio':     ['gemini-2.5-pro'],
      'tool-use-heavy':       ['claude-opus-4.8', 'claude-sonnet-4.8'],
      'simple-summary':       ['claude-haiku-4', 'llama-3.1-8b'],
      'no-model':             [],
    },
    steward_brain: 'claude-opus-4.8',
  },

  balanced: {
    label: 'Balanced',
    description: 'Cheapest model that fits each step. Promotes on failure. Default mode.',
    budget_daily_soft_usd: 20,
    budget_daily_hard_usd: 40,
    budget_per_job_soft_usd: 0.50,
    on_capability_miss: 'auto-promote',
    approval_policy: 'auto-unless-flagged',
    routing: {
      'reading':              ['claude-haiku-4', 'llama-3.1-8b', 'claude-sonnet-4.8'],
      'cheap-classifier':     ['llama-3.1-8b', 'claude-haiku-4'],
      'code-execution':       ['claude-sonnet-4.8', 'claude-opus-4.8'],
      'code-reasoning':       ['claude-opus-4.8', 'gpt-5.5'],
      'long-context':         ['gemini-2.5-flash', 'claude-sonnet-4.8'],
      'multimodal-vision':    ['claude-sonnet-4.8', 'gemini-2.5-flash'],
      'multimodal-audio':     ['gemini-2.5-flash'],
      'tool-use-heavy':       ['claude-sonnet-4.8', 'claude-opus-4.8'],
      'simple-summary':       ['llama-3.1-8b', 'claude-haiku-4'],
      'no-model':             [],
    },
    steward_brain: 'claude-sonnet-4.8',
  },

  eco: {
    label: 'Eco',
    description: 'Local AI first. Refuses paid calls without your nod. Cheapest possible.',
    budget_daily_soft_usd: 5,
    budget_daily_hard_usd: 10,
    budget_per_job_soft_usd: 0.10,
    on_capability_miss: 'refuse-notify',
    approval_policy: 'always-ask',
    routing: {
      'reading':              ['llama-3.1-8b', 'mistral-local', 'claude-haiku-4'],
      'cheap-classifier':     ['llama-3.1-8b', 'mistral-local'],
      'code-execution':       ['llama-3.1-70b', 'claude-haiku-4'],
      'code-reasoning':       ['llama-3.1-70b'], // refuse if not enough; user override needed
      'long-context':         ['llama-3.1-70b'],
      'multimodal-vision':    ['claude-haiku-4'], // local vision still poor; cheapest cloud
      'multimodal-audio':     [],
      'tool-use-heavy':       ['llama-3.1-70b'],
      'simple-summary':       ['llama-3.1-8b'],
      'no-model':             [],
    },
    steward_brain: 'claude-haiku-4', // cheap planning, local would be too dumb to plan well
  },
};

// ============================================================
// BOM (Bill of Materials) — the planning artifact
// ============================================================

export interface BomStep {
  step_no: number;
  title: string;
  description?: string;
  capability: CapabilityTag;
  risk_class: RiskClass;
  /** Which brick handles this step — must match a row in connectors table OR be 'steward' / 'cc' */
  brick_id: string;
  /** Model assigned by the planner */
  model: string;
  /** Estimated cost in USD for this step alone */
  cost_estimate: number;
  duration_sec_est: number;
  /** Step numbers that must complete before this one */
  depends_on: number[];
}

export interface BomVersion {
  bom_id: string;
  version: number;
  reason: 'initial' | 'replan_on_failure' | 'manual_edit' | 'capability_escalation';
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
  status: 'proposed' | 'approved' | 'running' | 'done' | 'failed' | 'cancelled' | 'rejected';
  active_version: number;
  cost_estimate: number;
  cost_max: number;
  duration_sec: number;
  cost_actual: number;
  steps_done: number;
  steps_total: number;
  profile_mode: ProfileMode;
  scope_id?: string;
  /** Union of all step risk classes — used to compute scope envelope on approval */
  risk_envelope: RiskClass[];
  proposed_at: string;
  approved_at?: string;
  started_at?: string;
  ended_at?: string;
  is_draft: boolean;
}

// ============================================================
// EVENT KINDS — additions to src/event-types.ts
// ============================================================

/**
 * Merge these into the existing event-types Zod enum.
 * Each event has its own payload schema below.
 */
export const BOM_EVENT_KINDS = [
  // Lifecycle
  'bom_proposed',           // Planner produced a new BOM; awaits approval
  'bom_approved',           // User approved; trust scope opens
  'bom_rejected',           // User rejected; BOM goes to draft or dies
  'bom_cancelled',          // Approved BOM cancelled mid-flight by user
  'bom_completed',          // All steps done successfully
  'bom_failed',             // Unrecoverable failure across steps
  // Versioning
  'bom_replanned',          // Failure or escalation triggered a new version
  'bom_edited',             // User manually modified the plan before approval
  // Step lifecycle
  'bom_step_started',
  'bom_step_progress',
  'bom_step_completed',
  'bom_step_failed',
  'bom_step_skipped',
  // Capability / model decisions
  'bom_step_promoted',      // Capability miss: cheaper model failed, promoted to next tier
  // Profile / mode
  'profile_mode_switched',  // User flipped Turbo/Balanced/Eco
] as const;

export type BomEventKind = typeof BOM_EVENT_KINDS[number];

// Payload shapes — extend the Zod schema in event-types.ts accordingly

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
  scope_id: string;          // The trust scope that just opened
  approver: string;          // session_id of who clicked approve
}

export interface PayloadBomStepStarted {
  bom_id: string;
  version: number;
  step_no: number;
  worker_id: string;
  model: string;
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
  /** Whether the steward will auto-replan or hand back to user */
  will_replan: boolean;
}

export interface PayloadBomReplanned {
  bom_id: string;
  from_version: number;
  to_version: number;
  reason: BomVersion['reason'];
  trigger_step?: number;
}

export interface PayloadProfileModeSwitched {
  from_mode: ProfileMode;
  to_mode: ProfileMode;
  switched_by: string;       // 'user' | 'system_boot' | 'budget_breach' | session_id
  reason?: string;
}

// ============================================================
// NO-GO LIST entry shape
// ============================================================

export interface NoGoRule {
  id: string;
  action_pattern: string;     // glob-style pattern matched against tool name or command
  risk_class: RiskClass;
  reason: string;             // human-readable, shown in approval card
  source: 'default' | 'user' | 'organization';
  enabled: boolean;
}

/**
 * Match an action against the no-go list. Returns the matching rule or null.
 * Patterns support * wildcard only (glob simplified).
 */
export function matchNoGo(
  rules: NoGoRule[],
  action: { tool_name?: string; command?: string; risk_class: RiskClass }
): NoGoRule | null {
  const target = action.tool_name ?? action.command ?? '';
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (rule.risk_class !== action.risk_class) continue;
    if (matchGlob(rule.action_pattern, target)) return rule;
  }
  return null;
}

function matchGlob(pattern: string, target: string): boolean {
  // Simple glob: * matches any chars (greedy). Convert to regex.
  const re = '^' + pattern.split('*').map(escapeRegex).join('.*') + '$';
  return new RegExp(re).test(target);
}

function escapeRegex(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}
