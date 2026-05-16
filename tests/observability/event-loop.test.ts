/**
 * Event-loop lag + ELU monitor tests.
 * Spec: bom-diagnostics-2026.md C2.4.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventStore } from '../../src/persistence.js';
import { Broker } from '../../src/broker.js';
import { registry } from '../../src/observability/metrics.js';
import {
  eventLoopLagSeconds,
  eventLoopUtilization,
  startEventLoopMonitor,
  type EventLoopMonitorStop,
} from '../../src/observability/event-loop.js';

describe('startEventLoopMonitor', () => {
  let stop: EventLoopMonitorStop | undefined;

  beforeEach(() => {
    eventLoopLagSeconds.reset();
    eventLoopUtilization.reset();
  });

  afterEach(() => {
    if (stop) try { stop(); } catch { /* best effort */ }
    stop = undefined;
  });

  it('registers nodejs_eventloop_lag_seconds + nodejs_eventloop_utilization on the prom registry', () => {
    stop = startEventLoopMonitor({ promIntervalMs: 100, brokerIntervalMs: 1_000_000 });
    const names = registry.getMetricsAsArray().map((m) => m.name);
    expect(names).toContain('stavr_eventloop_lag_seconds');
    expect(names).toContain('nodejs_eventloop_utilization');
  });

  it('observes a lag histogram sample and an ELU gauge value within one promInterval', async () => {
    stop = startEventLoopMonitor({ promIntervalMs: 50, brokerIntervalMs: 1_000_000 });
    await new Promise((r) => setTimeout(r, 200));
    const text = await registry.metrics();
    // The lag histogram should have observed at least one sample.
    expect(text).toMatch(/stavr_eventloop_lag_seconds_count(?:\{[^}]*\})?\s+[1-9]/);
    // ELU gauge should have been set (value between 0 and 1, inclusive).
    // Avoid matching the `# HELP nodejs_eventloop_utilization ...` header by
    // requiring the line to also have a numeric value at its end.
    const eluMatch = text.match(/^nodejs_eventloop_utilization(?:\{[^}]*\})?\s+([0-9.eE+-]+)\s*$/m);
    expect(eluMatch).toBeTruthy();
    const elu = Number(eluMatch![1]);
    expect(elu).toBeGreaterThanOrEqual(0);
    expect(elu).toBeLessThanOrEqual(1);
  });

  it('emits a daemon_eventloop event to the broker within one brokerInterval', async () => {
    const store = new EventStore();
    store.init(':memory:');
    const broker = new Broker(store);
    stop = startEventLoopMonitor({
      promIntervalMs: 1_000_000,
      brokerIntervalMs: 100,
      broker,
    });
    await new Promise((r) => setTimeout(r, 300));
    const events = store.getEvents({ kinds: ['daemon_eventloop'], limit: 5 }).events;
    expect(events.length).toBeGreaterThan(0);
    const payload = events[0].payload as { lag_seconds_mean: number; utilization: number; sample_interval_ms: number };
    expect(typeof payload.lag_seconds_mean).toBe('number');
    expect(payload.utilization).toBeGreaterThanOrEqual(0);
    expect(payload.utilization).toBeLessThanOrEqual(1);
    expect(payload.sample_interval_ms).toBe(100);
    store.close();
  });

  it('returned stop function is idempotent', () => {
    stop = startEventLoopMonitor({ promIntervalMs: 1_000_000, brokerIntervalMs: 1_000_000 });
    stop();
    expect(() => stop!()).not.toThrow();
  });
});
