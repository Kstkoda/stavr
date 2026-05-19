import { describe, it, expect, vi } from 'vitest';
import { EventStore } from '../../src/persistence.js';
import { Broker } from '../../src/broker.js';
import { startRssWatchdog } from '../../src/observability/rss-watchdog.js';

function bootBroker(): Broker {
  const store = new EventStore();
  store.init(':memory:');
  return new Broker(store);
}

function fakeScheduler() {
  let scheduledFn: (() => void) | null = null;
  return {
    setInterval: (fn: () => void) => {
      scheduledFn = fn;
      return Symbol('handle');
    },
    clearInterval: () => {
      scheduledFn = null;
    },
    fire: () => scheduledFn?.(),
  };
}

describe('rss-watchdog', () => {
  it('does nothing when RSS stays under the threshold', () => {
    const broker = bootBroker();
    const publishSpy = vi.spyOn(broker, 'publish');
    const sched = fakeScheduler();
    const writeSnap = vi.fn();
    const mkdir = vi.fn();
    startRssWatchdog(broker, {
      thresholdMb: 100,
      scheduler: sched,
      memoryUsage: () => ({ rss: 50 * 1024 * 1024, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }),
      writeHeapSnapshot: writeSnap,
      mkdir,
    });
    sched.fire();
    sched.fire();
    expect(publishSpy).not.toHaveBeenCalled();
    expect(writeSnap).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
  });

  it('snapshots and publishes once when RSS crosses the threshold (edge-triggered)', () => {
    const broker = bootBroker();
    const publishSpy = vi.spyOn(broker, 'publish');
    const sched = fakeScheduler();
    const writeSnap = vi.fn().mockReturnValue('/tmp/snap.heapsnapshot');
    const mkdir = vi.fn();
    let rss = 50 * 1024 * 1024;
    startRssWatchdog(broker, {
      thresholdMb: 100,
      scheduler: sched,
      memoryUsage: () => ({ rss, heapTotal: rss, heapUsed: rss, external: 0, arrayBuffers: 0 }),
      writeHeapSnapshot: writeSnap,
      mkdir,
    });
    sched.fire();
    expect(publishSpy).not.toHaveBeenCalled();
    rss = 200 * 1024 * 1024;
    sched.fire();
    expect(writeSnap).toHaveBeenCalledTimes(1);
    expect(publishSpy).toHaveBeenCalledTimes(1);
    expect(publishSpy.mock.calls[0][0].kind).toBe('daemon_rss_watchdog');
    const payload = publishSpy.mock.calls[0][0].payload as Record<string, unknown>;
    expect(payload.rss_mb).toBe(200);
    expect(payload.threshold_mb).toBe(100);
    expect(payload.snapshot_path).toBe('/tmp/snap.heapsnapshot');

    // Edge-trigger: a second tick while still over the threshold MUST NOT
    // fire again (otherwise we'd write a snapshot every 30s during a leak,
    // burning disk). It only re-arms after RSS drops back below.
    sched.fire();
    expect(writeSnap).toHaveBeenCalledTimes(1);
    expect(publishSpy).toHaveBeenCalledTimes(1);

    rss = 50 * 1024 * 1024;
    sched.fire();
    rss = 200 * 1024 * 1024;
    sched.fire();
    expect(writeSnap).toHaveBeenCalledTimes(2);
    expect(publishSpy).toHaveBeenCalledTimes(2);
  });

  it('publishes the event even when heap snapshot fails', () => {
    const broker = bootBroker();
    const publishSpy = vi.spyOn(broker, 'publish');
    const sched = fakeScheduler();
    startRssWatchdog(broker, {
      thresholdMb: 10,
      scheduler: sched,
      memoryUsage: () => ({ rss: 100 * 1024 * 1024, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }),
      writeHeapSnapshot: () => {
        throw new Error('disk full');
      },
      mkdir: () => undefined,
    });
    sched.fire();
    expect(publishSpy).toHaveBeenCalledTimes(1);
    const payload = publishSpy.mock.calls[0][0].payload as Record<string, unknown>;
    expect(payload.snapshot_path).toBeNull();
    expect(payload.snapshot_error).toBe('disk full');
  });

  it('is a no-op when STAVR_RSS_WATCHDOG_MB=0', () => {
    const broker = bootBroker();
    const sched = fakeScheduler();
    const setIntervalSpy = vi.spyOn(sched, 'setInterval');
    const stop = startRssWatchdog(broker, {
      thresholdMb: 0,
      scheduler: sched,
    });
    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(typeof stop).toBe('function');
    stop();
  });
});

describe('/dashboard/api/diagnostics/memory', () => {
  it('returns process + db + broker shapes', async () => {
    const { mountTransports } = await import('../../src/transports.js');
    const store = new EventStore();
    store.init(':memory:');
    const broker = new Broker(store);
    const transports = await mountTransports(broker, { mode: 'daemon', port: 0, silent: true });
    try {
      const addr = transports.httpServer!.address() as { port: number };
      const r = await fetch(`http://127.0.0.1:${addr.port}/dashboard/api/diagnostics/memory`);
      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body.ok).toBe(true);
      expect(typeof body.process.rss).toBe('number');
      expect(typeof body.process.heap_used).toBe('number');
      expect(typeof body.process.uptime_seconds).toBe('number');
      expect(typeof body.db.event_count).toBe('number');
      expect(typeof body.broker.session_count).toBe('number');
      expect(typeof body.broker.sse_sessions).toBe('number');
      expect(typeof body.watchdog.rss_threshold_mb).toBe('number');
    } finally {
      await transports.shutdown();
    }
  });
});
