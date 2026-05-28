/**
 * JobOrchestrator — owns the job lifecycle end-to-end. Phase 1 deliverable.
 *
 * Parallel to src/workers/orchestrator.ts during the cutover window; Phase 3
 * (proposed/worker-dispatch-bom.md) re-points the bespoke worker subsystem
 * onto this. Until then both orchestrators coexist on the same broker + store.
 *
 * Phase 1 deliberately does NOT carry a built-in tier gate. The MCP tool
 * surface for `job_*` (Phase 3 cutover) routes through the structural
 * chokepoint, which is the right place to gate. The orchestrator just owns
 * the lifecycle:
 *
 *   1. validate params against the binding's schema
 *   2. persist the JobRecord in `dispatched` state
 *   3. call binding.dispatch(); transition to `running`
 *   4. wire binding events into the broker as `job_*` events
 *   5. on `exit`, persist the terminal state (lifecycle_state + termination
 *      reason + exit_code + result), unsubscribe, drop the live handle
 *
 * Idle timer + admission control + load-shedding mirror WorkerOrchestrator's
 * shape but operate on JobRecord. host-ceiling integration is wired in at
 * Phase 3; Phase 1 stubs it as fail-open so the substrate is testable in
 * isolation.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Broker } from '../broker.js';
import type { EventStore } from '../persistence.js';
import type { EventKindT } from '../event-types.js';
import type {
  BindingContext,
  BindingHandle,
  ExecutorBinding,
  JobBudget,
  JobDescriptor,
  JobRecord,
} from './types.js';
import type { JobLifecycleState } from './lifecycle.js';
import { dualEmitLegacy } from './dual-emit.js';
import type { HostCeiling } from '../types/host-ceiling.js';
import type {
  HeadroomSnapshot,
  HostHeadroomMonitor,
} from '../observability/host-headroom-poller.js';

const IDLE_AFTER_MS = 5 * 60 * 1000;

export interface JobOrchestratorOptions {
  broker: Broker;
  store: EventStore;
  /** Override the idle timer. Tests pass null to disable; production uses
   *  the 5-minute default. */
  idleAfterMs?: number | null;
  /**
   * Phase 3a — admission control. Host-resource ceiling + headroom monitor
   * port from WorkerOrchestrator. When both `ceiling.enabled` is true AND
   * `headroomMonitor` is provided, `dispatch()` refuses with
   * OrchestratorError('headroom_exceeded' | 'concurrent_jobs_exceeded' | ...)
   * when admitting the dispatch would breach the ceiling. Fail-open if
   * either is missing (caller didn't opt in).
   */
  ceiling?: HostCeiling;
  headroomMonitor?: HostHeadroomMonitor;
  /**
   * Phase 3a — per-actor concurrency cap (federation precursor). An "actor"
   * is the originator_peer for federated dispatches, `grant:<id>` for jobs
   * dispatched under a trust scope, or `'local'` for the operator's own
   * dispatches. Unlimited when undefined or <= 0. The cap counts in-flight
   * (running/dispatched) jobs per actor against the configured limit.
   *
   * This is the substrate Phase 4 (scope-aware enforcement) lights up — for
   * 3a the limit is operator-set, not derived from a grant's budget.
   */
  maxConcurrentPerActor?: number;
  /**
   * Phase 3a — pre-dispatch budget ceiling. If a JobBudget.max_runtime_ms is
   * provided that exceeds this, dispatch refuses. Defaults to no cap when
   * undefined or <= 0. This is the "you can't ask for an unbounded job"
   * knob, paired with the runtime enforcement that lives in the binding
   * handles (out of scope for 3a).
   */
  maxRuntimeMsCeiling?: number;
}

export interface JobDispatchInput {
  binding_kind: string;
  binding_target: string;
  name: string;
  params: unknown;
  budget?: JobBudget;
  audit_correlation_id?: string;
  federation_role?: JobRecord['federation_role'];
  originator_peer?: string;
  grant_id?: string;
}

export class OrchestratorError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

interface LiveJob {
  record: JobRecord;
  handle: BindingHandle;
  binding: ExecutorBinding;
  idleTimer?: NodeJS.Timeout;
  detach: () => void;
}

