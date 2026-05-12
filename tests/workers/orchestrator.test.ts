import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { EventStore } from '../../src/persistence.js';
import { Broker } from '../../src/broker.js';
import { WorkerOrchestrator, OrchestratorError } from '../../src/workers/orchestrator.js';
import { WorkerEventBus } from '../../src/workers/emitter.js';
import type { WorkerInstance, WorkerSpawner } from '../../src/workers/types.js';

interface MockHandle {
  spawner: WorkerSpawner;
  buses: WorkerEventBus[];
  terminations: number[];
  spawnCalls: number;
  lastInstance?: WorkerInstance;
}

function makeMockSpawner(opts: {
  type?: string;
  tier?: 'auto' | 'confirm' | 'never';
  withDispatch?: boolean;
}): MockHandle {
  const handle: MockHandle = { spawner: null as never, buses: [], terminations: [], spawnCalls: 0 };
  const spawner: WorkerSpawner<{ note?: string }> = {
    type: opts.type ?? 'mock',
    displayName: 'Mock',
    description: 'mock spawner',
    tier: opts.tier ?? 'auto',
    paramsSchema: z.object({ note: z.string().optional() }),
    async spawn(_params, _ctx): Promise<WorkerInstance> {
      handle.spawnCalls++;
      const bus = new WorkerEventBus();
      handle.buses.push(bus);
      const inst: WorkerInstance = {
        pid: 1000 + handle.spawnCalls,
        metadata: { cwd: '/tmp/mock', note: _params.note },
        events: bus,
        async terminate(force: boolean) {
          handle.terminations.push(force ? 1 : 0);
          bus.emitExit({ exitCode: 0, reason: 'terminated' });
          return { exitCode: 0 };
        },
      };
      handle.lastInstance = inst;
      return inst;
    },
    ...(opts.withDispatch
      ? {
          async dispatch(_w, _m, _ctx) {
            /* no-op; orchestrator publishes the event */
          },
        }
      : {}),
  };
  handle.spawner = spawner;
  return handle;
}

async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

