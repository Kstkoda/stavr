/**
 * OTel SDK + GenAI/MCP semconv span tests.
 * Spec: bom-diagnostics-2026.md C2.2 / C2.3.
 *
 * Uses an InMemorySpanExporter wired directly into the NodeSDK rather than
 * standing up a real OTLP receiver — the contract we care about is "stavr
 * emits spans with the canonical GenAI attribute names", not "stavr can
 * push them over the wire" (the wire path is the OTel SDK's responsibility).
 *
 * IMPORTANT: OTel's `trace.setGlobalTracerProvider` accepts exactly one
 * registration per process. Calling startOtel() a second time is a no-op as
 * far as the API global is concerned. So we register ONE SDK across the
 * whole file in `beforeAll`, reset the in-memory exporter between tests, and
 * shut down in `afterAll`. The same pattern is used by correlation.test.ts —
 * the two files happen to share the same global registration when run
 * together; the helpers handle that fine because they only read the global
 * tracer.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { getSharedOtelHarness, type SharedOtelHarness } from './otel-harness.js';
import {
  GEN_AI_AGENT_NAME,
  GEN_AI_MCP_METHOD,
  GEN_AI_MCP_SESSION_ID,
  GEN_AI_MCP_TOOL_NAME,
  GEN_AI_OPERATION_NAME,
  GEN_AI_TOOL_NAME,
  STAVR_BROKER_EVENT_NAME,
  addBrokerSpanEvent,
  attachMcpAttributes,
  recordTokenUsage,
  withExecuteToolSpan,
  withInvokeAgentSpan,
} from '../../src/observability/spans.js';
import { startOtel } from '../../src/observability/otel.js';

function findSpan(spans: ReadableSpan[], name: string): ReadableSpan | undefined {
  return spans.find((s) => s.name === name);
}

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

describe('OTel SDK bootstrap', () => {
  it('returns null when no exporter / endpoint / processor is configured', () => {
    const result = startOtel({ env: {} });
    expect(result).toBeNull();
  });
});

describe('GenAI agent span tree (invoke_agent → execute_tool)', () => {
  it('emits a top-level invoke_agent span with gen_ai.operation.name and gen_ai.agent.name', async () => {
    await withInvokeAgentSpan(
      { bomId: 'bom-1', bomTitle: 'Test goal', stepCount: 2, correlationId: 'cid-xyz' },
      async () => { /* no-op */ },
    );
    await shared.flush();
    const spans = shared.exporter.getFinishedSpans();
    const invoke = findSpan(spans, 'invoke_agent');
    expect(invoke).toBeDefined();
    expect(invoke!.attributes[GEN_AI_OPERATION_NAME]).toBe('invoke_agent');
    expect(invoke!.attributes[GEN_AI_AGENT_NAME]).toBe('stavr-steward');
    expect(invoke!.attributes['stavr.bom.id']).toBe('bom-1');
    expect(invoke!.attributes['stavr.bom.title']).toBe('Test goal');
    expect(invoke!.attributes['stavr.bom.step_count']).toBe(2);
    expect(invoke!.attributes['stavr.correlation_id']).toBe('cid-xyz');
  });

  it('execute_tool is a CHILD of invoke_agent (two-tier shape preserved, not collapsed)', async () => {
    await withInvokeAgentSpan({ bomId: 'bom-2' }, async () => {
      await withExecuteToolSpan(
        { toolName: 'code', toolCallId: 'bom-2:1', bomId: 'bom-2', stepNo: 1, riskClass: 'reversible-local' },
        async () => { /* tool work */ },
      );
    });
    await shared.flush();
    const spans = shared.exporter.getFinishedSpans();
    const invoke = findSpan(spans, 'invoke_agent')!;
    const tool = findSpan(spans, 'execute_tool')!;
    expect(invoke).toBeDefined();
    expect(tool).toBeDefined();
    expect(tool.parentSpanContext?.spanId).toBe(invoke.spanContext().spanId);
    expect(tool.attributes[GEN_AI_OPERATION_NAME]).toBe('execute_tool');
    expect(tool.attributes[GEN_AI_TOOL_NAME]).toBe('code');
    expect(tool.attributes['stavr.bom.id']).toBe('bom-2');
    expect(tool.attributes['stavr.bom.step_no']).toBe(1);
    expect(tool.attributes['stavr.step.risk_class']).toBe('reversible-local');
  });

  it('recordTokenUsage stamps gen_ai.usage.input/output_tokens on the active span', async () => {
    await withInvokeAgentSpan({ bomId: 'bom-3' }, async () => {
      recordTokenUsage(1234, 567);
    });
    await shared.flush();
    const span = findSpan(shared.exporter.getFinishedSpans(), 'invoke_agent')!;
    expect(span.attributes['gen_ai.usage.input_tokens']).toBe(1234);
    expect(span.attributes['gen_ai.usage.output_tokens']).toBe(567);
  });
});

describe('GenAI MCP semconv attributes', () => {
  it('attachMcpAttributes stamps mcp.method / mcp.tool.name / mcp.session.id on the active span', async () => {
    await withInvokeAgentSpan({ bomId: 'bom-mcp' }, async () => {
      attachMcpAttributes({
        method: 'tools/call',
        toolName: 'switch.respond_to_decision',
        sessionId: 'sess-abc',
      });
    });
    await shared.flush();
    const span = findSpan(shared.exporter.getFinishedSpans(), 'invoke_agent')!;
    expect(span.attributes[GEN_AI_MCP_METHOD]).toBe('tools/call');
    expect(span.attributes[GEN_AI_MCP_TOOL_NAME]).toBe('switch.respond_to_decision');
    expect(span.attributes[GEN_AI_MCP_SESSION_ID]).toBe('sess-abc');
  });

  it('attachMcpAttributes is a no-op when no span is active (does not throw)', () => {
    expect(() => attachMcpAttributes({ method: 'tools/list' })).not.toThrow();
  });
});

describe('broker event addEvent (not a span)', () => {
  it('addBrokerSpanEvent records a span event on the active span, not a new span', async () => {
    await withInvokeAgentSpan({ bomId: 'bom-be' }, async () => {
      addBrokerSpanEvent('progress', { correlationId: 'cid-be', sourceAgent: 'worker:cc' });
      addBrokerSpanEvent('command_run', { correlationId: 'cid-be', sourceAgent: 'worker:cc' });
    });
    await shared.flush();
    const spans = shared.exporter.getFinishedSpans();
    // No new spans per broker event.
    expect(spans.filter((s) => s.name === STAVR_BROKER_EVENT_NAME)).toHaveLength(0);
    const invoke = findSpan(spans, 'invoke_agent')!;
    expect(invoke.events.length).toBe(2);
    expect(invoke.events[0].name).toBe(STAVR_BROKER_EVENT_NAME);
    expect(invoke.events[0].attributes?.['event.kind']).toBe('progress');
    expect(invoke.events[1].attributes?.['event.kind']).toBe('command_run');
  });
});

// Silence the unused-import sentinel.
void InMemorySpanExporter;
void SimpleSpanProcessor;
