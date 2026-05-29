/**
 * Phase 5 tests for src/governor/load-shedder.ts.
 */
import { describe, expect, it } from 'vitest';
import { startLoadShedder, type SheddableOrchestrator } from '../../src/governor/load-shedder.js';
import {
  staticHostHeadroomMonitor,
  type HeadroomSnapshot,
  type HostHeadroomMonitor,
} from '../../src/observability/host-headroom-poller.js';
import { DEFAULT_HOST_CEILING } from '../../src/types/host-ceiling.js';

function fakeScheduler() {
  let fn: (() => void) | null = null;
  let stopped = false;
  return {
    setInterval(f: () => void, _ms: number) {
      fn = f;
      return { _id: 1 };
    },
    clearInterval(_h: unknown) {
      stopped = true;
    },
    fire() {
      if (!fn) throw new Error('scheduler not armed');
      fn();
    },
    get stopped() { return stopped; },
  };
}

function mutableMonitor(initial: HeadroomSnapshot | null): {
  monitor: HostHeadroomMonitor;
  set(next: HeadroomSnapshot | null): void;
} {
  let cur = initial;
  return {
    monitor: { current: () => cur },
    set(next) { cur = next; },
  };
}

function snapshot(overrides: Partial<HeadroomSnapshot> = {}): HeadroomSnapshot {
  return {
    at: '2026-05-20T22:00:00Z',
    ram_total_bytes: 16 * 1024 ** 3,
    ram_free_bytes: 4 * 1024 ** 3,
    ram_used_bytes: 12 * 1024 ** 3,
    ram_used_pct: 0.75,
    ram_used_pct_ewma: 0.75,
    ram_free_gb: 4,
    cpu_busy_pct: 0.5,
    cpu_busy_pct_ewma: 0.5,
    ...overrides,
  };
}

function makeFakeOrch(ids: string[]): SheddableOrchestrator & { shed: string[] } {
  const shed: string[] = [];
  return {
    liveCount: () => ids.length - shed.length,
    liveJobIdsInDispatchOrder: () => ids.filter((i) => !shed.includes(i)),
    shedJob: async (id, _reason) => {
      shed.push(id);
      return { exitCode: 0 };
    },
    shed,
  };
}

