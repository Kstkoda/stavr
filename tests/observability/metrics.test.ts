import { describe, expect, it, afterEach } from 'vitest';
import {
  _resetMetricsState,
  normalizeRoute,
  normalizeSourceAgent,
  recordBrokerEvent,
  registry,
  stavrEventsEmitted,
  stavrSseSessions,
  setSseSessionsGauge,
} from '../../src/observability/metrics.js';
import type { StoredEvent } from '../../src/persistence.js';

afterEach(() => {
  _resetMetricsState();
});

function fakeStored(partial: Partial<StoredEvent> & Pick<StoredEvent, 'kind' | 'source_agent'>): StoredEvent {
  return {
    id: partial.id ?? 'evt-' + Math.random().toString(36).slice(2, 8),
    at: partial.at ?? new Date().toISOString(),
    persisted_at: partial.persisted_at ?? new Date().toISOString(),
    correlation_id: partial.correlation_id,
    tenant_id: partial.tenant_id,
    payload: partial.payload ?? null,
    kind: partial.kind,
    source_agent: partial.source_agent,
  } as StoredEvent;
}

describe('metrics registry', () => {
  it('exposes Prometheus text format with default node metrics', async () => {
    const text = await registry.metrics();
    expect(text).toMatch(/^# HELP/m);
    expect(text).toMatch(/process_cpu_seconds_total|nodejs_heap_size_total_bytes/);
    // Custom stavr metric definitions are present even when counts are zero.
    expect(text).toContain('stavr_events_emitted_total');
    expect(text).toContain('stavr_workers_alive');
    expect(text).toContain('stavr_sse_sessions');
    expect(text).toContain('stavr_http_request_duration_seconds');
    expect(text).toContain('stavr_bom_state');
  });

  it('content-type is text/plain version 0.0.4', () => {
    expect(registry.contentType).toMatch(/text\/plain.*version=0\.0\.4/);
  });
});

describe('normalizeSourceAgent', () => {
  it('keeps the worker-type prefix and drops the per-name tail', () => {
    expect(normalizeSourceAgent('worker:cc:my-task-3')).toBe('worker:cc');
    expect(normalizeSourceAgent('worker:shell:build')).toBe('worker:shell');
    expect(normalizeSourceAgent('worker:unity:scene')).toBe('worker:unity');
  });
  it('recognizes daemon, dashboard, steward, cli', () => {
    expect(normalizeSourceAgent('stavr-daemon')).toBe('stavr-daemon');
    expect(normalizeSourceAgent('dashboard')).toBe('dashboard');
    expect(normalizeSourceAgent('steward')).toBe('steward');
    expect(normalizeSourceAgent('stavr-cli')).toBe('stavr-cli');
  });
  it('falls back to other for unknown sources', () => {
    expect(normalizeSourceAgent('something-weird')).toBe('other');
    expect(normalizeSourceAgent(undefined)).toBe('unknown');
  });
});

describe('normalizeRoute', () => {
  it('keeps known top-level routes verbatim', () => {
    expect(normalizeRoute('/metrics')).toBe('/metrics');
    expect(normalizeRoute('/healthz')).toBe('/healthz');
    expect(normalizeRoute('/mcp')).toBe('/mcp');
  });
  it('collapses dashboard + debug + pair subtrees', () => {
    expect(normalizeRoute('/dashboard/home/data')).toBe('/dashboard*');
    expect(normalizeRoute('/debug/heap-snapshot')).toBe('/debug/heap-snapshot');
    expect(normalizeRoute('/debug/something-new')).toBe('/debug/*');
    expect(normalizeRoute('/pair/initiate')).toBe('/pair/initiate');
    expect(normalizeRoute('/pair/anything-else')).toBe('/pair/*');
  });
  it('lumps unknown paths into "other"', () => {
    expect(normalizeRoute('/some/random/path')).toBe('other');
  });
});

describe('recordBrokerEvent', () => {
  it('increments stavr_events_emitted_total by kind + normalized source_agent', async () => {
    const before = await stavrEventsEmitted.get();
    const beforeVal = before.values.find(
      (v) => v.labels.kind === 'worker_progress' && v.labels.source_agent === 'worker:cc',
    )?.value ?? 0;
    recordBrokerEvent(
      fakeStored({ kind: 'worker_progress', source_agent: 'worker:cc:my-task' }),
    );
    const after = await stavrEventsEmitted.get();
    const afterVal = after.values.find(
      (v) => v.labels.kind === 'worker_progress' && v.labels.source_agent === 'worker:cc',
    )?.value ?? 0;
    expect(afterVal).toBe(beforeVal + 1);
  });

  it('does not throw on payload variants', () => {
    expect(() => recordBrokerEvent(fakeStored({ kind: 'bom_approved', source_agent: 'dashboard', payload: { bom_id: 'b-1' } }))).not.toThrow();
    expect(() => recordBrokerEvent(fakeStored({ kind: 'bom_completed', source_agent: 'steward', payload: { bom_id: 'b-1' } }))).not.toThrow();
    expect(() => recordBrokerEvent(fakeStored({ kind: 'worker_spawned', source_agent: 'stavr-daemon', payload: { id: 'w-1', type: 'cc' } }))).not.toThrow();
    expect(() => recordBrokerEvent(fakeStored({ kind: 'worker_terminated', source_agent: 'stavr-daemon', payload: { id: 'w-1' } }))).not.toThrow();
  });
});

describe('setSseSessionsGauge', () => {
  it('sets the gauge to the provided value', async () => {
    setSseSessionsGauge(3);
    const v = await stavrSseSessions.get();
    expect(v.values[0]?.value).toBe(3);
    setSseSessionsGauge(0);
    const v2 = await stavrSseSessions.get();
    expect(v2.values[0]?.value).toBe(0);
  });
});
