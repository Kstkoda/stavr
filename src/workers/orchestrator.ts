import { createHash, randomUUID } from 'node:crypto';
import type { Broker } from '../broker.js';
import type { EventStore, WorkerRecord } from '../persistence.js';
import { DecisionTimeoutError } from '../persistence.js';
import type { EventKindT } from '../event-types.js';
import type { TrustStore } from '../trust/store.js';
import type { HostCeiling } from '../types/host-ceiling.js';
import type {
  HeadroomSnapshot,
  HostHeadroomMonitor,
} from '../observability/host-headroom-poller.js';
import {
  DispatchNotSupportedError,
  type WorkerInstance,
  type WorkerSpawner,
  type WorkerSpawnerContext,
} from './types.js';

const IDLE_AFTER_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_SPAWN_DECISION_TIMEOUT_SEC = 300;

export interface OrchestratorOptions {
  broker: Broker;
  store: EventStore;
  /**
   * Override tier gating. When omitted, `confirm` tier opens an `await_decision`
   * decision with a 300s timeout and rejects on no-response. Tests pass
   * `() => 'approve'` or similar to skip gating.
   */
  tierGate?: (req: TierGateRequest) => Promise<'approve' | 'reject'>;
  /**
   * Override the idle timer. Tests can pass `null` to disable. Default is 5min.
   */
  idleAfterMs?: number | null;
  /** Optional trust-scope store. When present, confirm-tier requests check for a
   * covering active scope and auto-approve in-scope calls without opening a
   * decision_request. See spec 46. */
  trustStore?: TrustStore;
  /**
   * Host-resource ceiling (Phase 3 of host-resource-ceiling BOM). When both
   * `ceiling` and `headroomMonitor` are provided AND ceiling.enabled is true,
   * `spawn()` refuses with OrchestratorError('headroom_exceeded') if admitting
   * the spawn would breach the ceiling. The check is fail-open: a null monitor
   * snapshot (boot, transient os error) is treated as "no data, allow".
   */
  ceiling?: HostCeiling;
  headroomMonitor?: HostHeadroomMonitor;
}

export interface TierGateRequest {
  tool: 'worker_spawn' | 'worker_dispatch' | 'worker_terminate';
  type: string;
  workerName?: string;
  workerId?: string;
  params?: unknown;
}

export interface WorkerTypeDescriptor {
  type: string;
  displayName: string;
  description: string;
  tier: 'auto' | 'confirm' | 'never';
  paramsSchema: unknown;
}

interface LiveWorker {
  record: WorkerRecord;
  instance: WorkerInstance;
  spawner: WorkerSpawner;
  idleTimer?: NodeJS.Timeout;
  detach: () => void;
}

export class WorkerOrchestrator {
  private spawners = new Map<string, WorkerSpawner>();
  private live = new Map<string, LiveWorker>();
  private readonly broker: Broker;
  private readonly store: EventStore;
  private readonly tierGate?: OrchestratorOptions['tierGate'];
  private readonly idleAfterMs: number | null;
  private readonly trustStore?: TrustStore;
  private ceiling: HostCeiling | undefined;
  private headroomMonitor: HostHeadroomMonitor | undefined;

  constructor(opts: OrchestratorOptions) {
    this.broker = opts.broker;
    this.store = opts.store;
    this.tierGate = opts.tierGate;
    this.idleAfterMs = opts.idleAfterMs === undefined ? IDLE_AFTER_MS : opts.idleAfterMs;
    this.trustStore = opts.trustStore;
    this.ceiling = opts.ceiling;
    this.headroomMonitor = opts.headroomMonitor;
  }

  /**
   * Late-bind the ceiling + headroom monitor. The daemon constructs the poller
   * after the broker is up; the orchestrator is created lazily on the first
   * MCP connection. This setter lets the daemon attach the monitor on boot
   * without requiring orchestrator construction to wait for it.
   */
  setHostCeilingContext(ctx: { ceiling: HostCeiling; monitor: HostHeadroomMonitor }): void {
    this.ceiling = ctx.ceiling;
    this.headroomMonitor = ctx.monitor;
  }

  /** Count of in-process live worker handles — readers (load-shedding, tests) use this
   * to count "currently running" without re-querying the persistence layer. */
  liveCount(): number {
    return this.live.size;
  }

