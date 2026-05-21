/**
 * Phase 3 tests for host-resource-ceiling admission control inside
 * WorkerOrchestrator.spawn().
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { EventStore } from '../../src/persistence.js';
import { Broker } from '../../src/broker.js';
import { OrchestratorError, WorkerOrchestrator } from '../../src/workers/orchestrator.js';
import { WorkerEventBus } from '../../src/workers/emitter.js';
import { staticHostHeadroomMonitor, type HeadroomSnapshot } from '../../src/observability/host-headroom-poller.js';
import { DEFAULT_HOST_CEILING } from '../../src/types/host-ceiling.js';
import type { WorkerInstance, WorkerSpawner } from '../../src/workers/types.js';

function mockSpawner(type = 'mock'): WorkerSpawner<{ note?: string }> {
  let n = 0;
  return {
    type,
    displayName: 'Mock',
    description: 'mock for admission tests',
    tier: 'auto',
    paramsSchema: z.object({ note: z.string().optional() }),
    async spawn(_p, _ctx): Promise<WorkerInstance> {
      n += 1;
      const bus = new WorkerEventBus();
      return {
        pid: 9000 + n,
        metadata: { cwd: '/tmp', note: _p.note },
        events: bus,
        async terminate(force: boolean) {
          bus.emitExit({ exitCode: 0, reason: force ? 'terminated' : 'terminated' });
          return { exitCode: 0 };
        },
      };
    },
  };
}

function snapshot(overrides: Partial<HeadroomSnapshot> = {}): HeadroomSnapshot {
  const total = 16 * 1024 * 1024 * 1024;
  const freeGb = overrides.ram_free_gb ?? 8;
  const free = freeGb * 1024 * 1024 * 1024;
  const used = total - free;
  return {
    at: '2026-05-20T22:00:00.000Z',
    ram_total_bytes: total,
    ram_free_bytes: free,
    ram_used_bytes: used,
    ram_used_pct: used / total,
    ram_free_gb: freeGb,
    cpu_busy_pct: 0.1,
    cpu_busy_pct_ewma: 0.1,
    ram_used_pct_ewma: used / total,
    ...overrides,
  };
}

describe('WorkerOrchestrator admission control', () => {
  let store: EventStore;
  let broker: Broker;

  beforeEach(() => {
    store = new EventStore();
    store.init(':memory:');
    broker = new Broker(store);
  });

  afterEach(() => {
    store.close();
  });

  it('allows spawns when the ceiling is disabled', async () => {
    const orch = new WorkerOrchestrator({
      broker,
      store,
      idleAfterMs: null,
      ceiling: { ...DEFAULT_HOST_CEILING, enabled: false, max_concurrent_workers: 1 },
      headroomMonitor: staticHostHeadroomMonitor(snapshot({ ram_free_gb: 0.1 })),
    });
    orch.register(mockSpawner());
    await expect(orch.spawn('mock', 'w1', {})).resolves.toBeDefined();
  });

  it('allows spawns when monitor returns null (fail-open during cold start)', async () => {
    const orch = new WorkerOrchestrator({
      broker,
      store,
      idleAfterMs: null,
      ceiling: DEFAULT_HOST_CEILING,
      headroomMonitor: staticHostHeadroomMonitor(null),
    });
    orch.register(mockSpawner());
    await expect(orch.spawn('mock', 'w1', {})).resolves.toBeDefined();
  });

  it('refuses spawn when live worker count meets max_concurrent_workers', async () => {
    const orch = new WorkerOrchestrator({
      broker,
      store,
      idleAfterMs: null,
      ceiling: { ...DEFAULT_HOST_CEILING, max_concurrent_workers: 2 },
      headroomMonitor: staticHostHeadroomMonitor(snapshot()),
    });
    orch.register(mockSpawner());
    await orch.spawn('mock', 'w1', {});
    await orch.spawn('mock', 'w2', {});
    expect(orch.liveCount()).toBe(2);
    await expect(orch.spawn('mock', 'w3', {})).rejects.toMatchObject({
      code: 'headroom_exceeded',
      message: expect.stringMatching(/max_concurrent_workers|live workers already/),
    });
  });

  it('refuses spawn when free RAM is below min_free_ram_gb floor', async () => {
    const orch = new WorkerOrchestrator({
      broker,
      store,
      idleAfterMs: null,
      ceiling: { ...DEFAULT_HOST_CEILING, max_concurrent_workers: 0 },
      headroomMonitor: staticHostHeadroomMonitor(snapshot({ ram_free_gb: 1.0 })),
    });
    orch.register(mockSpawner());
    await expect(orch.spawn('mock', 'w1', {})).rejects.toMatchObject({
      code: 'headroom_exceeded',
      message: expect.stringMatching(/free RAM/),
    });
  });

  it('refuses spawn when RAM EWMA exceeds max_host_ram_pct', async () => {
    const orch = new WorkerOrchestrator({
      broker,
      store,
      idleAfterMs: null,
      ceiling: { ...DEFAULT_HOST_CEILING, max_concurrent_workers: 0, min_free_ram_gb: 0 },
      headroomMonitor: staticHostHeadroomMonitor(
        snapshot({ ram_used_pct: 0.8, ram_used_pct_ewma: 0.8, ram_free_gb: 3.2 }),
      ),
    });
    orch.register(mockSpawner());
    await expect(orch.spawn('mock', 'w1', {})).rejects.toMatchObject({
      code: 'headroom_exceeded',
      message: expect.stringMatching(/host RAM/),
    });
  });

  it('refuses spawn when sustained CPU EWMA exceeds the ceiling', async () => {
    const orch = new WorkerOrchestrator({
      broker,
      store,
      idleAfterMs: null,
      ceiling: { ...DEFAULT_HOST_CEILING, max_concurrent_workers: 0, min_free_ram_gb: 0 },
      headroomMonitor: staticHostHeadroomMonitor(
        snapshot({ cpu_busy_pct: 0.9, cpu_busy_pct_ewma: 0.9 }),
      ),
    });
    orch.register(mockSpawner());
    await expect(orch.spawn('mock', 'w1', {})).rejects.toMatchObject({
      code: 'headroom_exceeded',
      message: expect.stringMatching(/CPU/),
    });
  });

  it('does NOT refuse on raw CPU spike when EWMA is below ceiling', async () => {
    const orch = new WorkerOrchestrator({
      broker,
      store,
      idleAfterMs: null,
      ceiling: { ...DEFAULT_HOST_CEILING, max_concurrent_workers: 0, min_free_ram_gb: 0 },
      headroomMonitor: staticHostHeadroomMonitor(
        snapshot({ cpu_busy_pct: 0.99, cpu_busy_pct_ewma: 0.2 }),
      ),
    });
    orch.register(mockSpawner());
    await expect(orch.spawn('mock', 'w1', {})).resolves.toBeDefined();
  });

  it('emits host_ceiling_refused on the broker when refused', async () => {
    const orch = new WorkerOrchestrator({
      broker,
      store,
      idleAfterMs: null,
      ceiling: { ...DEFAULT_HOST_CEILING, max_concurrent_workers: 1 },
      headroomMonitor: staticHostHeadroomMonitor(snapshot()),
    });
    orch.register(mockSpawner());
    await orch.spawn('mock', 'w1', {});
    await orch.spawn('mock', 'w2', {}).catch(() => {});
    const events = store.getEvents({ kinds: ['host_ceiling_refused'] }).events;
    expect(events).toHaveLength(1);
    expect((events[0].payload as { knob: string }).knob).toBe('max_concurrent_workers');
  });

  it('setHostCeilingContext can attach the ceiling after construction', async () => {
    const orch = new WorkerOrchestrator({ broker, store, idleAfterMs: null });
    orch.register(mockSpawner());
    // Before attaching: no ceiling, spawn allowed.
    await orch.spawn('mock', 'w1', {});
    orch.setHostCeilingContext({
      ceiling: { ...DEFAULT_HOST_CEILING, max_concurrent_workers: 1 },
      monitor: staticHostHeadroomMonitor(snapshot()),
    });
    await expect(orch.spawn('mock', 'w2', {})).rejects.toMatchObject({ code: 'headroom_exceeded' });
  });

  it('shedWorker bypasses the tier gate and emits host_ceiling_shed', async () => {
    const orch = new WorkerOrchestrator({
      broker,
      store,
      idleAfterMs: null,
      // confirm tier would normally gate terminate(); shedWorker should skip.
      tierGate: async () => 'reject',
    });
    orch.register(mockSpawner());
    const { worker } = await orch.spawn('mock', 'w1', {});
    expect(orch.liveCount()).toBe(1);
    const result = await orch.shedWorker(worker.id, 'synthetic-test');
    expect(result).toBeDefined();
    const shedEvents = store.getEvents({ kinds: ['host_ceiling_shed'] }).events;
    expect(shedEvents).toHaveLength(1);
    expect((shedEvents[0].payload as { worker_id: string }).worker_id).toBe(worker.id);
  });

  it('liveWorkerIdsInSpawnOrder returns ids in the order workers were spawned', async () => {
    const orch = new WorkerOrchestrator({ broker, store, idleAfterMs: null });
    orch.register(mockSpawner());
    const a = (await orch.spawn('mock', 'a', {})).worker.id;
    const b = (await orch.spawn('mock', 'b', {})).worker.id;
    const c = (await orch.spawn('mock', 'c', {})).worker.id;
    expect(orch.liveWorkerIdsInSpawnOrder()).toEqual([a, b, c]);
  });

  it('getCeilingStatus returns the wired ceiling + snapshot + live count', async () => {
    const snap = snapshot({ ram_free_gb: 6 });
    const orch = new WorkerOrchestrator({
      broker,
      store,
      idleAfterMs: null,
      ceiling: DEFAULT_HOST_CEILING,
      headroomMonitor: staticHostHeadroomMonitor(snap),
    });
    orch.register(mockSpawner());
    await orch.spawn('mock', 'w1', {});
    const status = orch.getCeilingStatus();
    expect(status.ceiling).toBe(DEFAULT_HOST_CEILING);
    expect(status.snapshot).toBe(snap);
    expect(status.live_workers).toBe(1);
    void OrchestratorError; // keep import linted
  });
});
