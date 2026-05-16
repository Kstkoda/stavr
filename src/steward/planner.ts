// src/steward/planner.ts
//
// The Steward's planning loop. Sits alongside the existing reactive loop in
// src/steward/loop.ts. The reactive loop handles direct prompts; this planner
// is invoked when an MCP client calls `propose_plan` with a goal.
//
// Lifecycle:
//   1. propose_plan(goal) -> StewardPlanner.proposePlan -> BOM persisted ->
//      bom_proposed event
//   2. User approves via decision flow -> framework creates trust scope ->
//      bom_approved event
//   3. BomExecutor (src/steward/executor.ts) reads approved BOMs and
//      dispatches workers per step under the scope
//   4. Step failures trigger StewardPlanner.replan with failure context
//
// The module is gated by `experimental.planner` in the stavr config. The
// daemon should not instantiate this class when the flag is false.

import { randomUUID } from 'node:crypto';

import type {
  Bom,
  BomStep,
  BomVersion,
  CapabilityTag,
  PayloadBomProposed,
  PayloadBomReplanned,
  ProfileConfig,
  ProfileMode,
  RiskClass,
} from '../types/stavr-bom.js';
import { DEFAULT_PROFILES } from '../types/stavr-bom.js';

// ============================================================
// DEPENDENCIES (kept minimal so the planner is unit-testable)
// ============================================================

/** Append an event to the broker's audit log + fanout. */
export interface PlannerEventEmitter {
  publish(kind: string, payload: unknown, correlationId?: string): Promise<void>;
}

/** Persistence surface the planner needs. */
export interface BomStore {
  saveBom(bom: Bom): void;
  saveBomVersion(version: BomVersion): void;
  saveBomSteps(bomId: string, version: number, steps: BomStep[]): void;
  getBom(id: string): Bom | undefined;
  getActiveVersion(bomId: string): BomVersion | undefined;
  setActiveVersion(bomId: string, version: number): void;
  updateBomStatus(bomId: string, patch: Partial<Bom>): void;
}

export interface PlannerLlmCall {
  model: string;
  system: string;
  user: string;
}

export interface PlannerLlmResult {
  text: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
}

/** Abstract LLM call — wrap the real provider in the daemon. */
export type PlannerLlm = (call: PlannerLlmCall) => Promise<PlannerLlmResult>;

// ============================================================
// PUBLIC API
// ============================================================

export interface ProposePlanArgs {
  goal: string;
  /** Originating session for correlation across event stream. */
  correlationId: string;
  /** Optional caller-side capability tags (saves the planner a classifier step). */
  capabilityHints?: Record<string, CapabilityTag>;
  /** Override the active profile for this single plan (e.g., one-shot Turbo). */
  profileOverride?: ProfileMode;
  /** Connector capabilities visible to the planner. */
  availableCapabilities: PlannerAvailableCapability[];
  /** Requester identity (session id, worker id). Defaults to correlation id. */
  requester?: string;
}

export interface PlannerAvailableCapability {
  connectorId: string;
  capabilityId: string;
  description: string;
  capabilityTag: CapabilityTag;
  riskClass: RiskClass;
}

export interface ReplanArgs {
  bomId: string;
  triggerStepNo: number;
  errorMessage: string;
  failedCapability: CapabilityTag;
  failedModel: string;
}

export type RawPlannerStep = Omit<
  BomStep,
  'step_no' | 'model' | 'cost_estimate' | 'duration_sec_est'
>;

// ============================================================
// PLANNER
// ============================================================

export class StewardPlanner {
  constructor(
    private readonly events: PlannerEventEmitter,
    private readonly db: BomStore,
    private readonly llm: PlannerLlm,
    private readonly getActiveProfile: () => ProfileMode,
  ) {}