  /** Snapshot of live worker IDs in spawn order. Phase 5 picks the most-recent
   * as the shed victim. */
  liveWorkerIdsInSpawnOrder(): string[] {
    return Array.from(this.live.keys());
  }

  register(spawner: WorkerSpawner): void {
    if (this.spawners.has(spawner.type)) {
      throw new Error(`worker type "${spawner.type}" already registered`);
    }
    this.spawners.set(spawner.type, spawner);
  }

  listTypes(): WorkerTypeDescriptor[] {
    return Array.from(this.spawners.values()).map((s) => ({
      type: s.type,
      displayName: s.displayName,
      description: s.description,
      tier: s.tier,
      paramsSchema: zodToSafeJson(s.paramsSchema),
    }));
  }

  status(idOrName: string): WorkerRecord | undefined {
    return this.store.getWorker(idOrName);
  }

  list(filter?: { type?: string; status?: WorkerRecord['status'] }): WorkerRecord[] {
    return this.store.listWorkers(filter);
  }

  async spawn(
    type: string,
    name: string,
    params: unknown,
  ): Promise<{ worker: WorkerRecord; gated: { tier: string; decision?: string } }> {
    const spawner = this.spawners.get(type);
    if (!spawner) throw new OrchestratorError('unknown_type', `unknown worker type: ${type}`);

    if (!this.store.nameIsAvailable(name)) {
      throw new OrchestratorError(
        'name_in_use',
        `worker name "${name}" is already in use by a non-terminated worker`,
      );
    }

    const parsed = spawner.paramsSchema.safeParse(params);
    if (!parsed.success) {
      throw new OrchestratorError(
        'invalid_params',
        `invalid params for ${type}: ${parsed.error.message}`,
      );
    }
    const validated = parsed.data;

    // host-resource-ceiling Phase 3 — admission control.
    // Runs BEFORE the tier gate: refusing on resource grounds is not the
    // operator's decision to override (they didn't ask for this resource
    // overrun). If the operator wants to spawn anyway they can disable the
    // ceiling in stavr.yaml or terminate other workers.
    const admission = this.checkAdmission();
    if (admission) {
      await this.broker.publish({
        kind: 'host_ceiling_refused',
        at: new Date().toISOString(),
        source_agent: 'stavr-workers',
        payload: {
          tool: 'worker_spawn',
          type,
          worker_name: name,
          reason: admission.reason,
          knob: admission.knob,
          current: admission.current,
          limit: admission.limit,
        },
      });
      throw new OrchestratorError('headroom_exceeded', admission.message);
    }

    const spawnReq: TierGateRequest = {
      tool: 'worker_spawn',
      type,
      workerName: name,
      params: validated,
    };
    const gate = await this.gate(spawnReq, spawner.tier);
    if (gate.decision === 'reject') {
      throw new OrchestratorError('rejected_by_user', 'spawn was rejected via await_decision');
    }

    const id = randomUUID();
    const spawnHash = hashParams({ type, name, params: validated });
    const startedAt = new Date().toISOString();

    const ctx: WorkerSpawnerContext = {
      workerId: id,
      workerName: name,
      broker: this.broker,
      store: this.store,
      emit: (kind, payload, correlationId) =>
        this.publish(kind, payload, correlationId, `worker:${type}:${name}`),
    };

    let instance: WorkerInstance;
    try {
      instance = await spawner.spawn(validated, ctx);
    } catch (err) {
      throw new OrchestratorError('spawn_failed', (err as Error).message);
    }

    const record: WorkerRecord = {
      id,
      name,
      type,
      cwd: (instance.metadata as { cwd?: string }).cwd ?? '',
      pid: instance.pid,
      status: 'running',
      started_at: startedAt,
      last_activity_at: startedAt,
      metadata: { ...instance.metadata },
      spawn_params_hash: spawnHash,
    };
    this.store.upsertWorker(record);

    const live: LiveWorker = {
      record,
      instance,
      spawner,
      detach: () => {},
    };
    const offs: Array<() => void> = [];
    offs.push(
      instance.events.on('progress', (info) => {
        this.touch(id);
        // Pass payload through so spawners that emit structured events
        // (cc.ts stream-json, etc.) survive the broker hop. Consumers that
        // only care about message keep working — payload is optional.
        const eventPayload: { id: string; message: string; payload?: unknown } = {
          id,
          message: info.message,
        };
        if (info.payload !== undefined) eventPayload.payload = info.payload;
        void this.publish('worker_progress', eventPayload, undefined, `worker:${type}:${name}`);
      }),
    );
    offs.push(
      instance.events.on('metadata', (info) => {
        const updated = this.store.updateWorkerMetadata(id, info.patch);
        if (updated) live.record = updated;
        this.touch(id);
        void this.publish('worker_metadata_changed', { id, patch: info.patch }, undefined, `worker:${type}:${name}`);
      }),
    );
    offs.push(
      instance.events.on('activity', (info) => {
        this.touch(id);
        void this.publish('worker_activity', { id, detail: info.detail }, undefined, `worker:${type}:${name}`);
      }),
    );
    offs.push(
      instance.events.on('error', (info) => {
        void this.publish(
          'worker_error',
          { id, message: info.message, recoverable: info.recoverable },
          undefined,
          `worker:${type}:${name}`,
        );
      }),
    );
    offs.push(
      instance.events.on('log', (info) => {
        this.touch(id);
        void this.publish(
          'worker_log',
          {
            worker_id: id,
            worker_name: name,
            stream: info.stream,
            format: info.format,
            ...(info.event !== undefined && { event: info.event }),
            ...(info.line !== undefined && { line: info.line }),
            ...(info.truncated && { truncated: info.truncated }),
          },
          undefined,
          `worker:${type}:${name}`,
        );
      }),
    );
    offs.push(
      instance.events.on('exit', (info) => {
        const reason: 'completed' | 'crashed' | 'terminated_by_user' =
          info.reason === 'terminated' ? 'terminated_by_user' : info.reason;
        const updated = this.store.markWorkerTerminated(id, reason, info.exitCode);
        if (updated) live.record = updated;
        this.cancelIdle(id);
        void this.publish(
          'worker_terminated',
          { id, reason, exit_code: info.exitCode },
          undefined,
          `worker:${type}:${name}`,
        );
        this.live.delete(id);
      }),
    );
    live.detach = () => {
      for (const off of offs) off();
    };
    this.live.set(id, live);
    this.armIdle(id);

    await this.publish(
      'worker_spawned',
      {
        id,
        name,
        type,
        cwd: record.cwd,
        pid: record.pid,
        metadata: record.metadata,
      },
      undefined,
      `worker:${type}:${name}`,
    );

    this.recordUnderScope(gate.scope_id, spawnReq, { worker_id: id });
    return { worker: record, gated: { tier: spawner.tier, decision: gate.decision } };
  }

