import { describe, expect, it } from 'vitest';
import { EventStore } from '../../src/persistence.js';
import { Broker } from '../../src/broker.js';
import { startMemoryPoller } from '../../src/observability/memory-poller.js';

function makeFakeTimer() {
  const state: { cb?: () => void; ms?: number; cleared: boolean } = { cleared: false };
  return {
    scheduler: {
      setInterval: (fn: () => void, ms: number) => {
        state.cb = fn;
        state.ms = ms;
        return { unref: () => undefined };
      },
      clearInterval: () => {
        state.cleared = true;
      },
    },
    fire: async () => {
      if (state.cb) state.cb();
      await new Promise((r) => setImmediate(r));
    },
    get ms() { return state.ms; },
    get cleared() { return state.cleared; },
  };
}

describe('startMemoryPoller', () => {
  it('emits a daemon_memory event on first tick with rss/heap/event-count fields', async () => {
    const store = new EventStore();
    store.init(':memory:');
    const broker = new Broker(store);
    const fake = makeFakeTimer();
    const stop = startMemoryPoller(broker, {
      intervalMs: 60_000,
      scheduler: fake.scheduler,
      memoryUsage: () => ({
        rss: 100 * 1024 * 1024,
        heapTotal: 50 * 1024 * 1024,
        heapUsed: 30 * 1024 * 1024,
        external: 5 * 1024 * 1024,
        arrayBuffers: 1 * 1024 * 1024,
      }),
      sseSessionCount: () => 3,
    });

    await new Promise((r) => setImmediate(r));

    const { events } = store.getEvents({ kinds: ['daemon_memory'] });
    expect(events.length).toBeGreaterThanOrEqual(1);
    const ev = events[0];
    const p = ev.payload as Record<string, number>;
    expect(p.rss).toBe(100 * 1024 * 1024);
    expect(p.heapUsed).toBe(30 * 1024 * 1024);
    // The poller captures eventCount BEFORE its own event lands, so the
    // first tick against an empty store reads 0. Each subsequent tick
    // sees the count climb by at least 1 (the previous daemon_memory).
    expect(p.eventCount).toBe(0);
    expect(p.sseSessions).toBe(3);
    expect(ev.source_agent).toBe('stavr-daemon');

    stop();
    expect(fake.cleared).toBe(true);
  });

  it('emits again on subsequent ticks', async () => {
    const store = new EventStore();
    store.init(':memory:');
    const broker = new Broker(store);
    const fake = makeFakeTimer();
    let rss = 200 * 1024 * 1024;
    const stop = startMemoryPoller(broker, {
      intervalMs: 30_000,
      scheduler: fake.scheduler,
      memoryUsage: () => ({
        rss,
        heapTotal: 100 * 1024 * 1024,
        heapUsed: 60 * 1024 * 1024,
        external: 0,
        arrayBuffers: 0,
      }),
    });
    await new Promise((r) => setImmediate(r));
    rss = 250 * 1024 * 1024;
    await fake.fire();

    const { events } = store.getEvents({ kinds: ['daemon_memory'] });
    expect(events.length).toBe(2);
    expect((events[0].payload as { rss: number }).rss).toBe(200 * 1024 * 1024);
    expect((events[1].payload as { rss: number }).rss).toBe(250 * 1024 * 1024);

    stop();
  });

  it('uses the configured interval', () => {
    const store = new EventStore();
    store.init(':memory:');
    const broker = new Broker(store);
    const fake = makeFakeTimer();
    const stop = startMemoryPoller(broker, {
      intervalMs: 12_345,
      scheduler: fake.scheduler,
      memoryUsage: () => process.memoryUsage(),
    });
    expect(fake.ms).toBe(12_345);
    stop();
  });
});
