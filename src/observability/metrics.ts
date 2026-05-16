// src/observability/metrics.ts
//
// Process-wide Prometheus registry. Spec: bom-diagnostics-2026.md C1.2-1.4.
//
// Exposes a global `registry` plus a handful of stavr-specific
// counters/gauges/histograms. The default Node runtime metrics
// (`process_*`, `nodejs_*`) are registered alongside via
// `prom-client.collectDefaultMetrics`.
//
// The module is import-safe: building the metric objects has no side effects on
// the daemon (just allocation). Wiring into hot paths happens in:
//   - broker.publish        -> recordBrokerEvent
//   - transports.ts         -> /metrics route + http duration middleware + sse gauge
//   - observability/event-loop -> (C2; placeholder allocated here for stability)
//
// Cardinality discipline: the BOM lists `source_agent` as a label on the events
// counter. To keep cardinality bounded we normalize source_agent into a small
// set of recognized prefixes (worker:cc, worker:shell, worker:unity, dashboard,
// steward, stavr-daemon, stavr-cli) plus an "other" bucket.

import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from 'prom-client';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StoredEvent } from '../persistence.js';

function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const rel of ['../../package.json', '../../../package.json']) {
      try {
        const raw = readFileSync(resolve(here, rel), 'utf8');
        const parsed = JSON.parse(raw) as { version?: string };
        if (parsed.version) return parsed.version;
      } catch {
        /* try next */
      }
    }
  } catch {
    /* fall through */
  }
  return process.env.STAVR_VERSION ?? '0.0.0';
}

export const registry = new Registry();
registry.setDefaultLabels({ service: 'stavr', version: readVersion() });

let defaultsCollected = false;
function ensureDefaultMetrics(): void {
  if (defaultsCollected) return;
  collectDefaultMetrics({ register: registry });
  defaultsCollected = true;
}
ensureDefaultMetrics();

// ---- Custom metrics ----

export const stavrEventsEmitted = new Counter({
  name: 'stavr_events_emitted_total',
  help: 'Total events emitted to the broker',
  labelNames: ['kind', 'source_agent'],
  registers: [registry],
});

export const stavrBomState = new Gauge({
  name: 'stavr_bom_state',
  help: 'BOM count by state',
  labelNames: ['state'],
  registers: [registry],
});

export const stavrWorkersAlive = new Gauge({
  name: 'stavr_workers_alive',
  help: 'Workers currently running',
  labelNames: ['type'],
  registers: [registry],
});

export const stavrSseSessions = new Gauge({
  name: 'stavr_sse_sessions',
  help: 'Active SSE / Streamable HTTP sessions',
  registers: [registry],
});

export const stavrHttpRequestDuration = new Histogram({
  name: 'stavr_http_request_duration_seconds',
  help: 'HTTP request duration',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
  registers: [registry],
});

// ---- Source-agent normalization ----

const KNOWN_SOURCE_PREFIXES = [
  'worker:cc',
  'worker:shell',
  'worker:unity',
  'worker:',
  'dashboard',
  'steward',
  'stavr-daemon',
  'stavr-cli',
] as const;

export function normalizeSourceAgent(raw: string | undefined): string {
  if (!raw) return 'unknown';
  for (const prefix of KNOWN_SOURCE_PREFIXES) {
    if (raw === prefix || raw.startsWith(prefix + ':') || raw.startsWith(prefix)) {
      // Use the recognized prefix (without the per-name tail) as the label value.
      // e.g. `worker:cc:my-task` -> `worker:cc`.
      if (prefix === 'worker:') return 'worker:other';
      return prefix;
    }
  }
  return 'other';
}

// ---- BOM / worker state tracking ----
//
// We maintain small in-process maps so Gauges always reflect the latest known
// state. This avoids needing a direct dependency on the EventStore from the
// metrics module and keeps the tap pure event-driven.

const bomState = new Map<string, string>(); // bom_id -> state
const workerTypeById = new Map<string, string>(); // worker_id -> type

function setBomState(bomId: string, next: string): void {
  const prev = bomState.get(bomId);
  if (prev === next) return;
  if (prev) {
    stavrBomState.labels(prev).dec();
  }
  bomState.set(bomId, next);
  stavrBomState.labels(next).inc();
}

function endBomState(bomId: string): void {
  const prev = bomState.get(bomId);
  if (!prev) return;
  stavrBomState.labels(prev).dec();
  bomState.delete(bomId);
}

function workerSpawned(id: string, type: string): void {
  if (workerTypeById.has(id)) return;
  workerTypeById.set(id, type);
  stavrWorkersAlive.labels(type).inc();
}

function workerTerminated(id: string): void {
  const type = workerTypeById.get(id);
  if (!type) return;
  workerTypeById.delete(id);
  stavrWorkersAlive.labels(type).dec();
}

/**
 * Called from `Broker.publish` after fanout. Bumps the events counter and,
 * for a handful of well-known kinds, keeps the BOM/worker gauges in sync.
 */
export function recordBrokerEvent(stored: StoredEvent): void {
  const sa = normalizeSourceAgent(stored.source_agent);
  stavrEventsEmitted.labels(stored.kind, sa).inc();

  const payload = (stored.payload ?? {}) as Record<string, unknown>;
  switch (stored.kind) {
    case 'bom_proposed':
      if (typeof payload.bom_id === 'string') setBomState(payload.bom_id, 'proposed');
      break;
    case 'bom_approved':
      if (typeof payload.bom_id === 'string') setBomState(payload.bom_id, 'running');
      break;
    case 'bom_rejected':
      if (typeof payload.bom_id === 'string') endBomState(payload.bom_id);
      break;
    case 'bom_completed':
      if (typeof payload.bom_id === 'string') endBomState(payload.bom_id);
      break;
    case 'bom_failed':
      if (typeof payload.bom_id === 'string') endBomState(payload.bom_id);
      break;
    case 'worker_spawned': {
      const id = typeof payload.id === 'string' ? payload.id : undefined;
      const type = typeof payload.type === 'string' ? payload.type : 'unknown';
      if (id) workerSpawned(id, type);
      break;
    }
    case 'worker_terminated': {
      const id = typeof payload.id === 'string' ? payload.id : undefined;
      if (id) workerTerminated(id);
      break;
    }
    default:
      break;
  }
}

/** Setter for the SSE session gauge. Called from `transports.ts` whenever the
 *  sseSessions map size changes. Idempotent. */
export function setSseSessionsGauge(n: number): void {
  stavrSseSessions.set(n);
}

/** Normalize an Express request path into a low-cardinality label value. */
export function normalizeRoute(path: string): string {
  if (!path || path === '/') return '/';
  // Known top-level routes that should keep their full path.
  const exact = new Set([
    '/metrics',
    '/healthz',
    '/status',
    '/usage',
    '/mcp',
    '/events/sse',
    '/internal/emit',
    '/pair/initiate',
    '/pair/complete',
    '/debug/heap-snapshot',
    '/debug/cpu-profile',
    '/debug/diagnostic-report',
  ]);
  if (exact.has(path)) return path;
  if (path.startsWith('/dashboard')) return '/dashboard*';
  if (path.startsWith('/debug/')) return '/debug/*';
  if (path.startsWith('/pair/')) return '/pair/*';
  return 'other';
}

/** Test seam: reset the in-process state maps. Does NOT touch registered metric
 *  values; tests that need a clean registry should construct a fresh one. */
export function _resetMetricsState(): void {
  bomState.clear();
  workerTypeById.clear();
}
