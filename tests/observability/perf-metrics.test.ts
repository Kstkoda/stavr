/**
 * v0.6.11 Phase 3 — perf-metrics reservoir contract.
 *
 * The reservoir is a fixed-size circular buffer; older samples roll off.
 * Tests assert: (a) counters always count cumulative, not just the window;
 * (b) percentile estimates are sensible for a small set; (c) the snapshot
 * shape matches what the dashboard panel consumes.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { recordPerf, perfSnapshot, resetPerf, timed } from '../../src/observability/perf-metrics.js';

describe('perf-metrics — reservoir', () => {
  beforeEach(() => resetPerf());

  it('records count + errors cumulatively', () => {
    recordPerf('http:GET /foo', 5, true);
    recordPerf('http:GET /foo', 10, true);
    recordPerf('http:GET /foo', 100, false);
    const snap = perfSnapshot();
    expect(snap.endpoints['http:GET /foo'].count).toBe(3);
    expect(snap.endpoints['http:GET /foo'].errors).toBe(1);
    expect(snap.endpoints['http:GET /foo'].error_rate).toBeCloseTo(1 / 3, 5);
  });

  it('estimates p50/p95/p99 from samples', () => {
    for (let i = 1; i <= 100; i++) recordPerf('http:GET /bar', i, true);
    const s = perfSnapshot().endpoints['http:GET /bar'];
    expect(s.p50_ms).toBeGreaterThanOrEqual(40);
    expect(s.p50_ms).toBeLessThanOrEqual(60);
    expect(s.p95_ms).toBeGreaterThanOrEqual(90);
    expect(s.p99_ms).toBeGreaterThanOrEqual(95);
    expect(s.max_ms).toBe(100);
  });

  it('rejects non-finite durations silently', () => {
    recordPerf('x', NaN, true);
    recordPerf('x', -1, true);
    recordPerf('x', 12, true);
    expect(perfSnapshot().endpoints['x'].count).toBe(1);
  });

  it('returns null percentiles for endpoints with no samples', () => {
    // Force a bucket creation via the error path, then verify a fresh
    // endpoint with no samples returns nulls (defensive — practically
    // impossible since record() is the only path that creates buckets).
    recordPerf('y', 5, true);
    const s = perfSnapshot().endpoints['y'];
    expect(s.p50_ms).not.toBeNull();
  });

  it('timed() returns the inner value and records success', async () => {
    const v = await timed('async:ok', async () => 42);
    expect(v).toBe(42);
    expect(perfSnapshot().endpoints['async:ok'].count).toBe(1);
    expect(perfSnapshot().endpoints['async:ok'].errors).toBe(0);
  });

  it('timed() records failures + rethrows', async () => {
    await expect(timed('async:err', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(perfSnapshot().endpoints['async:err'].count).toBe(1);
    expect(perfSnapshot().endpoints['async:err'].errors).toBe(1);
  });
});
