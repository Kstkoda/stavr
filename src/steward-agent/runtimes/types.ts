// v0.5 P2 — Uniform Model Runtime interface.
//
// ADR-032 §Decision 3. Replaces the single-method `StewardProvider.complete()`
// generator with three typed methods (plan/decide/summarize), each returning
// a Zod-validated output. Provider quirks normalize inside each implementation
// so the planner (P3 / loop.ts) is one call site per task kind, not three
// branching per-provider call sites.
//
// Live concrete runtimes: AnthropicRuntime, OpenAIRuntime, OllamaRuntime.
// Each is a thin wrapper over the existing src/steward/providers/* generators
// with output validation + retry layered in (ADR-032 §Decision 5).

import type { CapabilityTag, RiskClass, ProfileMode } from '../../types/stavr-bom.js';

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface RuntimeUsage {
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export interface PlanCtx {
  goal: string;
  correlation_id?: string;
  profile_mode: ProfileMode;
  /** Active lessons surfaced into the prompt (Lessons store). */
  lessons?: Array<{ id: string; title: string; body: string }>;
  /** Working memory keys + values the planner should see this call. */
  working_memory?: Record<string, unknown>;
  /** Optional max-tokens hint; runtime decides actual ceiling. */
  max_tokens?: number;
}

export interface PlannedStep {
  step_no: number;
  title: string;
  description?: string;
  capability: CapabilityTag;
  risk_class: RiskClass;
  brick_id: string;
  model: string;
  cost_estimate: number;
  duration_sec_est: number;
  depends_on: number[];
}

export interface ValidatedBOM {
  goal: string;
  steps: PlannedStep[];
  cost_estimate: number;
  cost_max: number;
  duration_sec_est: number;
  risk_envelope: RiskClass[];
  planner_notes?: string;
  usage: RuntimeUsage;
}

export interface DecideReq {
  question: string;
  options: Array<{ id: string; label: string; rationale?: string }>;
  context?: string;
  correlation_id?: string;
}

export interface ValidatedChoice {
  chosen_option_id: string;
  reason: string;
  confidence: number;
  usage: RuntimeUsage;
}

export interface EpisodicEvent {
  at: string;
  kind: string;
  correlation_id?: string | null;
  summary: string;
}

export interface ValidatedDigest {
  summary: string;
  highlights: string[];
  recommendations: string[];
  usage: RuntimeUsage;
}

/**
 * Sentinel returned when 3× retry exhausts on schema validation. Callers
 * surface this as a Decision card via the existing decisions infrastructure
 * rather than crashing the loop (ADR-032 §Decision 5).
 */
export interface ValidationFailure {
  __kind: 'validation_failure';
  runtime: string;
  task_kind: 'plan' | 'decide' | 'summarize';
  last_error: string;
  attempts: number;
  raw_last_output?: string;
}

export function isValidationFailure(v: unknown): v is ValidationFailure {
  return !!v && typeof v === 'object' && (v as { __kind?: string }).__kind === 'validation_failure';
}

export interface ModelRuntime {
  readonly name: string;
  readonly costPerKtoken: { in: number; out: number };
  readonly contextWindow: number;
  plan(ctx: PlanCtx, tools: ToolSpec[]): Promise<ValidatedBOM | ValidationFailure>;
  decide(req: DecideReq): Promise<ValidatedChoice | ValidationFailure>;
  summarize(events: EpisodicEvent[]): Promise<ValidatedDigest | ValidationFailure>;
}

/** Per-task runtime override map persisted in prefs.db. */
export type TaskKind = 'plan' | 'decide' | 'summarize';
export type TaskRuntimeOverrides = Partial<Record<TaskKind, string>>;