export class JobOrchestrator {
  private bindings = new Map<string, ExecutorBinding>();
  private live = new Map<string, LiveJob>();
  /** Per-actor live count for the per-actor concurrency cap. Decremented
   *  on the `exit` event (terminal lifecycle) or on early dispatch failure. */
  private liveByActor = new Map<string, number>();
  private readonly broker: Broker;
  private readonly store: EventStore;
  private readonly idleAfterMs: number | null;
  private ceiling: HostCeiling | undefined;
  private headroomMonitor: HostHeadroomMonitor | undefined;
  private readonly maxConcurrentPerActor: number | undefined;
  private readonly maxRuntimeMsCeiling: number | undefined;

  constructor(opts: JobOrchestratorOptions) {
    this.broker = opts.broker;
    this.store = opts.store;
    this.idleAfterMs = opts.idleAfterMs === undefined ? IDLE_AFTER_MS : opts.idleAfterMs;
    this.ceiling = opts.ceiling;
    this.headroomMonitor = opts.headroomMonitor;
    this.maxConcurrentPerActor = opts.maxConcurrentPerActor;
    this.maxRuntimeMsCeiling = opts.maxRuntimeMsCeiling;
  }

  /** Late-bind the ceiling + headroom monitor — mirrors the WorkerOrchestrator
   *  setter so the daemon can attach the monitor on boot regardless of
   *  orchestrator construction order. */
  setHostCeilingContext(ctx: { ceiling: HostCeiling; monitor: HostHeadroomMonitor }): void {
    this.ceiling = ctx.ceiling;
    this.headroomMonitor = ctx.monitor;
  }

  /**
   * Read-only accessor used by dashboard fetchers — returns the ceiling, the
   * latest snapshot, and the live job count in one shot. Parallels
   * WorkerOrchestrator.getCeilingStatus so the dashboard data layer can
   * source from either during the cutover.
   */
  getCeilingStatus(): {
    ceiling: HostCeiling | null;
    snapshot: HeadroomSnapshot | null;
    live_jobs: number;
  } {
    return {
      ceiling: this.ceiling ?? null,
      snapshot: this.headroomMonitor?.current() ?? null,
      live_jobs: this.live.size,
    };
  }

  /** Register a binding (kind + target). The catalogue key is
   *  `<kind>:<target>` — within a kind, multiple named targets coexist
   *  (the 'process-spawn' kind can register 'generic', 'claude-code-subprocess',
   *  etc.). Throws on duplicate. */
  register(binding: ExecutorBinding): void {
    const key = bindingKey(binding.kind, binding.target);
    if (this.bindings.has(key)) {
      throw new Error(`binding already registered: ${key}`);
    }
    this.bindings.set(key, binding);
  }

  liveCount(): number {
    return this.live.size;
  }

  liveJobIdsInDispatchOrder(): string[] {
    return Array.from(this.live.keys());
  }

  listBindings(): JobDescriptor[] {
    return Array.from(this.bindings.values()).map((b) => ({
      kind: b.kind,
      target: b.target,
      displayName: b.displayName,
      description: b.description,
      capabilities: b.capabilities,
      paramsSchema: zodToSafeJson(b.paramsSchema),
    }));
  }

  status(idOrName: string): JobRecord | undefined {
    return this.store.getJob(idOrName);
  }

  list(filter?: { binding_kind?: JobRecord['binding_kind']; lifecycle_state?: JobLifecycleState }): JobRecord[] {
    return this.store.listJobs(filter);
  }

