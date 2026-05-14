// src/steward/executor.ts
//
// BomExecutor — reads approved BOMs, dispatches each step through the
// connector registry under a derived trust scope, persists step state, and
// drives replan-on-failure via the StewardPlanner.
//
// Lifecycle:
//   1. Daemon emits `bom_approved` (e.g. from the dashboard /respond route).
//   2. Executor walks the active version's steps in topological order.
//   3. For each step: look up brick_id in the connector registry, call
//      connector.exec(capability_id, args, ctx). Persist cost + result.
//   4. On step failure: increment retry_count, call planner.replan() once
//      retries are exhausted, swap to the new version and resume from the
//      failed step (or pause if the new version escalates the risk envelope).
//   5. On all steps done: emit bom_completed.
//   6. On unrecoverable failure (replan loop > 3): emit bom_failed.
//
// Concurrency: the executor walks steps sequentially per BOM by default
// (overnight single-worker rule). The `stepConcurrency` option allows
// independent steps to dispatch in parallel up to a cap.
//
// Resume-on-restart: on `start()`, the executor scans for BOMs with
// status='running' and re-dispatches any steps whose status is 'pending' or
// 'running' (the latter likely got interrupted mid-flight).

import { randomUUID } from 'node:crypto';

import type {
  Bom,
  BomStep,
  BomStepStatus,
  CapabilityTag,
  PayloadBomCompleted,
  PayloadBomFailed,
  PayloadBomStepCompleted,
  PayloadBomStepFailed,
  PayloadBomStepStarted,
  RiskClass,
} from '../types/stavr-bom.js';
import type { ConnectorRegistry, ExecContext, ExecResult } from '../connectors/index.js';

import type {
  PlannerEventEmitter,
  StewardPlanner,
} from './planner.js';

// ============================================================
// DEPENDENCIES
// ============================================================

export interface ExecutorBomStore {
  getBom(id: string): Bom | undefined;
  listBoms(filter?: { status?: Bom['status'] }): Bom[];
  getActiveVersion(bomId: string): { steps: BomStep[] } | undefined;
  updateBomStatus(bomId: string, patch: Partial<Bom>): void;
  updateBomStep(
    bomId: string,
    version: number,
    stepNo: number,
    patch: {
      status?: BomStepStatus;
      cost_actual?: number;
      tokens_in?: number;
      tokens_out?: number;
      worker_id?: string | null;
      error_message?: string | null;
      retry_count?: number;
      started_at?: string | null;
      ended_at?: string | null;
    },
  ): void;
  listBomSteps(
    bomId: string,
    version: number,
  ): Array<BomStep & {
    status: BomStepStatus;
    cost_actual: number;
    tokens_in: number;
    tokens_out: number;
    worker_id?: string;
    error_message?: string;
    retry_count: number;
    started_at?: string;
    ended_at?: string;
  }>;
}

/**
 * Subscribe to a kind of event from the broker. The returned function
 * unsubscribes when called. Kept minimal so tests can inject a fake.
 */
export type ExecutorEventSubscriber = (
  kind: string,
  handler: (event: { kind: string; payload: unknown; correlation_id?: string }) => void,
) => () => void;

export interface ExecutorScopeManager {
  /**
   * Create a trust scope derived from a BOM's risk envelope. Returns the
   * scope id. The shape of the scope object is opaque to the executor —
   * production wires this to the existing TrustStore; tests can stub.
   */
  createBomScope(bomId: string, riskEnvelope: RiskClass[], stepCount: number): string;
  /**
   * Close a scope when the BOM finishes (or fails). Idempotent.
   */
  closeBomScope(scopeId: string): void;
}

export interface ExecutorDeps {
  events: PlannerEventEmitter;
  subscribe: ExecutorEventSubscriber;
  store: ExecutorBomStore;
  connectors: ConnectorRegistry;
  scopes: ExecutorScopeManager;
  planner: StewardPlanner;
  /**
   * Profile mode passed to ExecContext. Defaults to 'balanced'. Production
   * wires this to read from profile_state.
   */
  getProfileMode?: () => 'turbo' | 'balanced' | 'eco';
}