  async dispatch(idOrName: string, body: unknown): Promise<{ message_id: string }> {
    const rec = this.store.getWorker(idOrName);
    if (!rec) throw new OrchestratorError('not_found', `no worker: ${idOrName}`);
    if (rec.status === 'terminated' || rec.status === 'crashed') {
      throw new OrchestratorError('worker_inactive', `worker ${rec.name} is ${rec.status}`);
    }
    const spawner = this.spawners.get(rec.type);
    if (!spawner) throw new OrchestratorError('unknown_type', `unknown worker type: ${rec.type}`);

    const dispatchReq: TierGateRequest = {
      tool: 'worker_dispatch',
      type: rec.type,
      workerId: rec.id,
      workerName: rec.name,
      params: body,
    };
    const gate = await this.gate(dispatchReq, spawner.tier);
    if (gate.decision === 'reject') {
      throw new OrchestratorError('rejected_by_user', 'dispatch was rejected via await_decision');
    }

    const messageId = randomUUID();
    const live = this.live.get(rec.id);

    if (spawner.dispatch && live) {
      try {
        await spawner.dispatch(rec, { id: messageId, body }, {
          workerId: rec.id,
          workerName: rec.name,
          broker: this.broker,
          store: this.store,
          emit: (kind, payload, correlationId) =>
            this.publish(kind, payload, correlationId, `worker:${rec.type}:${rec.name}`),
        });
      } catch (err) {
        if (err instanceof DispatchNotSupportedError) {
          throw new OrchestratorError('dispatch_not_supported', err.message);
        }
        throw err;
      }
    } else if (!spawner.dispatch) {
      throw new OrchestratorError(
        'dispatch_not_supported',
        `worker type "${rec.type}" does not support dispatch`,
      );
    }

    await this.publish(
      'worker_dispatch_request',
      { target_worker_id: rec.id, message_id: messageId, body },
      undefined,
      `worker:${rec.type}:${rec.name}`,
    );
    this.recordUnderScope(gate.scope_id, dispatchReq, { message_id: messageId });
    return { message_id: messageId };
  }