  async dispatch(input: JobDispatchInput): Promise<{ job: JobRecord }> {
    const key = bindingKey(input.binding_kind, input.binding_target);
    const binding = this.bindings.get(key);
    if (!binding) {
      throw new OrchestratorError('unknown_binding', `no binding registered for ${key}`);
    }

    if (!this.store.jobNameIsAvailable(input.name)) {
      throw new OrchestratorError(
        'name_in_use',
        `job name "${input.name}" is already in use by a non-terminal job`,
      );
    }

    const parsed = binding.paramsSchema.safeParse(input.params);
    if (!parsed.success) {
      throw new OrchestratorError(
        'invalid_params',
        `invalid params for ${key}: ${parsed.error.message}`,
      );
    }
    const validated = parsed.data;

    // Phase 3a — admission control. Order: pre-dispatch budget shape check
    // (cheapest, no I/O), then per-actor concurrency, then global host
    // ceiling. The most-actionable refusal wins; each emits a
    // host_ceiling_refused event so the dashboard can surface why.
    const actorId = resolveActorId(input);
    this.checkBudgetShape(input.budget);
    await this.checkPerActorConcurrency(actorId, key, input.name);
    try {
      await this.checkHostAdmission(key, input.name);
    } catch (err) {
      // Host admission refused after per-actor reserved its slot — release
      // before re-raising so the slot doesn't leak.
      this.releaseActorSlot(actorId);
      throw err;
    }

    const id = randomUUID();
    const startedAt = new Date().toISOString();
    const paramsHash = hashParams({
      kind: input.binding_kind,
      target: input.binding_target,
      name: input.name,
      params: validated,
    });

    // Insert the dispatched-state row BEFORE calling the binding, so a crash
    // mid-dispatch leaves a forensic trail rather than a silent failure.
    const dispatchedRecord: JobRecord = {
      id,
      name: input.name,
      binding_kind: binding.kind,
      binding_target: binding.target,
      params_hash: paramsHash,
      lifecycle_state: 'dispatched',
      started_at: startedAt,
      last_activity_at: startedAt,
      metadata: {},
      budget: input.budget,
      audit_correlation_id: input.audit_correlation_id,
      federation_role: input.federation_role,
      originator_peer: input.originator_peer,
      grant_id: input.grant_id,
    };
    this.store.upsertJob(dispatchedRecord);
    await this.publish(
      'job_dispatched',
      {
        id,
        name: input.name,
        binding_kind: binding.kind,
        binding_target: binding.target,
        params_hash: paramsHash,
        ...(input.budget ? { budget: input.budget } : {}),
      },
      undefined,
      sourceAgent(binding, input.name),
    );

    const ctx: BindingContext = {
      jobId: id,
      jobName: input.name,
      broker: this.broker,
      store: this.store,
      emit: (kind, payload, correlationId) =>
        this.publish(kind, payload, correlationId, sourceAgent(binding, input.name)),
    };

    let handle: BindingHandle;
    try {
      handle = await binding.dispatch(validated, ctx);
    } catch (err) {
      // Dispatch threw — mark the job crashed before re-raising so the row
      // doesn't sit forever in `dispatched`. Release the per-actor slot we
      // reserved in checkPerActorConcurrency so a failed dispatch doesn't
      // leak quota.
      this.releaseActorSlot(actorId);
      this.store.markJobTerminated(id, 'crashed', undefined, undefined);
      await this.publish(
        'job_terminated',
        { id, reason: 'crashed' },
        undefined,
        sourceAgent(binding, input.name),
      );
      throw new OrchestratorError('dispatch_failed', (err as Error).message);
    }

    // Update with binding-supplied metadata + pid, transition to running.
    const runningRecord: JobRecord = {
      ...dispatchedRecord,
      lifecycle_state: 'running',
      metadata: { ...handle.metadata, ...(handle.pid !== undefined ? { pid: handle.pid } : {}) },
    };
    this.store.upsertJob(runningRecord);

    const live: LiveJob = {
      record: runningRecord,
      handle,
      binding,
      detach: () => {},
    };

    const offs: Array<() => void> = [];
    offs.push(
      handle.events.on('progress', (info) => {
        this.touch(id);
        const payload: { id: string; message: string; payload?: unknown } = {
          id,
          message: info.message,
        };
        if (info.payload !== undefined) payload.payload = info.payload;
        void this.publish('job_progress', payload, undefined, sourceAgent(binding, input.name));
      }),
    );
    offs.push(
      handle.events.on('metadata', (info) => {
        const updated = this.store.updateJobMetadata(id, info.patch);
        if (updated) live.record = updated;
        this.touch(id);
        void this.publish(
          'job_metadata_changed',
          { id, patch: info.patch },
          undefined,
          sourceAgent(binding, input.name),
        );
      }),
    );
    offs.push(
      handle.events.on('activity', (info) => {
        this.touch(id);
        void this.publish(
          'job_heartbeat',
          { id, ...(info.detail !== undefined ? { detail: info.detail } : {}) },
          undefined,
          sourceAgent(binding, input.name),
        );
      }),
    );
    offs.push(
      handle.events.on('log', (info) => {
        this.touch(id);
        void this.publish(
          'job_log',
          {
            job_id: id,
            job_name: input.name,
            stream: info.stream,
            format: info.format,
            ...(info.event !== undefined && { event: info.event }),
            ...(info.line !== undefined && { line: info.line }),
            ...(info.truncated && { truncated: info.truncated }),
          },
          undefined,
          sourceAgent(binding, input.name),
        );
      }),
    );
    offs.push(
      handle.events.on('error', (info) => {
        void this.publish(
          'job_error',
          { id, message: info.message, recoverable: info.recoverable },
          undefined,
          sourceAgent(binding, input.name),
        );
      }),
    );
    offs.push(
      handle.events.on('exit', (info) => {
        const reason: NonNullable<JobRecord['termination_reason']> =
          info.reason === 'terminated' ? 'terminated_by_user' : info.reason;
        const updated = this.store.markJobTerminated(id, reason, info.exitCode, info.result);
        if (updated) live.record = updated;
        this.cancelIdle(id);
        void this.publish(
          'job_terminated',
          {
            id,
            reason,
            ...(info.exitCode !== undefined && { exit_code: info.exitCode }),
            ...(info.result !== undefined && { result: info.result }),
          },
          undefined,
          sourceAgent(binding, input.name),
        );
        this.live.delete(id);
        this.releaseActorSlot(actorId);
      }),
    );
    live.detach = () => {
      for (const off of offs) off();
    };
    this.live.set(id, live);
    this.armIdle(id);

    await this.publish(
      'job_started',
      {
        id,
        name: input.name,
        binding_kind: binding.kind,
        binding_target: binding.target,
        ...(handle.pid !== undefined && { pid: handle.pid }),
        metadata: runningRecord.metadata,
      },
      undefined,
      sourceAgent(binding, input.name),
    );

    return { job: runningRecord };
  }

