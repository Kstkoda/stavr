// steward-planner.ts — proposed planning loop for the Steward
//
// Sits alongside the existing reactive loop in src/steward/loop.ts.
// The reactive loop stays for direct prompts; this planner is invoked when
// someone calls the new MCP tool `propose_plan` with a goal.
//
// Lifecycle:
//   1. propose_plan(goal) -> planner runs -> BOM persisted -> bom_proposed event
//   2. User approves via existing decision flow -> bom_approved event ->
//      trust scope created from BOM's risk envelope
//   3. Executor (separate module, follow-up PR) reads approved BOMs and
//      dispatches workers per step under the scope
//   4. Step failures trigger replan via this planner with the failure context
//
// This file is a skeleton — the LLM call to produce a plan is stubbed.
// Wire it to the existing provider abstraction in src/steward/provider.ts.

import type {
  Bom,
  BomStep,
  BomVersion,
  RiskClass,
  CapabilityTag,
  ProfileMode,
  ProfileConfig,
  PayloadBomProposed,
  PayloadBomReplanned,
} from './types';
import { DEFAULT_PROFILES, ALWAYS_GATED_CLASSES } from './types';

// Replace these with actual stavr imports:
type EventEmitter = { emit(kind: string, payload: unknown): Promise<void> };
type Persistence = {
  saveBom(bom: Bom): Promise<void>;
  saveBomVersion(version: BomVersion): Promise<void>;
  getBom(id: string): Promise<Bom | null>;
  getActiveVersion(bomId: string): Promise<BomVersion | null>;
};
type LlmProvider = {
  complete(args: {
    model: string;
    system: string;
    messages: { role: 'user' | 'assistant'; content: string }[];
    response_format?: 'json' | 'text';
  }): Promise<{ text: string; tokens_in: number; tokens_out: number; cost: number }>;
};

// ============================================================
// PUBLIC API
// ============================================================

export interface ProposePlanArgs {
  goal: string;
  /** Originating session for correlation */
  correlationId: string;
  /** Optional capability hints from the caller (saves the planner a step) */
  capabilityHints?: Partial<Record<string, CapabilityTag>>;
  /** Override the active profile for this plan (e.g. one-shot Turbo) */
  profileOverride?: ProfileMode;
  /** Available connector capabilities — the "art of the possible" */
  availableCapabilities: Array<{ connectorId: string; capabilityId: string; description: string; capabilityTag: CapabilityTag; riskClass: RiskClass }>;
}

export interface ReplanArgs {
  bomId: string;
  triggerStepNo: number;
  errorMessage: string;
  /** What capability tier the failed step was assigned. The replan tries next. */
  failedCapability: CapabilityTag;
  failedModel: string;
}

export class StewardPlanner {
  constructor(
    private events: EventEmitter,
    private db: Persistence,
    private llm: LlmProvider,
    private getActiveProfile: () => ProfileMode
  ) {}

  /**
   * Generate a BOM for the given goal under the active profile.
   * Persists the BOM as 'proposed' (and is_draft=false) and emits bom_proposed.
   * Returns the BOM id so the caller can surface a link to the approval UI.
   */
  async proposePlan(args: ProposePlanArgs): Promise<{ bomId: string }> {
    const profileMode = args.profileOverride ?? this.getActiveProfile();
    const profile = DEFAULT_PROFILES[profileMode];

    // 1. Call the planner LLM to produce a structured plan
    const planResult = await this.callPlannerLlm(args, profile);

    // 2. Assign models per step based on profile's routing table
    const steps = planResult.steps.map((s, i) => this.assignModel(s, i + 1, profile));

    // 3. Compute aggregates
    const costEstimate = steps.reduce((sum, s) => sum + s.cost_estimate, 0);
    const costMax = costEstimate * 1.5; // safety margin: worst case if everything promotes
    const durationSec = Math.max(...stepsWithDeps(steps).map(s => s.cumulativeDuration)); // longest path
    const riskEnvelope = uniqueRiskClasses(steps);

    // 4. Construct the BOM and persist as version 1
    const bomId = `bom_${randomId()}`;
    const bom: Bom = {
      id: bomId,
      goal: args.goal,
      requester: args.correlationId,
      correlation_id: args.correlationId,
      status: 'proposed',
      active_version: 1,
      cost_estimate: round(costEstimate, 2),
      cost_max: round(costMax, 2),
      duration_sec: durationSec,
      cost_actual: 0,
      steps_done: 0,
      steps_total: steps.length,
      profile_mode: profileMode,
      risk_envelope: riskEnvelope,
      proposed_at: new Date().toISOString(),
      is_draft: false,
    };

    await this.db.saveBom(bom);
    await this.db.saveBomVersion({
      bom_id: bomId,
      version: 1,
      reason: 'initial',
      steps,
      planner_model: profile.steward_brain,
      planner_cost: planResult.cost,
      created_at: bom.proposed_at,
    });

    // 5. Emit bom_proposed for the dashboard/UI to render the approval card
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
    await this.events.emit('bom_proposed', payload);

    return { bomId };
  }