  async terminate(idOrName: string, force: boolean): Promise<{ exitCode?: number }> {
    const rec = this.store.getWorker(idOrName);
    if (!rec) throw new OrchestratorError('not_found', `no worker: ${idOrName}`);
    if (rec.status === 'terminated' || rec.status === 'crashed') {
      return { exitCode: rec.exit_code };
    }

    // Terminate is always tier `confirm` regardless of spawner tier — terminating
    // an arbitrary process is a destructive action that deserves explicit OK.
    const terminateReq: TierGateRequest = {
      tool: 'worker_terminate',
      type: rec.type,
      workerId: rec.id,
      workerName: rec.name,
    };
    const gate = await this.gate(terminateReq, 'confirm');
    if (gate.decision === 'reject') {
      throw new OrchestratorError('rejected_by_user', 'terminate was rejected via await_decision');
    }

    const live = this.live.get(rec.id);
    if (!live) {
      // No live handle (e.g., daemon restart between spawn and terminate). Best effort:
      this.store.markWorkerTerminated(rec.id, 'terminated_by_user');
      return {};
    }
    const result = await live.instance.terminate(force);
    // The instance's exit handler will mark terminated. Belt-and-suspenders:
    if (!this.store.getWorker(rec.id)?.ended_at) {
      this.store.markWorkerTerminated(rec.id, 'terminated_by_user', result.exitCode);
    }
    this.recordUnderScope(gate.scope_id, terminateReq, { exit_code: result.exitCode });
    return result;
  }

  /**
   * Phase 5 (load-shedding): terminate a worker without going through the
   * tier gate. The gate exists to prevent accidental operator kills; shed is
   * a system-level decision driven by host headroom, not the operator.
   *
   * Emits `host_ceiling_shed` with the victim worker's id + name + reason,
   * then delegates to the live instance's terminate() which fires the usual
   * `worker_terminated` event.
   *
   * Caller (load-shedder) picks the victim. This method does NOT pick.
   */
  async shedWorker(workerId: string, reason: string): Promise<{ exitCode?: number }> {
    const rec = this.store.getWorker(workerId);
    if (!rec) throw new OrchestratorError('not_found', `no worker: ${workerId}`);
    const live = this.live.get(workerId);
    if (!live) {
      // Already terminated; idempotent.
      return { exitCode: rec.exit_code };
    }
    await this.broker.publish({
      kind: 'host_ceiling_shed',
      at: new Date().toISOString(),
      source_agent: 'stavr-workers',
      payload: {
        worker_id: rec.id,
        worker_name: rec.name,
        worker_type: rec.type,
        reason,
      },
    });
    const result = await live.instance.terminate(true);
    if (!this.store.getWorker(rec.id)?.ended_at) {
      this.store.markWorkerTerminated(rec.id, 'terminated_by_user', result.exitCode);
    }
    return result;
  }

  async shutdownAll(): Promise<void> {
    const live = Array.from(this.live.values());
    await Promise.all(
      live.map(async (l) => {
        try {
          await l.instance.terminate(false);
        } catch {
          /* swallow; daemon is going down */
        }
        l.detach();
      }),
    );
    this.live.clear();
  }

  // --- internals ---

  private async gate(
    req: TierGateRequest,
    tier: 'auto' | 'confirm' | 'never',
  ): Promise<{ decision: 'approve' | 'reject' | 'skipped'; scope_id?: string }> {
    if (tier === 'never') {
      throw new OrchestratorError('tier_blocked', `tier "never" blocks ${req.tool}`);
    }
    if (tier === 'auto') return { decision: 'skipped' };
    // Trust-scope short-circuit: confirm-tier requests covered by an active scope
    // auto-approve. The action is recorded against the scope after it succeeds
    // (see post-spawn/dispatch hooks below).
    if (this.trustStore) {
      const scope = this.trustStore.findActiveScopeFor({
        tool: req.tool,
        args: scopeArgsFor(req),
      });
      if (scope) {
        await this.broker.publish({
          kind: 'trust_scope_action_authorized',
          at: new Date().toISOString(),
          source_agent: 'stavr-workers',
          payload: {
            scope_id: scope.id,
            tool: req.tool,
            args: scopeArgsFor(req),
          },
        });
        return { decision: 'approve', scope_id: scope.id };
      }
    }
    if (this.tierGate) {
      const decision = await this.tierGate(req);
      return { decision };
    }
    return this.askViaDecision(req);
  }

