/**
 * correlation_id ↔ OTel trace context bridging.
 * Spec: bom-diagnostics-2026.md C2.3 — `runWithCorrelation` from PR #18
 * extended to verify that spans created inside the scope share trace context.
 *
 * The bridge is implicit: OTel's ContextManager is AsyncHooks-based and rides
 * the same async hop chain as AsyncLocalStorage, so a span created inside a
 * `runWithCorrelation` scope automatically inherits whatever OTel context was
 * active at scope entry. The test verifies that two spans created in nested
 * async hops inside one `runWithCorrelation` end up under the same trace id.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getSharedOtelHarness, type SharedOtelHarness } from './otel-harness.js';
import { getCorrelationId, runWithCorrelation } from '../../src/observability/logger.js';
import { withExecuteToolSpan, withInvokeAgentSpan } from '../../src/observability/spans.js';

let shared: SharedOtelHarness;

beforeAll(() => {
  shared = getSharedOtelHarness();
});

afterEach(() => {
  shared.exporter.reset();
});

afterAll(async () => {
  await shared.shutdown();
});

describe('runWithCorrelation', () => {
  it('propagates correlation_id through nested async hops', async () => {
    const seen: Array<string | undefined> = [];
    await runWithCorrelation('cid-prop-1', async () => {
      seen.push(getCorrelationId());
      await Promise.resolve();
      seen.push(getCorrelationId());
      await new Promise((r) => setTimeout(r, 5));
      seen.push(getCorrelationId());
    });
    expect(seen).toEqual(['cid-prop-1', 'cid-prop-1', 'cid-prop-1']);
  });

  it('spans created inside one runWithCorrelation share a single trace id across nested async hops', async () => {
    await runWithCorrelation('cid-trace-1', async () => {
      await withInvokeAgentSpan({ bomId: 'bom-trace', correlationId: 'cid-trace-1' }, async () => {
        await Promise.resolve();
        await withExecuteToolSpan(
          { toolName: 'code', toolCallId: 'bom-trace:1', bomId: 'bom-trace', stepNo: 1 },
          async () => {
            await new Promise((r) => setTimeout(r, 5));
          },
        );
      });
    });
    await shared.flush();
    const spans = shared.exporter.getFinishedSpans();
    const invoke = spans.find((s) => s.name === 'invoke_agent')!;
    const tool = spans.find((s) => s.name === 'execute_tool')!;
    expect(invoke).toBeDefined();
    expect(tool).toBeDefined();
    expect(tool.spanContext().traceId).toBe(invoke.spanContext().traceId);
    expect(tool.parentSpanContext?.spanId).toBe(invoke.spanContext().spanId);
  });

  it('two separate runWithCorrelation calls produce DISTINCT trace ids', async () => {
    await runWithCorrelation('cid-trace-A', async () => {
      await withInvokeAgentSpan({ bomId: 'bom-A' }, async () => { /* */ });
    });
    await runWithCorrelation('cid-trace-B', async () => {
      await withInvokeAgentSpan({ bomId: 'bom-B' }, async () => { /* */ });
    });
    await shared.flush();
    const spans = shared.exporter.getFinishedSpans();
    const a = spans.find((s) => s.attributes['stavr.bom.id'] === 'bom-A')!;
    const b = spans.find((s) => s.attributes['stavr.bom.id'] === 'bom-B')!;
    expect(a.spanContext().traceId).not.toBe(b.spanContext().traceId);
  });
});
