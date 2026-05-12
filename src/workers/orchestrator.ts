import { createHash, randomUUID } from 'node:crypto';
import type { Broker } from '../broker.js';
import type { EventStore, WorkerRecord } from '../persistence.js';
import { DecisionTimeoutError } from '../persistence.js';
import type { EventKindT } from '../event-types.js';
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

  constructor(opts: OrchestratorOptions) {
    this.broker = opts.broker;
    this.store = opts.store;
    this.tierGate = opts.tierGate;
    this.idleAfterMs = opts.idleAfterMs === undefined ? IDLE_AFTER_MS : opts.idleAfterMs;
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

    const gate = await this.gate({
      tool: 'worker_spawn',
      type,
      workerName: name,
      params: validated,
    }, spawner.tier);
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
        void this.publish('worker_progress', { id, message: info.message }, undefined, `worker:${type}:${name}`);
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

    const gate = await this.gate({
      tool: 'worker_dispatch',
      type: rec.type,
      workerId: rec.id,
      workerName: rec.name,
      params: body,
    }, spawner.tier);
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
    const gate = await this.gate(
      { tool: 'worker_terminate', type: rec.type, workerId: rec.id, workerName: rec.name },
      'confirm',
    );
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
  ): Promise<{ decision: 'approve' | 'reject' | 'skipped' }> {
    if (tier === 'never') {
      throw new OrchestratorError('tier_blocked', `tier "never" blocks ${req.tool}`);
    }
    if (tier === 'auto') return { decision: 'skipped' };
    if (this.tierGate) {
      const decision = await this.tierGate(req);
      return { decision };
    }
    return this.askViaDecision(req);
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
      source_agent: 'cowire-workers',
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
}

export class OrchestratorError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
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
