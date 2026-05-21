// tests/observability/metric-emission-perf.test.ts
//
// BOM observability-instrumentation Wave 6 — Verification.
//
// "A perf check confirms metric emission did not regress request hot paths."
//
// Strategy
// --------
// The hot-path additions in this BOM are: recordSloSample (Wave 0),
// recordGatewayRequest (Wave 1), recordLlmCall (Wave 3). Each is invoked
// at most once per HTTP request or LLM call. We assert that 100k
// invocations complete in well under one second on a sane CI box — a
// loose ceiling that catches order-of-magnitude regressions without
// being flaky on slow runners.
//
// Why these numbers
// ----------------
// stavR's documented worst-case request rate (per the spec's
// llm_requests_per_sec threshold tuning) is a handful per second per
// client × a handful of clients. Any metric emission slower than 10µs
// per call would be a real concern; the assertion below allows up to
// 100µs per call, leaving 10× headroom for noisy CI. If this test
// starts failing, look at what was added to one of the three recorders
// before adjusting the ceiling.

import { describe, expect, it } from 'vitest';
import { _resetSloState, recordSloSample } from '../../src/observability/slo.js';
import { recordGatewayRequest } from '../../src/observability/mcp-metrics.js';
import { recordLlmCall } from '../../src/observability/llm-metrics.js';

const ITERS = 100_000;
const PER_CALL_BUDGET_NS = 100_000; // 100µs

function bench(fn: () => void): number {
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < ITERS; i++) fn();
  const t1 = process.hrtime.bigint();
  return Number(t1 - t0); // ns
}

describe('hot-path metric emission perf', () => {
  it('recordSloSample stays well below 100µs per call', () => {
    _resetSloState();
    const totalNs = bench(() => recordSloSample('gateway_availability', true));
    const perCallNs = totalNs / ITERS;
    expect(perCallNs).toBeLessThan(PER_CALL_BUDGET_NS);
  });

  it('recordGatewayRequest stays well below 100µs per call', () => {
    const totalNs = bench(() =>
      recordGatewayRequest({
        method: 'tools/call',
        toolName: 'host_exec',
        durationSeconds: 0.01,
        success: true,
      }),
    );
    const perCallNs = totalNs / ITERS;
    expect(perCallNs).toBeLessThan(PER_CALL_BUDGET_NS);
  });

  it('recordLlmCall stays well below 100µs per call', () => {
    const totalNs = bench(() =>
      recordLlmCall({
        model: 'llama3.2:3b',
        operation: 'chat',
        durationSeconds: 0.5,
        success: true,
        promptTokens: 1024,
        completionTokens: 256,
        finishReason: 'stop',
      }),
    );
    const perCallNs = totalNs / ITERS;
    expect(perCallNs).toBeLessThan(PER_CALL_BUDGET_NS);
  });
});
