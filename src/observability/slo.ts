// src/observability/slo.ts
//
// SLO definitions and multi-window burn-rate computation.
// Spec: proposed/observability-metrics-spec.md — Rule 1 "burn-rate first",
// row `slo.error_budget.burn_rate` (page >14.4× fast, warn >1× slow).
// BOM: proposed/observability-instrumentation-bom.md — Wave 0.
//
// One burn-rate alert replaces dozens of static thresholds; this module is
// the substrate.
//
// Design
// ------
// Three SLOs are pinned for stavR today:
//
//   gateway_availability    — fraction of /mcp + /events/sse + /healthz
//                             gateway requests that returned a non-5xx
//                             status. Target 99.9% (errorBudgetRatio
//                             1e-3). Wired from the express middleware in
//                             transports.ts.
//   gateway_latency_p95     — fraction of gateway requests that finished
//                             within 500ms. Target 95%. Wired from the
//                             same express middleware.
//   llm_provider_availability — fraction of LLM provider calls that
//                             returned a success status. Target 99%
//                             (errorBudgetRatio 1e-2). Wired from
//                             recordProviderRequest in metrics.ts.
//
// For each SLO we keep a ring of 1-minute buckets (good, total). The
// burn-rate gauge is updated by `startSloPoller()` every `pollIntervalMs`
// (default 30s) and emits the multi-window pair the SRE workbook calls
// for: a fast window (5 minutes) and a slow window (1 hour). The gauge
// is `slo_error_budget_burn_rate{slo,window}`.
//
// Hot-path callers use `recordSloSample(name, success)`. The bookkeeping
// is O(1) and lock-free (single-threaded Node event loop).
//
// Cardinality discipline (BOM Rule 2)
// ----------------------------------
// Labels are bounded: `slo` is the name from a fixed enum; `window` is one
// of `5m` / `1h`. No request_id / user_id / session_id is ever attached.

import { Gauge } from 'prom-client';
import { registry } from './metrics.js';

export const SLO_NAMES = [
  'gateway_availability',
  'gateway_latency_p95',
  'llm_provider_availability',
] as const;

export type SloName = (typeof SLO_NAMES)[number];

export interface SloDef {
  name: SloName;
  /** Success-rate target as a fraction in (0, 1]. Eg 0.999. */
  target: number;
  /** Convenience: 1 - target. */
  errorBudgetRatio: number;
  /** Optional latency threshold in seconds — only meaningful for latency
   *  SLOs where the hot path decides "good" = "within threshold". */
  latencyThresholdSeconds?: number;
}

export const SLO_DEFS: Record<SloName, SloDef> = {
  gateway_availability: {
    name: 'gateway_availability',
    target: 0.999,
    errorBudgetRatio: 1 - 0.999,
  },
  gateway_latency_p95: {
    name: 'gateway_latency_p95',
    target: 0.95,
    errorBudgetRatio: 1 - 0.95,
    latencyThresholdSeconds: 0.5,
  },
  llm_provider_availability: {
    name: 'llm_provider_availability',
    target: 0.99,
    errorBudgetRatio: 1 - 0.99,
  },
};

interface Bucket {
  /** Unix ms at the start of this 1-minute bucket. */
  t0: number;
  good: number;
  total: number;
}

const BUCKET_MS = 60_000; // 1 minute per bucket
const BUCKET_COUNT = 60; // ring length — 60 minutes of history

// Per-SLO ring buffer. We don't bother with object pooling; 60×3=180
// objects is nothing.
const rings: Record<SloName, Bucket[]> = {
  gateway_availability: makeRing(),
  gateway_latency_p95: makeRing(),
  llm_provider_availability: makeRing(),
};

function makeRing(): Bucket[] {
  const ring: Bucket[] = new Array(BUCKET_COUNT);
  const now = floorToBucket(Date.now());
  for (let i = 0; i < BUCKET_COUNT; i++) {
    ring[i] = { t0: now - i * BUCKET_MS, good: 0, total: 0 };
  }
  return ring;
}

function floorToBucket(ms: number): number {
  return ms - (ms % BUCKET_MS);
}