  /** Mid-flight injection. The orchestrator routes the message to the
   *  binding's optional `inject()`; bindings that don't advertise the
   *  capability error here. */
  async inject(idOrName: string, body: unknown): Promise<{ message_id: string }> {
    const rec = this.store.getJob(idOrName);
    if (!rec) throw new OrchestratorError('not_found', `no job: ${idOrName}`);
    if (rec.lifecycle_state !== 'running' && rec.lifecycle_state !== 'dispatched') {
      throw new OrchestratorError(
        'job_inactive',
        `job ${rec.name} is ${rec.lifecycle_state}`,
      );
    }
    const live = this.live.get(rec.id);
    if (!live || !live.handle.inject) {
      throw new OrchestratorError(
        'inject_not_supported',
        `binding ${rec.binding_kind}:${rec.binding_target} does not support inject`,
      );
    }
    const messageId = randomUUID();
    await live.handle.inject({ id: messageId, body });
    return { message_id: messageId };
  }

  async terminate(idOrName: string, force: boolean): Promise<{ exitCode?: number }> {
    const rec = this.store.getJob(idOrName);
    if (!rec) throw new OrchestratorError('not_found', `no job: ${idOrName}`);
    if (rec.lifecycle_state !== 'running' && rec.lifecycle_state !== 'dispatched') {
      return { exitCode: rec.exit_code };
    }
    const live = this.live.get(rec.id);
    if (!live) {
      // No live handle (daemon restart between dispatch and terminate).
      // Best-effort: stamp as terminated_by_user.
      this.store.markJobTerminated(rec.id, 'terminated_by_user');
      return {};
    }
    const result = await live.handle.terminate(force);
    if (!this.store.getJob(rec.id)?.ended_at) {
      this.store.markJobTerminated(rec.id, 'terminated_by_user', result.exitCode);
    }
    return result;
  }

  async shutdownAll(): Promise<void> {
    const live = Array.from(this.live.values());
    await Promise.all(
      live.map(async (l) => {
        try {
          await l.handle.terminate(false);
        } catch {
          /* daemon going down — swallow */
        }
        l.detach();
      }),
    );
    this.live.clear();
    this.liveByActor.clear();
  }

