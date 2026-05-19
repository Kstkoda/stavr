/**
 * v0.6.11 Phase 3 — per-endpoint perf metrics.
 *
 * Lightweight in-memory reservoir of recent latency samples per logical
 * endpoint (HTTP route, MCP method, SSE broadcast bucket). Exposes:
 *
 *   - record(label, durationMs, ok) — called from a middleware / wrapper
 *   - snapshot()                    — { endpoints: { label: { count, errors, p50_ms, p95_ms, p99_ms, ... } } }
 *   - reset()                       — clear samples (kept for tests; the
 *                                     production daemon never resets,
 *                                     the rolling reservoir handles drift)
 *
 * The reservoir is a fixed-size circular buffer (default 1024 samples per
 * endpoint). Older samples roll off; percentile estimates therefore reflect
 * a roughly 1024-call sliding window. For dashboard p95/p99 that's the
 * right scope — minute-to-minute traffic, not full daemon lifetime.
 */

const RESERVOIR_SIZE = Number.parseInt(process.env.STAVR_PERF_RESERVOIR ?? '1024', 10) || 1024;

interface EndpointSamples {
  count: number;
  errors: number;
  samplesMs: Float64Array;
  cursor: number;
  filled: boolean;
}

const endpoints = new Map<string, EndpointSamples>();

function getBucket(label: string): EndpointSamples {
  let b = endpoints.get(label);
  if (!b) {
    b = { count: 0, errors: 0, samplesMs: new Float64Array(RESERVOIR_SIZE), cursor: 0, filled: false };
    endpoints.set(label, b);
  }
  return b;
}

export function recordPerf(label: string, durationMs: number, ok: boolean): void {
  if (!Number.isFinite(durationMs) || durationMs < 0) return;
  const b = getBucket(label);
  b.count++;
  if (!ok) b.errors++;
  b.samplesMs[b.cursor] = durationMs;
  b.cursor = (b.cursor + 1) % RESERVOIR_SIZE;
  if (b.cursor === 0) b.filled = true;
}

export interface PerfStats {
  count: number;
  errors: number;
  error_rate: number;
  p50_ms: number | null;
  p95_ms: number | null;
  p99_ms: number | null;
  avg_ms: number | null;
  max_ms: number | null;
  window_n: number;
}

function summarize(b: EndpointSamples): PerfStats {
  const n = b.filled ? RESERVOIR_SIZE : b.cursor;
  if (n === 0) {
    return {
      count: b.count, errors: b.errors,
      error_rate: b.count > 0 ? b.errors / b.count : 0,
      p50_ms: null, p95_ms: null, p99_ms: null, avg_ms: null, max_ms: null, window_n: 0,
    };
  }
  // Allocate sorted copy (small — at most RESERVOIR_SIZE doubles).
  const sorted: number[] = new Array(n);
  for (let i = 0; i < n; i++) sorted[i] = b.samplesMs[i];
  sorted.sort((a, x) => a - x);
  const pct = (p: number) => sorted[Math.min(n - 1, Math.floor((n * p) / 100))];
  let sum = 0;
  for (let i = 0; i < n; i++) sum += sorted[i];
  return {
    count: b.count,
    errors: b.errors,
    error_rate: b.count > 0 ? b.errors / b.count : 0,
    p50_ms: round2(pct(50)),
    p95_ms: round2(pct(95)),
    p99_ms: round2(pct(99)),
    avg_ms: round2(sum / n),
    max_ms: round2(sorted[n - 1]),
    window_n: n,
  };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

export interface PerfSnapshot {
  at: string;
  endpoints: Record<string, PerfStats>;
}

export function perfSnapshot(): PerfSnapshot {
  const out: Record<string, PerfStats> = {};
  for (const [label, b] of endpoints) out[label] = summarize(b);
  return { at: new Date().toISOString(), endpoints: out };
}

export function resetPerf(): void {
  endpoints.clear();
}

/**
 * Convenience helper: time a Promise and record the result.
 * Returns the resolved value (or rethrows after recording the error).
 */
export async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  try {
    const v = await fn();
    recordPerf(label, performance.now() - t0, true);
    return v;
  } catch (e) {
    recordPerf(label, performance.now() - t0, false);
    throw e;
  }
}