  /**
   * Generate a BOM for the given goal under the active (or overridden)
   * profile. Persists the BOM as 'proposed', persists the initial version,
   * emits `bom_proposed`. Returns the BOM id.
   */
  async proposePlan(args: ProposePlanArgs): Promise<{ bomId: string }> {
    const profileMode = args.profileOverride ?? this.getActiveProfile();
    const profile = DEFAULT_PROFILES[profileMode];

    const planResult = await this.callPlannerLlm(args, profile);
    const rawSteps = planResult.steps;

    const steps: BomStep[] = rawSteps.map((s, i) => this.assignModel(s, i + 1, profile));

    const costEstimate = steps.reduce((sum, s) => sum + s.cost_estimate, 0);
    const costMax = round(costEstimate * 1.5, 4);
    const durationSec = criticalPathDuration(steps);
    const riskEnvelope = uniqueRiskClasses(steps);
    const bomId = `bom_${randomUUID().slice(0, 12)}`;
    const proposedAt = new Date().toISOString();

    const bom: Bom = {
      id: bomId,
      goal: args.goal,
      requester: args.requester ?? args.correlationId,
      correlation_id: args.correlationId,
      status: 'proposed',
      active_version: 1,
      cost_estimate: round(costEstimate, 4),
      cost_max: costMax,
      duration_sec: durationSec,
      cost_actual: 0,
      steps_done: 0,
      steps_total: steps.length,
      profile_mode: profileMode,
      risk_envelope: riskEnvelope,
      proposed_at: proposedAt,
      is_draft: false,
    };

    this.db.saveBom(bom);
    this.db.saveBomVersion({
      bom_id: bomId,
      version: 1,
      reason: 'initial',
      steps,
      planner_model: profile.steward_brain,
      planner_cost: planResult.cost,
      created_at: proposedAt,
    });
    this.db.saveBomSteps(bomId, 1, steps);

    const payload: PayloadBomProposed = {
      bom_id: bomId,
      version: 1,
      goal: args.goal,
      steps_count: steps.length,
      cost_estimate: bom.cost_estimate,
      cost_max: bom.cost_max,
      duration_sec_est: durationSec,
      risk_envelope: riskEnvelope,
      profile_mode: profileMode,
      planner_model: profile.steward_brain,
    };
    await this.events.publish('bom_proposed', payload, args.correlationId);

    return { bomId };
  }

  /**
   * Produce a new version of an existing BOM after a step failure. The
   * planner gets the failure context and tries to find an alternative path.
   * Strategy: promote model tier, swap to alternative tool, or split the
   * step. If the new envelope escapes the original, the executor pauses
   * for user approval (handled at the executor layer).
   */
  async replan(args: ReplanArgs): Promise<{ newVersion: number; willEscalateRiskClass: boolean }> {
    const bom = this.db.getBom(args.bomId);
    if (!bom) throw new Error(`BOM ${args.bomId} not found`);

    const previousVersion = this.db.getActiveVersion(args.bomId);
    if (!previousVersion) throw new Error(`BOM ${args.bomId} has no active version`);

    const profile = DEFAULT_PROFILES[bom.profile_mode];
    const planResult = await this.callPlannerLlmForReplan({
      bom,
      previousVersion,
      failedStepNo: args.triggerStepNo,
      errorMessage: args.errorMessage,
      profile,
    });

    const newVersion = bom.active_version + 1;
    const steps: BomStep[] = planResult.steps.map((s, i) =>
      this.assignModel(s, i + 1, profile, args.failedCapability),
    );

    const newEnvelope = uniqueRiskClasses(steps);
    const originalEnvelope = new Set(bom.risk_envelope);
    const willEscalateRiskClass = newEnvelope.some((rc) => !originalEnvelope.has(rc));

    const createdAt = new Date().toISOString();
    this.db.saveBomVersion({
      bom_id: args.bomId,
      version: newVersion,
      reason: 'replan_on_failure',
      replan_trigger_step: args.triggerStepNo,
      steps,
      planner_model: profile.steward_brain,
      planner_cost: planResult.cost,
      created_at: createdAt,
    });
    this.db.saveBomSteps(args.bomId, newVersion, steps);

    if (!willEscalateRiskClass) {
      this.db.setActiveVersion(args.bomId, newVersion);
    }

    const replanPayload: PayloadBomReplanned = {
      bom_id: args.bomId,
      from_version: bom.active_version,
      to_version: newVersion,
      reason: 'replan_on_failure',
      trigger_step: args.triggerStepNo,
    };
    await this.events.publish('bom_replanned', replanPayload, bom.correlation_id);

    return { newVersion, willEscalateRiskClass };
  }

  // ============================================================
  // INTERNAL — LLM calls
  // ============================================================