  /**
   * Phase 5 load-shedding parallel for jobs. Terminates the live binding
   * handle without the operator gate (the load-shedder, not the operator,
   * is the decision authority for shed). Emits `host_ceiling_shed` with
   * the victim and reason, then leans on the handle's terminate() to fire
   * `exit` (which the orchestrator routes into `job_terminated`).
   *
   * Caller picks the victim. This method does NOT pick.
   */
  async shedJob(jobId: string, reason: string): Promise<{ exitCode?: number }> {
    const rec = this.store.getJob(jobId);
    if (!rec) throw new OrchestratorError('not_found', `no job: ${jobId}`);
    const live = this.live.get(jobId);
    if (!live) {
      // Already terminated; idempotent.
      return { exitCode: rec.exit_code };
    }
    await this.broker.publish({
      kind: 'host_ceiling_shed',
      at: new Date().toISOString(),
      source_agent: 'stavr-jobs',
      payload: {
        // worker-dispatch Phase 3c.1 — primary slot names are job_id /
        // job_name / binding_kind + binding_target. The dashboard chart
        // (src/dashboard/data/host-ceiling.ts) is bound to these names
        // in the same commit. Legacy worker_* slot names live on the
        // dual-emit shadow (WorkerOrchestrator.shedWorker still publishes
        // the legacy payload directly for back-compat subscribers).
        job_id: rec.id,
        job_name: rec.name,
        binding_kind: rec.binding_kind,
        binding_target: rec.binding_target,
        reason,
      },
    });
    const result = await live.handle.terminate(true);
    if (!this.store.getJob(rec.id)?.ended_at) {
      this.store.markJobTerminated(rec.id, 'shed_by_host', result.exitCode);
    }
    return result;
  }

  // --- internals --------------------------------------------------------

  private async publish(
    kind: EventKindT,
    payload: unknown,
    correlationId: string | undefined,
    sourceAgentName: string,
  ): Promise<void> {
    await this.broker.publish({
      kind,
      at: new Date().toISOString(),
      correlation_id: correlationId,
      source_agent: sourceAgentName,
      payload,
    });
    // Phase 3a dual-emit window: shadow the new job_* event as the legacy
    // worker_* equivalent so subscribers tuned to the old kinds keep
    // working through one minor release. See src/jobs/dual-emit.ts +
    // DEPRECATION_WINDOW_RELEASES in src/event-types.ts.
    await dualEmitLegacy(this.broker, {
      kind,
      payload,
      correlationId,
      sourceAgent: sourceAgentName,
    });
  }

  private touch(id: string): void {
    const updated = this.store.updateJobMetadata(id, {});
    const live = this.live.get(id);
    if (live && updated) live.record = updated;
    this.armIdle(id);
  }

  private armIdle(id: string): void {
    if (this.idleAfterMs === null) return;
    const live = this.live.get(id);
    if (!live) return;
    if (live.idleTimer) clearTimeout(live.idleTimer);
    live.idleTimer = setTimeout(() => {
      const cur = this.store.getJob(id);
      if (!cur) return;
      if (cur.lifecycle_state === 'running') {
        this.store.updateJobLifecycleState(id, 'stale');
      }
    }, this.idleAfterMs);
    if (typeof live.idleTimer.unref === 'function') live.idleTimer.unref();
  }

  /**
   * Pre-dispatch budget shape check (Phase 3a).
   *
   * Cheap, no I/O. Validates that user-supplied budget values are sane:
   *   - max_runtime_ms positive when set (zod's z.number().int().positive()
   *     already enforces this at the schema layer, but the orchestrator's
   *     dispatch() takes an unknown `params` and trusts zod was run upstream,
   *     so we re-check here too).
   *   - max_runtime_ms doesn't exceed the configured ceiling (operator
   *     wired this; default unlimited).
   *
   * Enforcement site: src/jobs/orchestrator.ts dispatch(), right after
   * params validation, before the persisted dispatched row + binding call.
   */
  private checkBudgetShape(budget?: JobBudget): void {
    if (!budget) return;
    if (budget.max_runtime_ms !== undefined && budget.max_runtime_ms <= 0) {
      throw new OrchestratorError(
        'invalid_budget',
        'budget.max_runtime_ms must be > 0 when set',
      );
    }
    if (budget.max_steps !== undefined && budget.max_steps <= 0) {
      throw new OrchestratorError(
        'invalid_budget',
        'budget.max_steps must be > 0 when set',
      );
    }
    if (
      this.maxRuntimeMsCeiling !== undefined &&
      this.maxRuntimeMsCeiling > 0 &&
      budget.max_runtime_ms !== undefined &&
      budget.max_runtime_ms > this.maxRuntimeMsCeiling
    ) {
      throw new OrchestratorError(
        'budget_exceeds_ceiling',
        `budget.max_runtime_ms ${budget.max_runtime_ms} exceeds host ceiling ${this.maxRuntimeMsCeiling}`,
      );
    }
  }