describe('WorkerOrchestrator', () => {
  let store: EventStore;
  let broker: Broker;
  let orch: WorkerOrchestrator;

  beforeEach(() => {
    store = new EventStore();
    store.init(':memory:');
    broker = new Broker(store);
    orch = new WorkerOrchestrator({ broker, store, idleAfterMs: null });
  });

  afterEach(() => {
    store.close();
  });

  it('lists registered types', () => {
    const m = makeMockSpawner({ type: 'mock-a' });
    orch.register(m.spawner);
    const types = orch.listTypes();
    expect(types).toHaveLength(1);
    expect(types[0].type).toBe('mock-a');
    expect(types[0].tier).toBe('auto');
  });

  it('rejects duplicate type registration', () => {
    const m = makeMockSpawner({ type: 'dup' });
    orch.register(m.spawner);
    expect(() => orch.register(makeMockSpawner({ type: 'dup' }).spawner)).toThrow();
  });

  it('auto-tier spawn does not gate', async () => {
    const m = makeMockSpawner({ type: 'auto-mock', tier: 'auto' });
    orch.register(m.spawner);
    const { worker, gated } = await orch.spawn('auto-mock', 'w1', { note: 'hi' });
    expect(worker.status).toBe('running');
    expect(worker.pid).toBe(1001);
    expect(gated.decision).toBe('skipped');
    expect(m.spawnCalls).toBe(1);
  });

  it('confirm-tier spawn routes through gate; approval succeeds', async () => {
    const calls: Array<{ tool: string }> = [];
    orch = new WorkerOrchestrator({
      broker,
      store,
      idleAfterMs: null,
      tierGate: async (req) => {
        calls.push({ tool: req.tool });
        return 'approve';
      },
    });
    const m = makeMockSpawner({ type: 'confirm-mock', tier: 'confirm' });
    orch.register(m.spawner);
    const { worker } = await orch.spawn('confirm-mock', 'gw', {});
    expect(worker.name).toBe('gw');
    expect(calls).toEqual([{ tool: 'worker_spawn' }]);
  });

  it('confirm-tier spawn rejection prevents spawn', async () => {
    orch = new WorkerOrchestrator({
      broker,
      store,
      idleAfterMs: null,
      tierGate: async () => 'reject',
    });
    const m = makeMockSpawner({ type: 'confirm-mock', tier: 'confirm' });
    orch.register(m.spawner);
    await expect(orch.spawn('confirm-mock', 'r1', {})).rejects.toBeInstanceOf(OrchestratorError);
    expect(m.spawnCalls).toBe(0);
  });

  it('rejects duplicate worker names while one is active', async () => {
    const m = makeMockSpawner({ type: 'name-mock' });
    orch.register(m.spawner);
    await orch.spawn('name-mock', 'foo', {});
    await expect(orch.spawn('name-mock', 'foo', {})).rejects.toMatchObject({ code: 'name_in_use' });
  });

  it('allows reusing a name once the previous worker terminated', async () => {
    const m = makeMockSpawner({ type: 'lifecycle-mock' });
    orch.register(m.spawner);
    const { worker } = await orch.spawn('lifecycle-mock', 'cycle', {});
    m.buses[0].emitExit({ exitCode: 0, reason: 'completed' });
    await flush();
    const after = orch.status(worker.id);
    expect(after?.status).toBe('terminated');
    // Now name should be free.
    const second = await orch.spawn('lifecycle-mock', 'cycle', {});
    expect(second.worker.status).toBe('running');
  });

  it('progress / metadata / activity events update store and broker', async () => {
    const m = makeMockSpawner({ type: 'event-mock' });
    orch.register(m.spawner);
    const { worker } = await orch.spawn('event-mock', 'ev', {});

    m.buses[0].emitProgress({ message: 'line one' });
    m.buses[0].emitMetadata({ patch: { foo: 'bar' } });
    m.buses[0].emitActivity({ detail: 'tick' });
    await flush();

    const rec = orch.status(worker.id);
    expect(rec?.metadata.foo).toBe('bar');

    const events = store.getEvents({ kinds: ['worker_progress', 'worker_metadata_changed', 'worker_activity'] });
    const kinds = events.events.map((e) => e.kind);
    expect(kinds).toContain('worker_progress');
    expect(kinds).toContain('worker_metadata_changed');
    expect(kinds).toContain('worker_activity');
  });

  it('exit event marks worker terminated', async () => {
    const m = makeMockSpawner({ type: 'exit-mock' });
    orch.register(m.spawner);
    const { worker } = await orch.spawn('exit-mock', 'ex', {});
    m.buses[0].emitExit({ exitCode: 0, reason: 'completed' });
    await flush();
    const rec = orch.status(worker.id);
    expect(rec?.status).toBe('terminated');
    expect(rec?.termination_reason).toBe('completed');
    const ev = store.getEvents({ kinds: ['worker_terminated'] });
    expect(ev.events).toHaveLength(1);
  });

  it('dispatch is gated and emits worker_dispatch_request', async () => {
    orch = new WorkerOrchestrator({
      broker,
      store,
      idleAfterMs: null,
      tierGate: async () => 'approve',
    });
    const m = makeMockSpawner({ type: 'dispatch-mock', tier: 'confirm', withDispatch: true });
    orch.register(m.spawner);
    const { worker } = await orch.spawn('dispatch-mock', 'd1', {});
    const result = await orch.dispatch(worker.id, { instruction: 'do the thing' });
    expect(result.message_id).toBeTruthy();
    const events = store.getEvents({ kinds: ['worker_dispatch_request'] });
    expect(events.events).toHaveLength(1);
    expect((events.events[0].payload as { target_worker_id: string }).target_worker_id).toBe(worker.id);
  });

  it('dispatch fails when spawner does not declare dispatch', async () => {
    orch = new WorkerOrchestrator({
      broker,
      store,
      idleAfterMs: null,
      tierGate: async () => 'approve',
    });
    const m = makeMockSpawner({ type: 'no-dispatch-mock', tier: 'confirm', withDispatch: false });
    orch.register(m.spawner);
    const { worker } = await orch.spawn('no-dispatch-mock', 'nd', {});
    await expect(orch.dispatch(worker.id, {})).rejects.toMatchObject({ code: 'dispatch_not_supported' });
  });

  it('terminate calls the instance.terminate and updates the row', async () => {
    orch = new WorkerOrchestrator({
      broker,
      store,
      idleAfterMs: null,
      tierGate: async () => 'approve',
    });
    const m = makeMockSpawner({ type: 'term-mock' });
    orch.register(m.spawner);
    const { worker } = await orch.spawn('term-mock', 't1', {});
    const result = await orch.terminate(worker.id, false);
    expect(result.exitCode).toBe(0);
    expect(m.terminations).toHaveLength(1);
    await flush();
    const rec = orch.status(worker.id);
    expect(['terminated', 'crashed']).toContain(rec?.status);
  });
});