function bucketFor(ring: Bucket[], nowMs: number): Bucket {
  const t0 = floorToBucket(nowMs);
  // Slot index by minute-of-hour. Rolling over is fine — we rewrite the
  // bucket if its t0 doesn't match the current minute (handles wraparound
  // and long idle gaps without complicated math).
  const idx = Math.floor((nowMs / BUCKET_MS) % BUCKET_COUNT);
  const b = ring[idx];
  if (b.t0 !== t0) {
    b.t0 = t0;
    b.good = 0;
    b.total = 0;
  }
  return b;
}

/** Record one sample against an SLO. O(1). Never throws. */
export function recordSloSample(name: SloName, success: boolean): void {
  const ring = rings[name];
  if (!ring) return;
  const b = bucketFor(ring, Date.now());
  b.total += 1;
  if (success) b.good += 1;
}

/** Test seam — zeroes every bucket so unit tests start clean. */
export function _resetSloState(): void {
  for (const name of SLO_NAMES) {
    rings[name] = makeRing();
  }
}

interface WindowSnapshot {
  good: number;
  total: number;
  failureRatio: number;
  burnRate: number;
}

/**
 * Sum buckets covering the last `windowMs` and compute the failure ratio
 * and burn rate. burnRate = failureRatio / errorBudgetRatio. When `total`
 * is 0 the burn rate is 0 (no traffic = no burn).
 */
export function snapshotWindow(name: SloName, windowMs: number, nowMs: number = Date.now()): WindowSnapshot {
  const def = SLO_DEFS[name];
  const ring = rings[name];
  const since = nowMs - windowMs;
  let good = 0;
  let total = 0;
  for (const b of ring) {
    if (b.t0 + BUCKET_MS <= since) continue;
    if (b.t0 > nowMs) continue;
    good += b.good;
    total += b.total;
  }
  const failureRatio = total > 0 ? (total - good) / total : 0;
  const burnRate = def.errorBudgetRatio > 0 ? failureRatio / def.errorBudgetRatio : 0;
  return { good, total, failureRatio, burnRate };
}

// ---- Prometheus surface ----

function makeBurnRateGauge(): Gauge<string> {
  const existing = registry.getSingleMetric('slo_error_budget_burn_rate');
  if (existing) return existing as Gauge<string>;
  return new Gauge({
    name: 'slo_error_budget_burn_rate',
    help: 'Multi-window error-budget burn rate per SLO. Page >14.4 fast, warn >1 slow. Spec name slo.error_budget.burn_rate.',
    labelNames: ['slo', 'window'],
    registers: [registry],
  });
}

export const sloErrorBudgetBurnRate = makeBurnRateGauge();

const WINDOWS: Array<{ label: '5m' | '1h'; ms: number }> = [
  { label: '5m', ms: 5 * 60_000 },
  { label: '1h', ms: 60 * 60_000 },
];

/** Recompute every (slo, window) burn-rate and set the gauge. Cheap —
 *  3 SLOs × 2 windows × at-most-60-bucket scans. */
export function refreshSloBurnRates(nowMs: number = Date.now()): void {
  for (const name of SLO_NAMES) {
    for (const w of WINDOWS) {
      const snap = snapshotWindow(name, w.ms, nowMs);
      sloErrorBudgetBurnRate.labels(name, w.label).set(snap.burnRate);
    }
  }
}

export interface SloPollerOpts {
  /** Default 30 seconds. */
  pollIntervalMs?: number;
}

export type SloPollerStop = () => void;

/** Start the background SLO poller. Returns a stop function (idempotent).
 *  The interval handle is .unref()'d so it does not keep the process alive. */
export function startSloPoller(opts: SloPollerOpts = {}): SloPollerStop {
  const intervalMs = opts.pollIntervalMs ?? 30_000;
  // Emit one refresh immediately so /metrics exposes the series even on
  // a freshly-started daemon with no traffic yet.
  refreshSloBurnRates();
  const handle: ReturnType<typeof setInterval> = setInterval(() => {
    try {
      refreshSloBurnRates();
    } catch { /* metrics never throw */ }
  }, intervalMs);
  handle.unref?.();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    try { clearInterval(handle); } catch { /* best effort */ }
  };
}