  /**
   * Produce a new version of an existing BOM after a step failure.
   * The planner gets the failure context and tries to find an alternative path.
   * Common strategies: promote model tier, swap to alternative tool, split step.
   */
  async replan(args: ReplanArgs): Promise<{ newVersion: number; willEscalateRiskClass: boolean }> {
    const bom = await this.db.getBom(args.bomId);
    if (!bom) throw new Error(`BOM ${args.bomId} not found`);

    const profile = DEFAULT_PROFILES[bom.profile_mode];
    const previousVersion = await this.db.getActiveVersion(args.bomId);
    if (!previousVersion) throw new Error(`BOM ${args.bomId} has no active version`);

    // Call planner with failure context
    const planResult = await this.callPlannerLlmForReplan({
      bom,
      previousVersion,
      failedStepNo: args.triggerStepNo,
      errorMessage: args.errorMessage,
      profile,
    });

    const newVersion = bom.active_version + 1;
    const steps = planResult.steps.map((s, i) => this.assignModel(s, i + 1, profile, args.failedCapability));

    // Detect if any step now requires a risk class beyond the original envelope
    const newEnvelope = uniqueRiskClasses(steps);
    const originalEnvelope = new Set(bom.risk_envelope);
    const willEscalateRiskClass = newEnvelope.some(rc => !originalEnvelope.has(rc));

    await this.db.saveBomVersion({
      bom_id: args.bomId,
      version: newVersion,
      reason: 'replan_on_failure',
      replan_trigger_step: args.triggerStepNo,
      steps,
      planner_model: profile.steward_brain,
      planner_cost: planResult.cost,
      created_at: new Date().toISOString(),
    });

    // Update BOM active_version pointer (caller decides; if escalating risk, may pause)
    if (!willEscalateRiskClass) {
      // Re-plan stays within authorized envelope → continue automatically
      // bom.active_version = newVersion (executor will pick up)
    } else {
      // Re-plan needs new approval — emit decision_request via framework
      // (handled in the executor layer, not here)
    }

    const replanPayload: PayloadBomReplanned = {
      bom_id: args.bomId,
      from_version: bom.active_version,
      to_version: newVersion,
      reason: 'replan_on_failure',
      trigger_step: args.triggerStepNo,
    };
    await this.events.emit('bom_replanned', replanPayload);

    return { newVersion, willEscalateRiskClass };
  }

  // ============================================================
  // INTERNAL — LLM call to produce the plan
  // ============================================================

