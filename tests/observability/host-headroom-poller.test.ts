/**
 * Phase 2 tests for src/observability/host-headroom-poller.ts.
 *
 * Uses the scheduler + osMetrics test seams to drive the poller manually:
 * no real timers, no real os calls.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  startHostHeadroomPoller,
  staticHostHeadroomMonitor,
} from '../../src/observability/host-headroom-poller.js';
import { DEFAULT_HOST_CEILING } from '../../src/types/host-ceiling.js';

interface FakeScheduler {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(h: unknown): void;
  fire(): void;
  intervalMs: number | null;
  stopped: boolean;
}

function makeFakeScheduler(): FakeScheduler {
  let tick: (() => void) | null = null;
  let intervalMs: number | null = null;
  let stopped = false;
  return {
    setInterval(fn, ms) {
      tick = fn;
      intervalMs = ms;
      const handle = { _id: 1 };
      return handle;
    },
    clearInterval(_h) {
      stopped = true;
    },
    fire() {
      if (!tick) throw new Error('setInterval not called yet');
      tick();
    },
    get intervalMs() { return intervalMs; },
    get stopped() { return stopped; },
  };
}

function cpuFrame(busyPerCore: number, totalPerCore: number, cores = 2) {
  const idle = totalPerCore - busyPerCore;
  return Array.from({ length: cores }, () => ({
    times: { user: busyPerCore, nice: 0, sys: 0, idle, irq: 0 },
  }));
}

describe('host-headroom-poller', () => {
  it('emits a seed sample synchronously and exposes it via current()', () => {
    const scheduler = makeFakeScheduler();
    const handle = startHostHeadroomPoller({
      ceiling: DEFAULT_HOST_CEILING,
      osMetrics: {
        totalmem: () => 16 * 1024 * 1024 * 1024,
        freemem: () => 4 * 1024 * 1024 * 1024,
        cpus: () => cpuFrame(100, 1000),
      },
      scheduler,
    });

    const snap = handle.current();
    expect(snap).not.toBeNull();
    expect(snap!.ram_total_bytes).toBe(16 * 1024 * 1024 * 1024);
    expect(snap!.ram_free_gb).toBe(4);
    expect(snap!.ram_used_pct).toBeCloseTo(0.75, 5);
    // First sample has no CPU delta yet.
    expect(snap!.cpu_busy_pct).toBeNull();
    // EWMA for RAM seeds to the current value.
    expect(snap!.ram_used_pct_ewma).toBeCloseTo(0.75, 5);
    handle.stop();
    expect(scheduler.stopped).toBe(true);
  });

  it('computes CPU busy from the cpus() delta on the second tick', () => {
    const scheduler = makeFakeScheduler();
    let nthCall = 0;
    const handle = startHostHeadroomPoller({
      ceiling: DEFAULT_HOST_CEILING,
      osMetrics: {
        totalmem: () => 10 * 1024 * 1024 * 1024,
        freemem: () => 5 * 1024 * 1024 * 1024,
        cpus: () => {
          nthCall += 1;
          // First call: 100 busy / 1000 total per core.
          // Second call: 500 busy / 2000 total per core (delta: 400 busy / 1000 total = 40%).
          if (nthCall === 1) return cpuFrame(100, 1000);
          return cpuFrame(500, 2000);
        },
      },
      scheduler,
    });
    expect(handle.current()!.cpu_busy_pct).toBeNull();
    scheduler.fire();
    const snap = handle.current()!;
    expect(snap.cpu_busy_pct).toBeCloseTo(0.4, 3);
    expect(snap.cpu_busy_pct_ewma).toBeCloseTo(0.4, 3);
    handle.stop();
  });

  it('discards CPU delta when the core count changes between ticks', () => {
    const scheduler = makeFakeScheduler();
    let nthCall = 0;
    const handle = startHostHeadroomPoller({
      ceiling: DEFAULT_HOST_CEILING,
      osMetrics: {
        totalmem: () => 10 * 1024 * 1024 * 1024,
        freemem: () => 5 * 1024 * 1024 * 1024,
        cpus: () => {
          nthCall += 1;
          if (nthCall === 1) return cpuFrame(100, 1000, 4);
          return cpuFrame(500, 2000, 8); // core count changed
        },
      },
      scheduler,
    });
    scheduler.fire();
    expect(handle.current()!.cpu_busy_pct).toBeNull();
    handle.stop();
  });

  it('EWMA smooths a spike toward the running average', () => {
    const scheduler = makeFakeScheduler();
    let nthCall = 0;
    // Total/free chosen so used_pct goes 0.5 -> 0.5 -> 0.9 (a single spike).
    const free = (used: number) => Math.round(10 * 1024 * 1024 * 1024 * (1 - used));
    const seq = [0.5, 0.5, 0.9];
    const handle = startHostHeadroomPoller({
      // headroom_window much larger than the interval so the EWMA is slow.
      ceiling: { ...DEFAULT_HOST_CEILING, headroom_window_ms: 60_000 },
      intervalMs: 1_000,
      osMetrics: {
        totalmem: () => 10 * 1024 * 1024 * 1024,
        freemem: () => {
          const v = seq[Math.min(nthCall, seq.length - 1)];
          nthCall += 1;
          return free(v);
        },
        cpus: () => cpuFrame(100, 1000),
      },
      scheduler,
    });
    expect(handle.current()!.ram_used_pct_ewma).toBeCloseTo(0.5, 3);
    scheduler.fire();
    expect(handle.current()!.ram_used_pct_ewma).toBeCloseTo(0.5, 3);
    scheduler.fire();
    // After the spike, EWMA should be strictly between 0.5 and 0.9 — a slow window
    // means the EWMA didn't immediately jump to 0.9.
    const ewma = handle.current()!.ram_used_pct_ewma;
    expect(ewma).toBeGreaterThan(0.5);
    expect(ewma).toBeLessThan(0.9);
    handle.stop();
  });

  it('survives a thrown os call without leaking state', () => {
    const scheduler = makeFakeScheduler();
    let throwNext = false;
    const handle = startHostHeadroomPoller({
      ceiling: DEFAULT_HOST_CEILING,
      osMetrics: {
        totalmem: () => 8 * 1024 * 1024 * 1024,
        freemem: () => {
          if (throwNext) throw new Error('boom');
          return 4 * 1024 * 1024 * 1024;
        },
        cpus: () => cpuFrame(100, 1000),
      },
      scheduler,
    });
    const before = handle.current();
    throwNext = true;
    expect(() => scheduler.fire()).not.toThrow();
    expect(handle.current()).toBe(before);
    handle.stop();
  });

  it('publishes daemon_host_headroom to broker when provided', () => {
    const published: unknown[] = [];
    const fakeBroker = {
      publish: vi.fn(async (e: unknown) => {
        published.push(e);
        return e as never;
      }),
    } as unknown as Parameters<typeof startHostHeadroomPoller>[0]['broker'];
    const scheduler = makeFakeScheduler();
    const handle = startHostHeadroomPoller({
      ceiling: DEFAULT_HOST_CEILING,
      broker: fakeBroker,
      osMetrics: {
        totalmem: () => 8 * 1024 * 1024 * 1024,
        freemem: () => 4 * 1024 * 1024 * 1024,
        cpus: () => cpuFrame(100, 1000),
      },
      scheduler,
    });
    // Seed publish happens synchronously inside startHostHeadroomPoller.
    expect(published.length).toBe(1);
    expect((published[0] as { kind: string }).kind).toBe('daemon_host_headroom');
    scheduler.fire();
    expect(published.length).toBe(2);
    handle.stop();
  });
});

describe('staticHostHeadroomMonitor', () => {
  it('returns the supplied snapshot from current()', () => {
    const snap = {
      at: '2026-05-20T22:00:00Z',
      ram_total_bytes: 1,
      ram_free_bytes: 0.25,
      ram_used_bytes: 0.75,
      ram_used_pct: 0.75,
      ram_free_gb: 0.25,
      cpu_busy_pct: 0.5,
      cpu_busy_pct_ewma: 0.5,
      ram_used_pct_ewma: 0.75,
    };
    const m = staticHostHeadroomMonitor(snap);
    expect(m.current()).toBe(snap);
  });

  it('supports null (cold start) for fail-open admission control', () => {
    expect(staticHostHeadroomMonitor(null).current()).toBeNull();
  });
});