  private async callPlannerLlm(
    args: ProposePlanArgs,
    profile: ProfileConfig,
  ): Promise<{ steps: RawPlannerStep[]; cost: number }> {
    const system = [
      'You are the stavr Steward planner. Given a goal and the available capabilities,',
      'produce a numbered Bill of Materials (BOM) of 1-12 steps. Each step has:',
      '  title (short), description (one sentence),',
      "  capability (one of: 'reading', 'cheap-classifier', 'code-execution', 'code-reasoning', 'long-context', 'multimodal-vision', 'multimodal-audio', 'tool-use-heavy', 'simple-summary', 'no-model', 'local-classifier', 'local-reasoning', 'local-summary', 'local-reading' — prefer the 'local-*' variants when a step is trivially eligible for a small local LLM),",
      "  risk_class (one of: 'read-only', 'write-local', 'write-remote', 'execute', 'external-comm', 'financial', 'credential', 'destructive'),",
      "  brick_id (must match one of the available capabilities' connectorId, or 'steward' / 'cc' for internal),",
      '  depends_on (array of prior step numbers; empty for sequential).',
      'Respond ONLY as JSON: { "steps": [...] }. No prose, no markdown fences.',
      `Active profile: ${profile.label} — ${profile.description}`,
    ].join('\n');

    const userMsg = [
      `Goal: ${args.goal}`,
      '',
      'Available capabilities (connectorId : capabilityId : description : tag : risk):',
      ...args.availableCapabilities.map(
        (c) =>
          `  ${c.connectorId} : ${c.capabilityId} : ${c.description} : ${c.capabilityTag} : ${c.riskClass}`,
      ),
    ].join('\n');

    const completion = await this.llm({
      model: profile.steward_brain,
      system,
      user: userMsg,
    });

    const steps = parsePlannerJson(completion.text);
    return { steps, cost: completion.cost_usd };
  }

  private async callPlannerLlmForReplan(args: {
    bom: Bom;
    previousVersion: BomVersion;
    failedStepNo: number;
    errorMessage: string;
    profile: ProfileConfig;
  }): Promise<{ steps: RawPlannerStep[]; cost: number }> {
    const system = [
      'You are the stavr Steward replanner. A step in an active BOM has failed.',
      'Produce a new plan that recovers. Prefer: promote model tier, retry with',
      "different tool, split the step. If recovery requires a risk class not in the",
      'original envelope, include it — the framework will ask for approval.',
      'Respond ONLY as JSON: { "steps": [...] }. No prose.',
    ].join('\n');

    const userMsg = [
      `Goal: ${args.bom.goal}`,
      `Failed step: ${args.failedStepNo} of ${args.previousVersion.steps.length}`,
      `Error: ${args.errorMessage}`,
      `Original plan: ${JSON.stringify(args.previousVersion.steps, null, 2)}`,
    ].join('\n');

    const completion = await this.llm({
      model: args.profile.steward_brain,
      system,
      user: userMsg,
    });

    const steps = parsePlannerJson(completion.text);
    return { steps, cost: completion.cost_usd };
  }

  private assignModel(
    rawStep: RawPlannerStep,
    stepNo: number,
    profile: ProfileConfig,
    skipFirstModelFor?: CapabilityTag,
  ): BomStep {
    const preferenceList = profile.routing[rawStep.capability] ?? [];
    let model = preferenceList[0] ?? profile.steward_brain;

    if (skipFirstModelFor === rawStep.capability && preferenceList.length > 1) {
      model = preferenceList[1] ?? preferenceList[0] ?? profile.steward_brain;
    }

    return {
      ...rawStep,
      step_no: stepNo,
      model,
      cost_estimate: estimateStepCost(model, rawStep.capability),
      duration_sec_est: estimateStepDuration(rawStep.capability),
    };
  }
}

// ============================================================
// HELPERS
// ============================================================

/**
 * Parse a planner LLM response. Strips common formatting noise (markdown
 * fences, leading prose) before JSON.parse so the planner is robust to small
 * formatting drift.
 */
export function parsePlannerJson(text: string): RawPlannerStep[] {
  const cleaned = stripJsonFences(text).trim();
  const parsed = JSON.parse(cleaned) as { steps?: unknown };
  if (!Array.isArray(parsed.steps)) {
    throw new Error('planner response missing "steps" array');
  }
  return parsed.steps as RawPlannerStep[];
}