  private async callPlannerLlm(
    args: ProposePlanArgs,
    profile: ProfileConfig
  ): Promise<{ steps: Array<Omit<BomStep, 'step_no' | 'model' | 'cost_estimate' | 'duration_sec_est'>>; cost: number }> {
    // Build the planner prompt — keep it terse, ask for JSON.
    const system = [
      'You are the stavr Steward planner. Given a goal and the available capabilities,',
      'produce a numbered Bill of Materials (BOM) of 1-12 steps. Each step has:',
      '  title (short), description (one sentence), capability (one of: reading, cheap-classifier, code-execution, code-reasoning, long-context, multimodal-vision, multimodal-audio, tool-use-heavy, simple-summary, no-model),',
      '  risk_class (one of: read-only, write-local, write-remote, execute, external-comm, financial, credential, destructive),',
      '  brick_id (which connector handles it — must match one of the available capabilities below, or "steward" for internal),',
      '  depends_on (array of prior step numbers; empty for sequential).',
      'Respond as JSON: { "steps": [...] }. No commentary.',
      `Active profile: ${profile.label} — ${profile.description}`,
    ].join('\n');

    const userMsg = [
      `Goal: ${args.goal}`,
      '',
      'Available capabilities (brick_id : capability_id : description : tag : risk):',
      ...args.availableCapabilities.map(c =>
        `  ${c.connectorId} : ${c.capabilityId} : ${c.description} : ${c.capabilityTag} : ${c.riskClass}`
      ),
    ].join('\n');

    const completion = await this.llm.complete({
      model: profile.steward_brain,
      system,
      messages: [{ role: 'user', content: userMsg }],
      response_format: 'json',
    });

    const parsed = JSON.parse(completion.text) as { steps: Array<Omit<BomStep, 'step_no' | 'model' | 'cost_estimate' | 'duration_sec_est'>> };
    return { steps: parsed.steps, cost: completion.cost };
  }

  private async callPlannerLlmForReplan(args: {
    bom: Bom;
    previousVersion: BomVersion;
    failedStepNo: number;
    errorMessage: string;
    profile: ProfileConfig;
  }): Promise<{ steps: Array<Omit<BomStep, 'step_no' | 'model' | 'cost_estimate' | 'duration_sec_est'>>; cost: number }> {
    const system = [
      'You are the stavr Steward replanner. A step in an active BOM has failed.',
      'Produce a new plan that recovers. Prefer: promote model tier, retry with different tool, split the step.',
      'If the recovery requires a risk class not in the original envelope, include it — the framework will ask for approval.',
      'Respond as JSON: { "steps": [...] }.',
    ].join('\n');

    const userMsg = [
      `Goal: ${args.bom.goal}`,
      `Failed step: ${args.failedStepNo} of ${args.previousVersion.steps.length}`,
      `Error: ${args.errorMessage}`,
      `Original plan: ${JSON.stringify(args.previousVersion.steps, null, 2)}`,
    ].join('\n');

    const completion = await this.llm.complete({
      model: args.profile.steward_brain,
      system,
      messages: [{ role: 'user', content: userMsg }],
      response_format: 'json',
    });

    const parsed = JSON.parse(completion.text) as { steps: Array<Omit<BomStep, 'step_no' | 'model' | 'cost_estimate' | 'duration_sec_est'>> };
    return { steps: parsed.steps, cost: completion.cost };
  }

  // ============================================================
  // INTERNAL — assign model + estimates per step from profile routing
  // ============================================================

  private assignModel(
    rawStep: Omit<BomStep, 'step_no' | 'model' | 'cost_estimate' | 'duration_sec_est'>,
    stepNo: number,
    profile: ProfileConfig,
    skipFirstModel?: CapabilityTag // when replanning, skip the failed tier
  ): BomStep {
    const preferenceList = profile.routing[rawStep.capability] ?? [];
    let model = preferenceList[0] ?? 'claude-sonnet-4.8'; // safe fallback

    if (skipFirstModel === rawStep.capability && preferenceList.length > 1) {
      // Replan: skip the tier that just failed, pick the next one
      model = preferenceList[1] ?? preferenceList[0];
    }

    // Cost estimate is a rough model × token heuristic. Real implementation
    // should consult a per-model price table; this is good enough for v1.
    const costEstimate = estimateStepCost(model, rawStep.capability);
    const durationSecEst = estimateStepDuration(rawStep.capability);

    return {
      ...rawStep,
      step_no: stepNo,
      model,
      cost_estimate: costEstimate,
      duration_sec_est: durationSecEst,
    };
  }
}