  /** After a successful gated worker action, record it under the covering scope. */
  private recordUnderScope(scopeId: string | undefined, req: TierGateRequest, result: unknown): void {
    if (!scopeId || !this.trustStore) return;
    this.trustStore.recordScopeAction(scopeId, req.tool, scopeArgsFor(req), result);
  }

  private async askViaDecision(
    req: TierGateRequest,
  ): Promise<{ decision: 'approve' | 'reject' }> {
    const correlationId = randomUUID();
    const question = describeTierQuestion(req);
    const options = [
      { id: 'approve', label: 'Approve' },
      { id: 'reject', label: 'Reject' },
    ];
    this.store.createDecision(
      correlationId,
      question,
      options,
      DEFAULT_SPAWN_DECISION_TIMEOUT_SEC,
      undefined,
    );
    await this.broker.publish({
      kind: 'decision_request',
      at: new Date().toISOString(),
      correlation_id: correlationId,
      source_agent: 'stavr-workers',
      payload: {
        question,
        options,
        deadline_seconds: DEFAULT_SPAWN_DECISION_TIMEOUT_SEC,
      },
    });
    try {
      const result = await this.store.awaitDecisionResponse(
        correlationId,
        DEFAULT_SPAWN_DECISION_TIMEOUT_SEC * 1000,
      );
      return { decision: result.chosen_option_id === 'approve' ? 'approve' : 'reject' };
    } catch (err) {
      if (err instanceof DecisionTimeoutError) {
        return { decision: 'reject' };
      }
      throw err;
    }
  }

  private async publish(
    kind: EventKindT,
    payload: unknown,
    correlationId: string | undefined,
    sourceAgent: string,
  ): Promise<void> {
    await this.broker.publish({
      kind,
      at: new Date().toISOString(),
      correlation_id: correlationId,
      source_agent: sourceAgent,
      payload,
    });
  }

  private touch(id: string): void {
    const updated = this.store.updateWorkerMetadata(id, {});
    const live = this.live.get(id);
    if (live && updated) {
      live.record = updated;
    }
    this.armIdle(id);
  }

  private armIdle(id: string): void {
    if (this.idleAfterMs === null) return;
    const live = this.live.get(id);
    if (!live) return;
    if (live.idleTimer) clearTimeout(live.idleTimer);
    live.idleTimer = setTimeout(() => {
      const cur = this.store.getWorker(id);
      if (!cur) return;
      if (cur.status === 'running') {
        this.store.updateWorkerStatus(id, 'idle');
      }
    }, this.idleAfterMs);
    // Bounded one-shot per ADR-012.
    if (typeof live.idleTimer.unref === 'function') live.idleTimer.unref();
  }

  private cancelIdle(id: string): void {
    const live = this.live.get(id);
    if (live?.idleTimer) {
      clearTimeout(live.idleTimer);
      live.idleTimer = undefined;
    }
  }