function stripJsonFences(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  if (fenced) return fenced[1] ?? text;
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return text.slice(firstBrace, lastBrace + 1);
  }
  return text;
}

function round(n: number, decimals: number): number {
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}

function uniqueRiskClasses(steps: BomStep[]): RiskClass[] {
  return Array.from(new Set(steps.map((s) => s.risk_class)));
}

/** Longest path through the DAG induced by `depends_on`. */
export function criticalPathDuration(steps: BomStep[]): number {
  if (steps.length === 0) return 0;
  const byNo = new Map<number, BomStep>(steps.map((s) => [s.step_no, s]));
  const memo = new Map<number, number>();
  const visiting = new Set<number>();

  const compute = (stepNo: number): number => {
    if (memo.has(stepNo)) return memo.get(stepNo)!;
    if (visiting.has(stepNo)) return 0;
    const step = byNo.get(stepNo);
    if (!step) return 0;
    visiting.add(stepNo);
    const depMax = step.depends_on.length
      ? Math.max(0, ...step.depends_on.map(compute))
      : 0;
    const total = depMax + step.duration_sec_est;
    visiting.delete(stepNo);
    memo.set(stepNo, total);
    return total;
  };

  return Math.max(...steps.map((s) => compute(s.step_no)));
}

/**
 * Heuristic step cost in USD. Replace with a real per-model price table once
 * the executor records actuals. Good enough for v1 to drive the food-label
 * approval card.
 */
export function estimateStepCost(model: string, capability: CapabilityTag): number {
  const tokensInOut =
    capability === 'long-context' ? [40000, 4000] :
    capability === 'code-reasoning' ? [8000, 2000] :
    capability === 'code-execution' ? [4000, 1500] :
    capability === 'cheap-classifier' ? [800, 200] :
    capability === 'reading' ? [2000, 200] :
    capability === 'multimodal-vision' ? [6000, 1000] :
    capability === 'tool-use-heavy' ? [6000, 2500] :
    capability === 'simple-summary' ? [1500, 400] :
    capability === 'local-classifier' ? [800, 200] :
    capability === 'local-reasoning' ? [4000, 1000] :
    capability === 'local-summary' ? [1500, 400] :
    capability === 'local-reading' ? [2000, 200] :
    [1500, 500];
  const pricePer1k: Record<string, [number, number]> = {
    'claude-opus-4-7': [0.015, 0.075],
    'claude-sonnet-4-6': [0.003, 0.015],
    'claude-haiku-4-5': [0.0008, 0.004],
    // Local Ollama models — zero per-token cost. The local-runtime power +
    // wall-clock cost is real but not USD-billable, and the dashboard's
    // "wattage" card (v0.5) will track it separately.
    'llama3.2:3b': [0, 0],
    'llama3.3:8b': [0, 0],
    'phi3:mini': [0, 0],
    'deepseek-r1:32b': [0, 0],
    // Legacy placeholders kept for backwards compat with seeded BOMs.
    'llama-3.1-8b': [0, 0],
    'llama-3.1-70b': [0, 0],
  };
  // Local models lookup falls through to zero so any unknown `family:tag`
  // shape produces $0 instead of a wrong frontier estimate.
  const fallback: [number, number] = model.startsWith('claude-') ? [0.003, 0.015] : [0, 0];
  const [pIn, pOut] = pricePer1k[model] ?? fallback;
  return (tokensInOut[0] / 1000) * pIn + (tokensInOut[1] / 1000) * pOut;
}

export function estimateStepDuration(capability: CapabilityTag): number {
  switch (capability) {
    case 'reading':
      return 15;
    case 'cheap-classifier':
      return 5;
    case 'code-execution':
      return 60;
    case 'code-reasoning':
      return 90;
    case 'long-context':
      return 45;
    case 'multimodal-vision':
      return 30;
    case 'multimodal-audio':
      return 60;
    case 'tool-use-heavy':
      return 120;
    case 'simple-summary':
      return 10;
    case 'no-model':
      return 30;
    case 'local-classifier':
      return 8; // local 3B model: a touch slower than haiku on CPU-only hosts
    case 'local-reasoning':
      return 30;
    case 'local-summary':
      return 12;
    case 'local-reading':
      return 18;
  }
}