describe('startLoadShedder', () => {
  it('no-ops when ceiling is disabled', () => {
    const sched = fakeScheduler();
    const stop = startLoadShedder({
      ceiling: { ...DEFAULT_HOST_CEILING, enabled: false },
      monitor: staticHostHeadroomMonitor(snapshot({ ram_used_pct_ewma: 0.99 })),
      orchestrator: makeFakeOrch(['a']),
      scheduler: sched,
    });
    // Disabled means setInterval was never called — sched still has no fn.
    expect(() => sched.fire()).toThrow();
    stop();
  });

  it('does not shed when headroom is healthy', async () => {
    const sched = fakeScheduler();
    const orch = makeFakeOrch(['a', 'b']);
    startLoadShedder({
      ceiling: DEFAULT_HOST_CEILING,
      monitor: staticHostHeadroomMonitor(snapshot()),
      orchestrator: orch,
      scheduler: sched,
    });
    sched.fire();
    await new Promise((r) => setImmediate(r));
    expect(orch.shed).toEqual([]);
  });

  it('sheds the most-recent job when ram_used_pct_ewma is over the threshold', async () => {
    const sched = fakeScheduler();
    const orch = makeFakeOrch(['oldest', 'mid', 'newest']);
    startLoadShedder({
      ceiling: DEFAULT_HOST_CEILING, // shed_threshold_pct 0.95
      monitor: staticHostHeadroomMonitor(snapshot({ ram_used_pct_ewma: 0.98, ram_free_gb: 4 })),
      orchestrator: orch,
      scheduler: sched,
    });
    sched.fire();
    await new Promise((r) => setImmediate(r));
    expect(orch.shed).toEqual(['newest']);
  });

  it('sheds when ram_free_gb falls under shed_min_free_ram_gb (even if pct is fine)', async () => {
    const sched = fakeScheduler();
    const orch = makeFakeOrch(['a', 'b']);
    startLoadShedder({
      ceiling: DEFAULT_HOST_CEILING, // shed_min_free_ram_gb 0.5
      monitor: staticHostHeadroomMonitor(
        snapshot({ ram_used_pct_ewma: 0.4, ram_free_gb: 0.25 }),
      ),
      orchestrator: orch,
      scheduler: sched,
    });
    sched.fire();
    await new Promise((r) => setImmediate(r));
    expect(orch.shed).toEqual(['b']);
  });

  it('respects the cooldown — does not shed twice inside headroom_window_ms', async () => {
    const sched = fakeScheduler();
    const orch = makeFakeOrch(['a', 'b', 'c']);
    let now = 1_000_000;
    const mon = mutableMonitor(snapshot({ ram_used_pct_ewma: 0.99, ram_free_gb: 4 }));
    startLoadShedder({
      ceiling: { ...DEFAULT_HOST_CEILING, headroom_window_ms: 10_000 },
      monitor: mon.monitor,
      orchestrator: orch,
      scheduler: sched,
      now: () => now,
    });
    sched.fire();
    await new Promise((r) => setImmediate(r));
    expect(orch.shed).toEqual(['c']);
    // Still over threshold, but inside cooldown.
    now += 5_000;
    sched.fire();
    await new Promise((r) => setImmediate(r));
    expect(orch.shed).toEqual(['c']);
    // Past cooldown — another shed.
    now += 6_000;
    sched.fire();
    await new Promise((r) => setImmediate(r));
    expect(orch.shed).toEqual(['c', 'b']);
  });

  it('resets the cooldown when headroom recovers', async () => {
    const sched = fakeScheduler();
    const orch = makeFakeOrch(['a', 'b']);
    let now = 1_000_000;
    const mon = mutableMonitor(snapshot({ ram_used_pct_ewma: 0.99, ram_free_gb: 4 }));
    startLoadShedder({
      ceiling: { ...DEFAULT_HOST_CEILING, headroom_window_ms: 60_000 },
      monitor: mon.monitor,
      orchestrator: orch,
      scheduler: sched,
      now: () => now,
    });
    sched.fire();
    await new Promise((r) => setImmediate(r));
    expect(orch.shed).toEqual(['b']);
    // Headroom recovers.
    mon.set(snapshot({ ram_used_pct_ewma: 0.5, ram_free_gb: 8 }));
    now += 1_000;
    sched.fire();
    await new Promise((r) => setImmediate(r));
    expect(orch.shed).toEqual(['b']);
    // Stress returns — cooldown was reset on the recovery tick, so we shed
    // even though it's been less than headroom_window_ms since the last shed.
    mon.set(snapshot({ ram_used_pct_ewma: 0.99, ram_free_gb: 4 }));
    now += 1_000;
    sched.fire();
    await new Promise((r) => setImmediate(r));
    expect(orch.shed).toEqual(['b', 'a']);
  });

  it('does nothing when there are no live jobs', async () => {
    const sched = fakeScheduler();
    const orch = makeFakeOrch([]);
    startLoadShedder({
      ceiling: DEFAULT_HOST_CEILING,
      monitor: staticHostHeadroomMonitor(snapshot({ ram_used_pct_ewma: 0.99, ram_free_gb: 0.1 })),
      orchestrator: orch,
      scheduler: sched,
    });
    sched.fire();
    await new Promise((r) => setImmediate(r));
    expect(orch.shed).toEqual([]);
  });

  it('skips when the monitor returns null (cold start)', async () => {
    const sched = fakeScheduler();
    const orch = makeFakeOrch(['a']);
    startLoadShedder({
      ceiling: DEFAULT_HOST_CEILING,
      monitor: staticHostHeadroomMonitor(null),
      orchestrator: orch,
      scheduler: sched,
    });
    sched.fire();
    await new Promise((r) => setImmediate(r));
    expect(orch.shed).toEqual([]);
  });

  it('swallows shedJob throws and continues on next tick', async () => {
    const sched = fakeScheduler();
    let calls = 0;
    const orch: SheddableOrchestrator = {
      liveCount: () => 2,
      liveJobIdsInDispatchOrder: () => ['x', 'y'],
      shedJob: async () => {
        calls += 1;
        throw new Error('boom');
      },
    };
    startLoadShedder({
      ceiling: DEFAULT_HOST_CEILING,
      monitor: staticHostHeadroomMonitor(snapshot({ ram_used_pct_ewma: 0.99 })),
      orchestrator: orch,
      scheduler: sched,
    });
    sched.fire();
    await new Promise((r) => setImmediate(r));
    expect(calls).toBe(1);
    // No cooldown set because lastShedAt is only updated on success.
    sched.fire();
    await new Promise((r) => setImmediate(r));
    expect(calls).toBe(2);
  });
});