  /**
   * Per-actor concurrency cap (Phase 3a).
   *
   * Reserves a slot in the per-actor live-count map on dispatch; the slot
   * is released on the binding's `exit` event (or on early dispatch
   * failure). Refuses with `concurrent_jobs_per_actor_exceeded` when the
   * actor is already at the configured cap.
   *
   * Phase 4 (scope-aware enforcement) will derive the cap from the grant
   * itself; for 3a it's a single operator-set knob.
   *
   * Enforcement site: src/jobs/orchestrator.ts dispatch(), after the
   * budget check, before the host-ceiling check (per-actor is the cheaper
   * map lookup; host ceiling needs the headroom snapshot).
   */
  private async checkPerActorConcurrency(
    actorId: string,
    bindingKey: string,
    jobName: string,
  ): Promise<void> {
    const cap = this.maxConcurrentPerActor;
    if (cap === undefined || cap <= 0) {
      // Even with no cap, reserve the slot so we can introspect the count.
      this.reserveActorSlot(actorId);
      return;
    }
    const current = this.liveByActor.get(actorId) ?? 0;
    if (current >= cap) {
      await this.broker.publish({
        kind: 'host_ceiling_refused',
        at: new Date().toISOString(),
        source_agent: 'stavr-jobs',
        payload: {
          tool: 'job_dispatch',
          type: bindingKey,
          worker_name: jobName,
          reason: 'max_concurrent_per_actor',
          knob: 'maxConcurrentPerActor',
          current,
          limit: cap,
        },
      });
      throw new OrchestratorError(
        'concurrent_jobs_per_actor_exceeded',
        `job dispatch refused: actor "${actorId}" already at ${current} jobs, cap is ${cap}`,
      );
    }
    this.reserveActorSlot(actorId);
  }

  private reserveActorSlot(actorId: string): void {
    this.liveByActor.set(actorId, (this.liveByActor.get(actorId) ?? 0) + 1);
  }

  private releaseActorSlot(actorId: string): void {
    const cur = this.liveByActor.get(actorId) ?? 0;
    if (cur <= 1) this.liveByActor.delete(actorId);
    else this.liveByActor.set(actorId, cur - 1);
  }

  /** Test/introspection helper — current live job count for an actor. */
  liveCountForActor(actorId: string): number {
    return this.liveByActor.get(actorId) ?? 0;
  }

  /**
   * Host-resource ceiling admission check (Phase 3a — port from
   * WorkerOrchestrator.checkAdmission).
   *
   * Fail-open semantics carry over verbatim:
   *   - No ceiling or ceiling.enabled=false → allow.
   *   - No headroomMonitor wired → allow.
   *   - monitor.current() returns null (cold start) → allow.
   *   - cpu_busy_pct_ewma null (one sample) → skip the CPU branch.
   *
   * Checks in order so the most-actionable refusal wins:
   *   1. max_concurrent_workers (job count cap; named in the existing
   *      HostCeiling schema — kept verbatim so operators don't have to
   *      re-tune this knob between 3a and 3c).
   *   2. min_free_ram_gb — hard floor.
   *   3. max_host_ram_pct — pct ceiling.
   *   4. max_sustained_cpu_pct — EWMA only.
   *
   * Enforcement site: src/jobs/orchestrator.ts dispatch(), after per-actor
   * concurrency, before the dispatched row + binding call. The per-actor
   * reservation has already happened; if host admission refuses we release
   * the reservation so it doesn't leak.
   */
  private async checkHostAdmission(bindingKey: string, jobName: string): Promise<void> {
    const refusal = this.computeAdmissionRefusal();
    if (!refusal) return;
    await this.broker.publish({
      kind: 'host_ceiling_refused',
      at: new Date().toISOString(),
      source_agent: 'stavr-jobs',
      payload: {
        tool: 'job_dispatch',
        type: bindingKey,
        worker_name: jobName,
        reason: refusal.reason,
        knob: refusal.knob,
        current: refusal.current,
        limit: refusal.limit,
      },
    });
    throw new OrchestratorError('headroom_exceeded', refusal.message);
  }

