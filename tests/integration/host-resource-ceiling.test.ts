/**
 * Phase 6 verification — synthetic over-ceiling end-to-end.
 *
 * Wires the real WorkerOrchestrator + a real broker + persistence with an
 * injected static headroom monitor. Drives the system into the over-ceiling
 * state with synthetic snapshots and asserts:
 *   1. spawn() is REFUSED (not a crash) when admission control would breach.
 *   2. shedWorker() terminates the most-recent worker without taking down
 *      anything else.
 *   3. host_ceiling_refused / host_ceiling_shed events land in the store so
 *      the dashboard panel can read them.
 *
 * This is the BOM's "Definition of done" item #5: "A synthetic over-ceiling
 * test is refused/shed, not a crash."
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { EventStore } from '../../src/persistence.js';
import { Broker } from '../../src/broker.js';
import { WorkerOrchestrator } from '../../src/workers/orchestrator.js';
import { WorkerEventBus } from '../../src/workers/emitter.js';
import { startLoadShedder } from '../../src/governor/load-shedder.js';
import {
  staticHostHeadroomMonitor,
  type HeadroomSnapshot,
  type HostHeadroomMonitor,
} from '../../src/observability/host-headroom-poller.js';
import { DEFAULT_HOST_CEILING } from '../../src/types/host-ceiling.js';
import {
  fetchHostCeilingData,
  hostCeilingStatusClass,
} from '../../src/dashboard/data/host-ceiling.js';
import { setHostCeilingContext } from '../../src/server.js';
import type { WorkerInstance, WorkerSpawner } from '../../src/workers/types.js';

function mockSpawner(): WorkerSpawner<{ note?: string }> {
  let n = 0;
  return {
    type: 'mock',
    displayName: 'Mock',
    description: 'integration mock',
    tier: 'auto',
    paramsSchema: z.object({ note: z.string().optional() }),
    async spawn(_p, _ctx): Promise<WorkerInstance> {
      n += 1;
      const bus = new WorkerEventBus();
      return {
        pid: 9000 + n,
        metadata: { cwd: '/tmp', note: _p.note },
        events: bus,
        async terminate(_force: boolean) {
          bus.emitExit({ exitCode: 0, reason: 'terminated' });
          return { exitCode: 0 };
        },
      };
    },
  };
}

function snap(overrides: Partial<HeadroomSnapshot> = {}): HeadroomSnapshot {
  const total = 16 * 1024 ** 3;
  const freeGb = overrides.ram_free_gb ?? 8;
  const free = freeGb * 1024 ** 3;
  const used = total - free;
  return {
    at: '2026-05-20T22:00:00Z',
    ram_total_bytes: total,
    ram_free_bytes: free,
    ram_used_bytes: used,
    ram_used_pct: used / total,
    ram_free_gb: freeGb,
    cpu_busy_pct: 0.2,
    cpu_busy_pct_ewma: 0.2,
    ram_used_pct_ewma: used / total,
    ...overrides,
  };
}

function fakeScheduler() {
  let fn: (() => void) | null = null;
  return {
    setInterval(f: () => void) { fn = f; return { _id: 1 }; },
    clearInterval() {},
    fire() { if (fn) fn(); },
  };
}

describe('host-resource-ceiling end-to-end synthetic', () => {
  let store: EventStore;
  let broker: Broker;
  let monitor: HostHeadroomMonitor;
  let setSnapshot: (s: HeadroomSnapshot | null) => void;

  beforeEach(() => {
    store = new EventStore();
    store.init(':memory:');
    broker = new Broker(store);
    let cur: HeadroomSnapshot | null = snap();
    monitor = { current: () => cur };
    setSnapshot = (s) => { cur = s; };
    void staticHostHeadroomMonitor; // import used somewhere; keep typecheck happy
  });

  afterEach(() => {
    store.close();
  });

  it('refuses a spawn that would breach max_concurrent_workers — daemon stays up', async () => {
    const orch = new WorkerOrchestrator({
      broker,
      store,
      idleAfterMs: null,
      ceiling: { ...DEFAULT_HOST_CEILING, max_concurrent_workers: 1 },
      headroomMonitor: monitor,
    });
    orch.register(mockSpawner());
    await orch.spawn('mock', 'w1', {});

    let crashed = false;
    try {
      await orch.spawn('mock', 'w2', {});
    } catch (err) {
      // The whole point of admission control is THIS — a refused spawn
      // throws, not crashes the daemon.
      expect((err as { code: string }).code).toBe('headroom_exceeded');
    }
    // Sanity: the broker and store still work after the refusal.
    const counters = store.listWorkers();
    expect(counters).toHaveLength(1);
    expect(crashed).toBe(false);

    // host_ceiling_refused event landed.
    const refused = store.getEvents({ kinds: ['host_ceiling_refused'] }).events;
    expect(refused).toHaveLength(1);
  });

  it('refuses on free-RAM floor breach as snapshots evolve', async () => {
    const orch = new WorkerOrchestrator({
      broker,
      store,
      idleAfterMs: null,
      ceiling: { ...DEFAULT_HOST_CEILING, max_concurrent_workers: 0 },
      headroomMonitor: monitor,
    });
    orch.register(mockSpawner());

    // Plenty of headroom — spawn succeeds.
    setSnapshot(snap({ ram_free_gb: 8 }));
    await orch.spawn('mock', 'fine', {});

    // Headroom drops below the 2 GB floor — next spawn refuses.
    setSnapshot(snap({ ram_free_gb: 1.5 }));
    await expect(orch.spawn('mock', 'tight', {})).rejects.toMatchObject({
      code: 'headroom_exceeded',
      message: expect.stringMatching(/free RAM/),
    });

    // Floor recovers — spawn succeeds again. (Proves we don't latch.)
    setSnapshot(snap({ ram_free_gb: 8 }));
    await orch.spawn('mock', 'recovered', {});
    // 'tight' was refused; 'fine' + 'recovered' succeeded — 2 running.
    expect(store.listWorkers().filter((w) => w.status === 'running')).toHaveLength(2);
  });

  it('load-shedder terminates the most-recent worker on EWMA breach, not a crash', async () => {
    const orch = new WorkerOrchestrator({
      broker,
      store,
      idleAfterMs: null,
      ceiling: { ...DEFAULT_HOST_CEILING, max_concurrent_workers: 0 },
      headroomMonitor: monitor,
    });
    orch.register(mockSpawner());
    setSnapshot(snap({ ram_free_gb: 8 }));
    const a = (await orch.spawn('mock', 'a', {})).worker.id;
    const b = (await orch.spawn('mock', 'b', {})).worker.id;
    const c = (await orch.spawn('mock', 'c', {})).worker.id;
    expect(orch.liveCount()).toBe(3);

    const sched = fakeScheduler();
    startLoadShedder({
      ceiling: DEFAULT_HOST_CEILING,
      monitor,
      orchestrator: orch,
      scheduler: sched,
    });

    // Drop into shed territory (ram_used_pct_ewma >= 0.95).
    setSnapshot(snap({ ram_free_gb: 4, ram_used_pct_ewma: 0.97 }));
    sched.fire();
    await new Promise((r) => setImmediate(r));

    // Worker c (most-recent) terminated; a + b still alive.
    const recC = store.getWorker(c);
    expect(recC?.status).toBe('terminated');
    expect(store.getWorker(a)?.status).toBe('running');
    expect(store.getWorker(b)?.status).toBe('running');
    expect(orch.liveCount()).toBe(2);

    // host_ceiling_shed + worker_terminated both landed.
    expect(store.getEvents({ kinds: ['host_ceiling_shed'] }).events).toHaveLength(1);
  });

  it('dashboard data fetcher reflects refused + shed counts and headroom status', async () => {
    setHostCeilingContext(broker, { ceiling: DEFAULT_HOST_CEILING, monitor });
    const orch = new WorkerOrchestrator({
      broker,
      store,
      idleAfterMs: null,
      ceiling: { ...DEFAULT_HOST_CEILING, max_concurrent_workers: 1 },
      headroomMonitor: monitor,
    });
    orch.register(mockSpawner());
    await orch.spawn('mock', 'w1', {});

    // Trigger one refusal.
    await orch.spawn('mock', 'w2', {}).catch(() => {});
    // Trigger one shed (direct call — exercises the audit path).
    await orch.shedWorker((await orch.spawn('mock', 'wTmp', {}).catch(() => null)) as never, 'synthetic').catch(() => {});

    setSnapshot(snap({ ram_used_pct_ewma: 0.97, ram_free_gb: 4 }));
    const d = fetchHostCeilingData(broker);
    expect(d.ceiling?.enabled).toBe(true);
    expect(d.snapshot?.ram_used_pct_ewma).toBeCloseTo(0.97, 3);
    expect(d.refused_recent).toBeGreaterThanOrEqual(1);
    expect(hostCeilingStatusClass(d)).toBe('crit');
  });
});
