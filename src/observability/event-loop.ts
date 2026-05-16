// src/observability/event-loop.ts
//
// Event-loop lag and ELU (event-loop utilization) monitor.
// Spec: bom-diagnostics-2026.md C2.4.
//
// Two surfaces:
//   1. Prometheus histogram + gauge — exported on `/metrics` for trending /
//      alerting (p50/p90/p99 from the bucket counts, ELU 0..1).
//   2. A 60s `daemon_eventloop` broker event for after-the-fact analysis in
//      the event log. Uses the `OPERATIONAL_KINDS` retention class added in
//      PR #16 — bounded growth.
//
// Uses Node's `monitorEventLoopDelay` for fixed-resolution lag sampling
// (more accurate than ad-hoc setImmediate timing under load) and
// `performance.eventLoopUtilization()` for the ELU window. Both APIs are
// stable since Node 14.

import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { Gauge, Histogram } from 'prom-client';
import { registry } from './metrics.js';
import { getLogger } from '../log.js';
import type { Broker } from '../broker.js';

// Vitest's ESM module graph occasionally re-evaluates this file (HMR-style
// transforms across worker boundaries), which would double-register on the
// shared prom registry. Try the existing entry first; only construct when
// nothing is registered yet.
function makeLagHistogram(): Histogram<string> {
  const existing = registry.getSingleMetric('stavr_eventloop_lag_seconds');
  if (existing) return existing as Histogram<string>;
  return new Histogram({
    name: 'stavr_eventloop_lag_seconds',
    help: 'Event loop lag distribution (mean over the sampling interval), seconds',
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
    registers: [registry],
  });
}

function makeUtilizationGauge(): Gauge<string> {
  const existing = registry.getSingleMetric('nodejs_eventloop_utilization');
  if (existing) return existing as Gauge<string>;
  return new Gauge({
    name: 'nodejs_eventloop_utilization',
    help: 'Event loop utilization over the sampling interval (0..1)',
    registers: [registry],
  });
}

export const eventLoopLagSeconds = makeLagHistogram();
export const eventLoopUtilization = makeUtilizationGauge();

export interface EventLoopMonitorOpts {
  /** Prom sampling cadence. Default 5s. */
  promIntervalMs?: number;
  /** Broker event cadence. Default 60s. */
  brokerIntervalMs?: number;
  /** Resolution for the underlying `monitorEventLoopDelay`. Default 20ms. */
  resolutionMs?: number;
  /** Emit `daemon_eventloop` events on this broker. When undefined, the
   *  broker-event side is disabled (Prom metrics still flow). */
  broker?: Broker;
}

export type EventLoopMonitorStop = () => void;

/**
 * Start sampling event-loop lag + ELU. Returns a stop function (idempotent).
 * Both intervals are `.unref()`'d so they don't keep the process alive at
 * shutdown.
 */
export function startEventLoopMonitor(opts: EventLoopMonitorOpts = {}): EventLoopMonitorStop {
  const promIntervalMs = opts.promIntervalMs ?? 5_000;
  const brokerIntervalMs = opts.brokerIntervalMs ?? 60_000;
  const resolutionMs = opts.resolutionMs ?? 20;
  const broker = opts.broker;
  const logger = getLogger();

  const delay = monitorEventLoopDelay({ resolution: resolutionMs });
  delay.enable();

  let lastELU = performance.eventLoopUtilization();

  const sampleProm = (): { meanSeconds: number; utilization: number } => {
    // `delay.mean` is undefined when the histogram has not yet seen any
    // samples in the current window (e.g. immediately after a previous
    // reset on a quiet loop). Coerce to 0 — a zero observation is the
    // correct semantic for "no measurable lag this window".
    const meanNs = typeof delay.mean === 'number' && Number.isFinite(delay.mean) ? delay.mean : 0;
    const meanSeconds = meanNs / 1e9;
    eventLoopLagSeconds.observe(meanSeconds);
    const elu = performance.eventLoopUtilization(lastELU);
    eventLoopUtilization.set(elu.utilization);
    lastELU = performance.eventLoopUtilization();
    delay.reset();
    return { meanSeconds, utilization: elu.utilization };
  };

  const promHandle: ReturnType<typeof setInterval> = setInterval(sampleProm, promIntervalMs);
  promHandle.unref?.();

  let brokerHandle: ReturnType<typeof setInterval> | undefined;
  if (broker) {
    const emit = async (): Promise<void> => {
      try {
        const { meanSeconds, utilization } = sampleProm();
        await broker
          .publish({
            kind: 'daemon_eventloop' as Parameters<typeof broker.publish>[0]['kind'],
            at: new Date().toISOString(),
            source_agent: 'stavr-daemon',
            payload: {
              lag_seconds_mean: meanSeconds,
              utilization,
              sample_interval_ms: brokerIntervalMs,
            },
          })
          .catch(() => { /* publish swallows; defensive */ });
      } catch (err) {
        logger.warn('event-loop broker emit failed', { error: (err as Error).message });
      }
    };
    brokerHandle = setInterval(() => void emit(), brokerIntervalMs);
    brokerHandle.unref?.();
  }

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    try { clearInterval(promHandle); } catch { /* best effort */ }
    if (brokerHandle) try { clearInterval(brokerHandle); } catch { /* best effort */ }
    try { delay.disable(); } catch { /* best effort */ }
  };
}