  private computeAdmissionRefusal(): AdmissionRefusal | undefined {
    const c = this.ceiling;
    if (!c || !c.enabled) return undefined;

    if (c.max_concurrent_workers > 0 && this.live.size >= c.max_concurrent_workers) {
      return {
        reason: 'max_concurrent_workers',
        knob: 'max_concurrent_workers',
        current: this.live.size,
        limit: c.max_concurrent_workers,
        message: `job dispatch refused: ${this.live.size} live jobs already, limit is ${c.max_concurrent_workers}`,
      };
    }

    const monitor = this.headroomMonitor;
    if (!monitor) return undefined;
    const snap = monitor.current();
    if (!snap) return undefined;

    if (snap.ram_free_gb < c.min_free_ram_gb) {
      return {
        reason: 'min_free_ram_gb',
        knob: 'min_free_ram_gb',
        current: snap.ram_free_gb,
        limit: c.min_free_ram_gb,
        message: `job dispatch refused: ${snap.ram_free_gb.toFixed(2)} GB free RAM, floor is ${c.min_free_ram_gb} GB`,
      };
    }

    if (snap.ram_used_pct_ewma >= c.max_host_ram_pct) {
      return {
        reason: 'max_host_ram_pct',
        knob: 'max_host_ram_pct',
        current: snap.ram_used_pct_ewma,
        limit: c.max_host_ram_pct,
        message: `job dispatch refused: host RAM ${(snap.ram_used_pct_ewma * 100).toFixed(1)}% in use, ceiling is ${(c.max_host_ram_pct * 100).toFixed(0)}%`,
      };
    }

    if (snap.cpu_busy_pct_ewma !== null && snap.cpu_busy_pct_ewma >= c.max_sustained_cpu_pct) {
      return {
        reason: 'max_sustained_cpu_pct',
        knob: 'max_sustained_cpu_pct',
        current: snap.cpu_busy_pct_ewma,
        limit: c.max_sustained_cpu_pct,
        message: `job dispatch refused: host CPU ${(snap.cpu_busy_pct_ewma * 100).toFixed(1)}% sustained, ceiling is ${(c.max_sustained_cpu_pct * 100).toFixed(0)}%`,
      };
    }

    return undefined;
  }

  private cancelIdle(id: string): void {
    const live = this.live.get(id);
    if (live?.idleTimer) {
      clearTimeout(live.idleTimer);
      live.idleTimer = undefined;
    }
  }
}

interface AdmissionRefusal {
  reason: string;
  knob: string;
  current: number;
  limit: number;
  message: string;
}

/**
 * Map a dispatch request to an actor identifier for the per-actor
 * concurrency cap. Precedence (most-specific wins):
 *
 *   1. originator_peer  — the federated principal that asked for the job
 *      (Phase 5 will populate this from the JSON-RPC envelope).
 *   2. grant:<grant_id> — a trust scope is gating this dispatch.
 *   3. 'local'          — the operator's own dispatch, no federation
 *      attribution and no trust scope.
 *
 * The actor key is opaque to the rest of the orchestrator; only the
 * concurrency map and `host_ceiling_refused` payloads see it.
 */
function resolveActorId(input: JobDispatchInput): string {
  if (input.originator_peer) return input.originator_peer;
  if (input.grant_id) return `grant:${input.grant_id}`;
  return 'local';
}

function bindingKey(kind: string, target: string): string {
  return `${kind}:${target}`;
}

function sourceAgent(binding: ExecutorBinding, name: string): string {
  return `job:${binding.kind}:${binding.target}:${name}`;
}

function hashParams(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 16);
}

function zodToSafeJson(schema: unknown): unknown {
  if (schema && typeof schema === 'object' && '_def' in (schema as object)) {
    const def = (schema as { _def: { typeName?: string } })._def;
    return { _kind: def.typeName ?? 'zod', _note: 'see binding source for full schema' };
  }
  return null;
}
