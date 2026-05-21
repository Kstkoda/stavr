import { describe, expect, it } from 'vitest';
import { registry } from '../../src/observability/metrics.js';
import {
  recordOtelSpanDropped,
  recordOtelMetricDropped,
  recordScrapeFailure,
  setOtelExporterQueueSize,
  setTelemetryIngestionLag,
  setTraceCompleteness,
  countActiveSeries,
  refreshTsdbActiveSeries,
  tsdbActiveSeries,
  otelCollectorSpansDropped,
  otelCollectorMetricsDropped,
  monitoringScrapeFailures,
  otelExporterQueueSize,
  telemetryIngestionLagSeconds,
  traceCompletenessPct,
} from '../../src/observability/telemetry-pipeline.js';

describe('telemetry pipeline self-monitoring', () => {
  it('exposes the spec-named self-monitoring metrics on /metrics', async () => {
    const text = await registry.metrics();
    // Names use underscores (Prom convention) — the spec names are documented
    // in the metric help text.
    expect(text).toContain('otel_collector_spans_dropped_total');
    expect(text).toContain('otel_collector_metrics_dropped_total');
    expect(text).toContain('monitoring_scrape_failures_total');
    expect(text).toContain('otel_exporter_queue_size');
    expect(text).toContain('telemetry_ingestion_lag_seconds');
    expect(text).toContain('trace_completeness_pct');
    expect(text).toContain('tsdb_active_series');
  });

  it('recordOtelSpanDropped + recordOtelMetricDropped bump counters', async () => {
    recordOtelSpanDropped('default', 3);
    recordOtelMetricDropped('default', 2);
    const spans = (await otelCollectorSpansDropped.get()).values.find(
      (v) => v.labels.collector === 'default',
    );
    const metrics = (await otelCollectorMetricsDropped.get()).values.find(
      (v) => v.labels.collector === 'default',
    );
    expect(spans?.value ?? 0).toBeGreaterThanOrEqual(3);
    expect(metrics?.value ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('recordScrapeFailure bumps counter with target label', async () => {
    recordScrapeFailure('local-prometheus');
    const row = (await monitoringScrapeFailures.get()).values.find(
      (v) => v.labels.target === 'local-prometheus',
    );
    expect(row?.value ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('setters write the right gauges', async () => {
    setOtelExporterQueueSize('otlp-http', 17);
    setTelemetryIngestionLag('main', 4.2);
    setTraceCompleteness('stavr', 99.9);
    expect((await otelExporterQueueSize.get()).values.find((v) => v.labels.exporter === 'otlp-http')?.value).toBe(17);
    expect((await telemetryIngestionLagSeconds.get()).values.find((v) => v.labels.pipeline === 'main')?.value).toBe(4.2);
    expect((await traceCompletenessPct.get()).values.find((v) => v.labels.service === 'stavr')?.value).toBe(99.9);
  });

  it('countActiveSeries returns a positive integer and refresh writes the gauge', async () => {
    const n = await countActiveSeries();
    expect(n).toBeGreaterThan(0);
    await refreshTsdbActiveSeries();
    const v = await tsdbActiveSeries.get();
    expect(v.values[0]?.value).toBeGreaterThan(0);
  });
});
