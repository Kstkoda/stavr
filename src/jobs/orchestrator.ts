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

const IDLE_AFTER_MS = 5 * 60 * 1000;

export interface JobOrchestratorOptions {
  broker: Broker;
  store: EventStore;
  /** Override the idle timer. Tests pass null to disable; production uses
   *  the 5-minute default. */
  idleAfterMs?: number | null;
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
  private readonly broker: Broker;
  private readonly store: EventStore;
  private readonly idleAfterMs: number | null;

  constructor(opts: JobOrchestratorOptions) {
    this.broker = opts.broker;
    this.store = opts.store;
    this.idleAfterMs = opts.idleAfterMs === undefined ? IDLE_AFTER_MS : opts.idleAfterMs;
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
      // doesn't sit forever in `dispatched`.
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

  private cancelIdle(id: string): void {
    const live = this.live.get(id);
    if (live?.idleTimer) {
      clearTimeout(live.idleTimer);
      live.idleTimer = undefined;
    }
  }
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
