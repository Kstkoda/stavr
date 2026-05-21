// src/observability/telemetry-pipeline.ts
//
// Self-monitoring metrics for the telemetry pipeline itself.
// Spec: proposed/observability-metrics-spec.md — cross-cutting block:
//   otel.collector.spans.dropped
//   otel.collector.metrics.dropped
//   otel.exporter.queue.size
//   monitoring.scrape.failures
//   telemetry.ingestion.lag_seconds
//   trace.completeness_pct
//   tsdb.active_series
//
// BOM: proposed/observability-instrumentation-bom.md — Wave 0.
//
// Most of the values flow from hot paths via the small `record*()` helpers
// below. `tsdb_active_series` is derived from the registry itself — the
// poller counts every registered series so cardinality drift shows up
// in trending and alerts.
//
// Cardinality discipline: labels are bounded — `collector` and `exporter`
// from a small allow-list, `target` from a configured scrape list,
// `pipeline` and `service` similarly bounded.

import { Counter, Gauge } from 'prom-client';
import { registry } from './metrics.js';

// ---- Counters ----

function makeCounter(name: string, help: string, labelNames: string[]): Counter<string> {
  const existing = registry.getSingleMetric(name);
  if (existing) return existing as Counter<string>;
  return new Counter({ name, help, labelNames, registers: [registry] });
}

function makeGauge(name: string, help: string, labelNames: string[] = []): Gauge<string> {
  const existing = registry.getSingleMetric(name);
  if (existing) return existing as Gauge<string>;
  return new Gauge({ name, help, labelNames, registers: [registry] });
}

export const otelCollectorSpansDropped = makeCounter(
  'otel_collector_spans_dropped_total',
  'OTel collector spans dropped (spec name otel.collector.spans.dropped). Warn on any.',
  ['collector'],
);

export const otelCollectorMetricsDropped = makeCounter(
  'otel_collector_metrics_dropped_total',
  'OTel collector metrics dropped (spec name otel.collector.metrics.dropped). Warn on any.',
  ['collector'],
);

export const monitoringScrapeFailures = makeCounter(
  'monitoring_scrape_failures_total',
  'Failed Prometheus scrapes seen from the daemon side (spec name monitoring.scrape.failures). Warn >0.',
  ['target'],
);

// ---- Gauges ----

export const otelExporterQueueSize = makeGauge(
  'otel_exporter_queue_size',
  'OTel BatchSpanProcessor queue depth (spec name otel.exporter.queue.size). Warn >80% capacity.',
  ['exporter'],
);

export const telemetryIngestionLagSeconds = makeGauge(
  'telemetry_ingestion_lag_seconds',
  'Lag of last successful telemetry ingest, seconds (spec name telemetry.ingestion.lag_seconds). Warn >60s.',
  ['pipeline'],
);

export const traceCompletenessPct = makeGauge(
  'trace_completeness_pct',
  'Fraction of finished traces with no orphan spans (spec name trace.completeness_pct). Warn <95.',
  ['service'],
);

export const tsdbActiveSeries = makeGauge(
  'tsdb_active_series',
  'Active series count across the local Prometheus registry (spec name tsdb.active_series). Cardinality watch.',
);

// ---- Small recorders for hot-path callers ----

export function recordOtelSpanDropped(collector: string = 'default', n: number = 1): void {
  otelCollectorSpansDropped.labels(collector).inc(n);
}

export function recordOtelMetricDropped(collector: string = 'default', n: number = 1): void {
  otelCollectorMetricsDropped.labels(collector).inc(n);
}

export function recordScrapeFailure(target: string): void {
  monitoringScrapeFailures.labels(target).inc();
}

export function setOtelExporterQueueSize(exporter: string, depth: number): void {
  otelExporterQueueSize.labels(exporter).set(depth);
}

export function setTelemetryIngestionLag(pipeline: string, seconds: number): void {
  telemetryIngestionLagSeconds.labels(pipeline).set(seconds);
}

export function setTraceCompleteness(service: string, pct: number): void {
  traceCompletenessPct.labels(service).set(pct);
}

// ---- Active-series poller ----
//
// The prom-client `Registry` exposes every metric via `getMetricsAsJSON()`.
// Each entry has `.values` — one row per label-set. We sum to get the
// total live series count. This is the same arithmetic the Prometheus
// scraper would do downstream; surfacing it on the daemon lets the
// operator alert on cardinality drift before TSDB explodes.

export async function countActiveSeries(): Promise<number> {
  let total = 0;
  try {
    const all = await registry.getMetricsAsJSON();
    for (const m of all) {
      const values = (m as { values?: unknown[] }).values;
      if (Array.isArray(values)) total += values.length;
    }
  } catch { /* metrics never throw */ }
  return total;
}

export async function refreshTsdbActiveSeries(): Promise<void> {
  tsdbActiveSeries.set(await countActiveSeries());
}

export interface TelemetryPipelinePollerOpts {
  /** Default 30 seconds. */
  pollIntervalMs?: number;
}

export type TelemetryPipelinePollerStop = () => void;

export function startTelemetryPipelineMonitor(opts: TelemetryPipelinePollerOpts = {}): TelemetryPipelinePollerStop {
  const intervalMs = opts.pollIntervalMs ?? 30_000;
  void refreshTsdbActiveSeries();
  const handle: ReturnType<typeof setInterval> = setInterval(() => {
    void refreshTsdbActiveSeries();
  }, intervalMs);
  handle.unref?.();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    try { clearInterval(handle); } catch { /* best effort */ }
  };
}