  /**
   * Returns an admission refusal object when admitting a new worker would
   * breach the configured host ceiling. Returns undefined to allow.
   *
   * Fail-open semantics:
   *  - No ceiling or ceiling.enabled=false → allow.
   *  - No headroomMonitor wired → allow (caller didn't opt in).
   *  - monitor.current() returns null (cold start) → allow.
   *  - sustained CPU EWMA is null (one sample so far) → skip the CPU branch;
   *    don't refuse on a single-tick sample.
   *
   * Checks in order so the most actionable refusal wins:
   *   1. max_concurrent_workers — the knob the 2026-05-20 incident violated.
   *   2. min_free_ram_gb       — hard floor.
   *   3. max_host_ram_pct      — pct ceiling.
   *   4. max_sustained_cpu_pct — only against EWMA, never raw spike.
   */
  private checkAdmission(): AdmissionRefusal | undefined {
    const c = this.ceiling;
    if (!c || !c.enabled) return undefined;

    // (1) Worker count cap. This is the only check that doesn't need a
    // headroom snapshot — counts come from the in-process map.
    if (c.max_concurrent_workers > 0 && this.live.size >= c.max_concurrent_workers) {
      return {
        reason: 'max_concurrent_workers',
        knob: 'max_concurrent_workers',
        current: this.live.size,
        limit: c.max_concurrent_workers,
        message: `worker spawn refused: ${this.live.size} live workers already, limit is ${c.max_concurrent_workers}`,
      };
    }

    const monitor = this.headroomMonitor;
    if (!monitor) return undefined;
    const snap = monitor.current();
    if (!snap) return undefined;

    // (2) Free-RAM floor.
    if (snap.ram_free_gb < c.min_free_ram_gb) {
      return {
        reason: 'min_free_ram_gb',
        knob: 'min_free_ram_gb',
        current: snap.ram_free_gb,
        limit: c.min_free_ram_gb,
        message: `worker spawn refused: ${snap.ram_free_gb.toFixed(2)} GB free RAM, floor is ${c.min_free_ram_gb} GB`,
      };
    }

    // (3) RAM pct ceiling — compare EWMA so a 200ms spike doesn't refuse.
    if (snap.ram_used_pct_ewma >= c.max_host_ram_pct) {
      return {
        reason: 'max_host_ram_pct',
        knob: 'max_host_ram_pct',
        current: snap.ram_used_pct_ewma,
        limit: c.max_host_ram_pct,
        message: `worker spawn refused: host RAM ${(snap.ram_used_pct_ewma * 100).toFixed(1)}% in use, ceiling is ${(c.max_host_ram_pct * 100).toFixed(0)}%`,
      };
    }

    // (4) Sustained CPU. Only refuse against the EWMA (sustained signal).
    if (snap.cpu_busy_pct_ewma !== null && snap.cpu_busy_pct_ewma >= c.max_sustained_cpu_pct) {
      return {
        reason: 'max_sustained_cpu_pct',
        knob: 'max_sustained_cpu_pct',
        current: snap.cpu_busy_pct_ewma,
        limit: c.max_sustained_cpu_pct,
        message: `worker spawn refused: host CPU ${(snap.cpu_busy_pct_ewma * 100).toFixed(1)}% sustained, ceiling is ${(c.max_sustained_cpu_pct * 100).toFixed(0)}%`,
      };
    }

    return undefined;
  }

  /**
   * Read-only accessor used by Phase 6 (dashboard) — returns the ceiling, the
   * latest snapshot, and the live worker count in one shot so the data
   * fetcher doesn't have to know about the monitor.
   */
  getCeilingStatus(): {
    ceiling: HostCeiling | null;
    snapshot: HeadroomSnapshot | null;
    live_workers: number;
  } {
    return {
      ceiling: this.ceiling ?? null,
      snapshot: this.headroomMonitor?.current() ?? null,
      live_workers: this.live.size,
    };
  }
}

interface AdmissionRefusal {
  reason: string;
  knob: string;
  current: number;
  limit: number;
  message: string;
}

export class OrchestratorError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

/** Build the args object that the trust matcher sees for a worker request. */
function scopeArgsFor(req: TierGateRequest): Record<string, unknown> {
  if (req.tool === 'worker_spawn') {
    return { type: req.type, name: req.workerName, params: req.params };
  }
  if (req.tool === 'worker_dispatch') {
    return { type: req.type, id_or_name: req.workerName ?? req.workerId, body: req.params };
  }
  return { type: req.type, id_or_name: req.workerName ?? req.workerId };
}

function describeTierQuestion(req: TierGateRequest): string {
  if (req.tool === 'worker_spawn') {
    return `Spawn a ${req.type} worker named "${req.workerName}"?`;
  }
  if (req.tool === 'worker_dispatch') {
    return `Send a dispatch to ${req.type} worker "${req.workerName}"?`;
  }
  return `Terminate ${req.type} worker "${req.workerName}"?`;
}

function hashParams(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 16);
}

function zodToSafeJson(schema: unknown): unknown {
  // We don't ship zod-to-json-schema as a hard dep. Return a small shape so
  // tool consumers know there is a schema; the spawner's `description` field
  // carries the human form.
  if (schema && typeof schema === 'object' && '_def' in (schema as object)) {
    const def = (schema as { _def: { typeName?: string } })._def;
    return { _kind: def.typeName ?? 'zod', _note: 'see spawner source for full schema' };
  }
  return null;
}