// ============================================================
// UTILITIES
// ============================================================

function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function round(n: number, decimals: number): number {
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}

function uniqueRiskClasses(steps: BomStep[]): RiskClass[] {
  return Array.from(new Set(steps.map(s => s.risk_class)));
}

function stepsWithDeps(steps: BomStep[]): Array<BomStep & { cumulativeDuration: number }> {
  // Topological cumulative duration — longest path = critical path
  const map = new Map<number, BomStep>(steps.map(s => [s.step_no, s]));
  const memo = new Map<number, number>();
  function dur(stepNo: number): number {
    if (memo.has(stepNo)) return memo.get(stepNo)!;
    const s = map.get(stepNo)!;
    const depMax = s.depends_on.length ? Math.max(...s.depends_on.map(dur)) : 0;
    const total = depMax + s.duration_sec_est;
    memo.set(stepNo, total);
    return total;
  }
  return steps.map(s => ({ ...s, cumulativeDuration: dur(s.step_no) }));
}

// Heuristic cost table — replace with the real per-model price list
function estimateStepCost(model: string, capability: CapabilityTag): number {
  const tokensInOut = capability === 'long-context' ? [40000, 4000] :
                      capability === 'code-reasoning' ? [8000, 2000] :
                      capability === 'code-execution' ? [4000, 1500] :
                      capability === 'cheap-classifier' ? [800, 200] :
                      capability === 'reading' ? [2000, 200] :
                      [1500, 500];
  const pricePer1k: Record<string, [number, number]> = {
    'claude-opus-4.8':    [0.015, 0.075],
    'claude-sonnet-4.8':  [0.003, 0.015],
    'claude-haiku-4':     [0.0008, 0.004],
    'gpt-5.5':            [0.005, 0.025],
    'gemini-2.5-pro':     [0.00125, 0.005],
    'gemini-2.5-flash':   [0.000075, 0.0003],
    'llama-3.1-8b':       [0, 0],
    'llama-3.1-70b':      [0, 0],
    'mistral-local':      [0, 0],
  };
  const [pIn, pOut] = pricePer1k[model] ?? [0.003, 0.015];
  return (tokensInOut[0] / 1000) * pIn + (tokensInOut[1] / 1000) * pOut;
}

function estimateStepDuration(capability: CapabilityTag): number {
  // Rough wall-clock duration estimates in seconds
  switch (capability) {
    case 'reading':            return 15;
    case 'cheap-classifier':   return 5;
    case 'code-execution':     return 60;
    case 'code-reasoning':     return 90;
    case 'long-context':       return 45;
    case 'multimodal-vision':  return 30;
    case 'multimodal-audio':   return 60;
    case 'tool-use-heavy':     return 120;
    case 'simple-summary':     return 10;
    case 'no-model':           return 30;
  }
}

// ============================================================
// WIRING — what's needed to actually run this
// ============================================================
//
// 1. Instantiate StewardPlanner in the daemon bootstrap (src/daemon.ts):
//
//    const planner = new StewardPlanner(broker, persistence, provider, () => persistence.getActiveProfileMode());
//
// 2. Add a new MCP tool 'propose_plan' that calls planner.proposePlan(args) and
//    returns { bom_id }. The caller (chat session / Claude Desktop) gets the id
//    to render an approval card with link to the inspector.
//
// 3. When a 'decision_response' arrives with verdict='approve' on a BOM, the
//    framework should:
//      - Update bom.status = 'approved'
//      - Create a trust_scope with allowed_risk_classes = bom.risk_envelope
//      - Set bom.scope_id = that scope's id
//      - Emit 'bom_approved'
//      - Hand off to the executor (separate module, follow-up PR)
//
// 4. The executor (not in this file) reads approved BOMs, dispatches workers
//    per step, captures cost/results, emits bom_step_* events, calls
//    planner.replan() on failure.
//
// 5. Feature flag: gate the new tool behind `stavr.experimental.planner = true`
//    in config. Default off until you've validated outputs on real plans.