export interface ExecutorOptions {
  /** Max steps that can run concurrently (default 1, single-worker rule). */
  stepConcurrency?: number;
  /** Max retries per step before triggering a replan (default 3). */
  maxRetriesPerStep?: number;
  /** Max replan loops per BOM before marking failed (default 3). */
  maxReplansPerBom?: number;
}

// ============================================================
// EXECUTOR
// ============================================================

export class BomExecutor {
  private readonly deps: ExecutorDeps;
  private readonly stepConcurrency: number;
  private readonly maxRetriesPerStep: number;
  private readonly maxReplansPerBom: number;
  private unsubscribe?: () => void;
  private replanCounts = new Map<string, number>();
  private running = new Set<string>();

  constructor(deps: ExecutorDeps, opts: ExecutorOptions = {}) {
    this.deps = deps;
    this.stepConcurrency = Math.max(1, opts.stepConcurrency ?? 1);
    this.maxRetriesPerStep = Math.max(0, opts.maxRetriesPerStep ?? 3);
    this.maxReplansPerBom = Math.max(0, opts.maxReplansPerBom ?? 3);
  }

  /**
   * Subscribe to bom_approved and resume any in-flight BOMs from the DB.
   */
  start(): void {
    this.unsubscribe = this.deps.subscribe('bom_approved', (event) => {
      const payload = event.payload as { bom_id?: string } | undefined;
      if (payload?.bom_id) {
        void this.runBom(payload.bom_id);
      }
    });

    for (const bom of this.deps.store.listBoms({ status: 'running' })) {
      void this.runBom(bom.id);
    }
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /**
   * Drive a BOM to completion. Idempotent — if the BOM is already running
   * in this executor, the second invocation is a no-op.
   */
  async runBom(bomId: string): Promise<void> {
    if (this.running.has(bomId)) return;
    this.running.add(bomId);
    try {
      await this.runBomInner(bomId);
    } finally {
      this.running.delete(bomId);
    }
  }

  private async runBomInner(bomId: string): Promise<void> {
    let bom = this.deps.store.getBom(bomId);
    if (!bom) return;

    // Transition to running on first dispatch.
    if (bom.status === 'approved' || bom.status === 'proposed') {
      const startedAt = new Date().toISOString();
      this.deps.store.updateBomStatus(bomId, { status: 'running', started_at: startedAt });
      bom = { ...bom, status: 'running', started_at: startedAt };
    }

    let scopeId = bom.scope_id;
    if (!scopeId) {
      const totalSteps = (this.deps.store.getActiveVersion(bomId)?.steps ?? []).length;
      scopeId = this.deps.scopes.createBomScope(bomId, bom.risk_envelope, totalSteps);
      this.deps.store.updateBomStatus(bomId, { scope_id: scopeId });
      bom = { ...bom, scope_id: scopeId };
    }

    while (true) {
      bom = this.deps.store.getBom(bomId) ?? bom;
      const steps = this.deps.store.listBomSteps(bomId, bom.active_version);
      const ready = readySteps(steps);
      if (ready.length === 0) {
        const allDone = steps.every((s) => s.status === 'done' || s.status === 'skipped');
        if (allDone) {
          await this.markBomCompleted(bomId, bom, steps);
          return;
        }
        const blocked = steps.some((s) => s.status === 'failed');
        if (blocked) {
          await this.markBomFailed(bomId, bom, 'a step is in failed status with no recovery available');
          return;
        }
        // Nothing ready, nothing done — must be an orphan dependency. Fail.
        await this.markBomFailed(bomId, bom, 'no steps ready to run and not all completed');
        return;
      }

      const batch = ready.slice(0, this.stepConcurrency);
      const failures: Array<{ stepNo: number; error: string; capability: CapabilityTag; model: string }> = [];
      await Promise.all(
        batch.map(async (step) => {
          const outcome = await this.runStep(bom!, step);
          if (!outcome.ok) {
            failures.push({
              stepNo: step.step_no,
              error: outcome.error,
              capability: step.capability,
              model: step.model,
            });
          }
        }),
      );

      if (failures.length > 0) {
        const replanned = await this.handleFailures(bomId, bom, failures);
        if (!replanned) return; // bom marked failed
      }
    }
  }

  private async runStep(
    bom: Bom,
    step: BomStep & { status: BomStepStatus; retry_count: number },
  ): Promise<{ ok: true; cost: number } | { ok: false; error: string }> {
    const startedAt = new Date().toISOString();
    this.deps.store.updateBomStep(bom.id, bom.active_version, step.step_no, {
      status: 'running',
      started_at: startedAt,
    });

    const workerId = `bom_${bom.id.slice(0, 8)}_step_${step.step_no}_${randomUUID().slice(0, 6)}`;
    const startedPayload: PayloadBomStepStarted = {
      bom_id: bom.id,
      version: bom.active_version,
      step_no: step.step_no,
      worker_id: workerId,
      model: step.model,
    };
    await this.deps.events.publish('bom_step_started', startedPayload, bom.correlation_id);

    const ctx: ExecContext = {
      workerId,
      bomId: bom.id,
      stepNo: step.step_no,
      scopeId: bom.scope_id,
      profileMode: this.deps.getProfileMode?.() ?? bom.profile_mode,
    };

    let result: ExecResult;
    const t0 = Date.now();
    try {
      const connector = this.deps.connectors.get(step.brick_id);
      if (!connector) {
        throw new Error(`no connector registered for brick_id '${step.brick_id}'`);
      }
      const argsRaw = (step as unknown as { args?: Record<string, unknown> }).args;
      result = await connector.exec(step.capability, argsRaw ?? {}, ctx);
    } catch (err) {
      result = {
        ok: false,
        durationMs: Date.now() - t0,
        error: (err as Error).message,
      };
    }

    const endedAt = new Date().toISOString();
    if (result.ok) {
      this.deps.store.updateBomStep(bom.id, bom.active_version, step.step_no, {
        status: 'done',
        cost_actual: result.cost ?? 0,
        worker_id: workerId,
        ended_at: endedAt,
      });
      const completedPayload: PayloadBomStepCompleted = {
        bom_id: bom.id,
        version: bom.active_version,
        step_no: step.step_no,
        cost_actual: result.cost ?? 0,
        tokens_in: 0,
        tokens_out: 0,
        duration_sec: Math.round(result.durationMs / 1000),
      };
      await this.deps.events.publish('bom_step_completed', completedPayload, bom.correlation_id);
      return { ok: true, cost: result.cost ?? 0 };
    }

    const errorMessage = result.error ?? 'unknown error';
    const newRetryCount = step.retry_count + 1;
    const willReplan = newRetryCount > this.maxRetriesPerStep;
    this.deps.store.updateBomStep(bom.id, bom.active_version, step.step_no, {
      status: 'failed',
      error_message: errorMessage,
      retry_count: newRetryCount,
      worker_id: workerId,
      ended_at: endedAt,
    });
    const failedPayload: PayloadBomStepFailed = {
      bom_id: bom.id,
      version: bom.active_version,
      step_no: step.step_no,
      error_message: errorMessage,
      retry_count: newRetryCount,
      will_replan: willReplan,
    };
    await this.deps.events.publish('bom_step_failed', failedPayload, bom.correlation_id);
    return { ok: false, error: errorMessage };
  }

  /**
   * Decide what to do with one or more failed steps. Returns true if the BOM
   * loop should continue (replanned or retried), false if the BOM has been
   * marked failed.
   */
  private async handleFailures(
    bomId: string,
    bom: Bom,
    failures: Array<{ stepNo: number; error: string; capability: CapabilityTag; model: string }>,
  ): Promise<boolean> {
    for (const f of failures) {
      const steps = this.deps.store.listBomSteps(bomId, bom.active_version);
      const step = steps.find((s) => s.step_no === f.stepNo);
      if (!step) continue;

      if (step.retry_count <= this.maxRetriesPerStep) {
        // Reset to pending so the loop retries with the same step.
        this.deps.store.updateBomStep(bomId, bom.active_version, f.stepNo, {
          status: 'pending',
          ended_at: null,
        });
        continue;
      }

      const replanCount = (this.replanCounts.get(bomId) ?? 0) + 1;
      this.replanCounts.set(bomId, replanCount);
      if (replanCount > this.maxReplansPerBom) {
        await this.markBomFailed(bomId, bom, `replan loop exceeded after step ${f.stepNo}: ${f.error}`, f.stepNo);
        return false;
      }

      const { newVersion, willEscalateRiskClass } = await this.deps.planner.replan({
        bomId,
        triggerStepNo: f.stepNo,
        errorMessage: f.error,
        failedCapability: f.capability,
        failedModel: f.model,
      });

      if (willEscalateRiskClass) {
        // Pause for explicit approval — surface via failed event; the new
        // version is persisted but not activated.
        await this.markBomFailed(
          bomId,
          bom,
          `replan would escalate risk envelope (proposed v${newVersion}) — operator approval required`,
          f.stepNo,
        );
        return false;
      }

      // setActiveVersion already happened inside planner.replan() when the
      // envelope didn't escalate. The loop will now read the new version.
      return true;
    }
    return true;
  }

  private async markBomCompleted(
    bomId: string,
    bom: Bom,
    steps: ReturnType<ExecutorBomStore['listBomSteps']>,
  ): Promise<void> {
    const endedAt = new Date().toISOString();
    const costActual = steps.reduce((sum, s) => sum + s.cost_actual, 0);
    const stepsDone = steps.filter((s) => s.status === 'done').length;
    const durationSec = bom.started_at
      ? Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(bom.started_at)) / 1000))
      : 0;
    this.deps.store.updateBomStatus(bomId, {
      status: 'done',
      ended_at: endedAt,
      cost_actual: costActual,
      steps_done: stepsDone,
      duration_sec: durationSec,
    });
    if (bom.scope_id) this.deps.scopes.closeBomScope(bom.scope_id);
    const payload: PayloadBomCompleted = {
      bom_id: bomId,
      version: bom.active_version,
      cost_actual: costActual,
      steps_done: stepsDone,
      duration_sec: durationSec,
      ended_at: endedAt,
    };
    await this.deps.events.publish('bom_completed', payload, bom.correlation_id);
  }

  private async markBomFailed(
    bomId: string,
    bom: Bom,
    reason: string,
    lastStepNo?: number,
  ): Promise<void> {
    const endedAt = new Date().toISOString();
    this.deps.store.updateBomStatus(bomId, {
      status: 'failed',
      ended_at: endedAt,
    });
    if (bom.scope_id) this.deps.scopes.closeBomScope(bom.scope_id);
    const payload: PayloadBomFailed = {
      bom_id: bomId,
      version: bom.active_version,
      reason,
      last_step_no: lastStepNo,
    };
    await this.deps.events.publish('bom_failed', payload, bom.correlation_id);
  }
}

// ============================================================
// HELPERS
// ============================================================

/**
 * Steps whose dependencies are all 'done' (or 'skipped') and whose own
 * status is 'pending'. Used by the executor's main loop to pick the next
 * batch to dispatch.
 */
export function readySteps(
  steps: Array<BomStep & { status: BomStepStatus }>,
): Array<BomStep & { status: BomStepStatus; retry_count: number }> {
  const doneOrSkipped = new Set(
    steps.filter((s) => s.status === 'done' || s.status === 'skipped').map((s) => s.step_no),
  );
  return steps
    .filter((s) => s.status === 'pending')
    .filter((s) => s.depends_on.every((d) => doneOrSkipped.has(d))) as Array<
    BomStep & { status: BomStepStatus; retry_count: number }
  >;
}
