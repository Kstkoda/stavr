// src/observability/spans.ts
//
// Thin helpers for emitting OTel GenAI / MCP semantic-convention spans.
// Spec: bom-diagnostics-2026.md C2.3. See
// https://opentelemetry.io/docs/specs/semconv/gen-ai/mcp/ and
// https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/ for
// the authoritative attribute shapes.
//
// The helpers are no-ops when no OTel SDK is configured — the OTel API's
// NoopTracerProvider is the default, so spans created here are cheap and
// don't allocate exporter resources. Callers must NOT collapse
// `invoke_agent` and `execute_tool` into a single span level; trace
// consumers (LangSmith, Braintrust, Jaeger GenAI plugins) recognize the
// two-tier shape for agent traces.

import { trace, SpanKind, SpanStatusCode, type Span, type Attributes } from '@opentelemetry/api';

export const STAVR_TRACER_NAME = 'stavr';

// ---- GenAI attribute name constants. Lifted from the OTel GenAI/MCP
// semantic conventions. As of March 2026 these are experimental — set
// OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental in the daemon
// env so any downstream lib emits the same names. Stavr's own helpers use
// these constants regardless of the env flag.

export const GEN_AI_OPERATION_NAME = 'gen_ai.operation.name';
export const GEN_AI_AGENT_NAME = 'gen_ai.agent.name';
export const GEN_AI_TOOL_NAME = 'gen_ai.tool.name';
export const GEN_AI_TOOL_CALL_ID = 'gen_ai.tool.call.id';
export const GEN_AI_USAGE_INPUT_TOKENS = 'gen_ai.usage.input_tokens';
export const GEN_AI_USAGE_OUTPUT_TOKENS = 'gen_ai.usage.output_tokens';

export const GEN_AI_MCP_METHOD = 'gen_ai.mcp.method';
export const GEN_AI_MCP_TOOL_NAME = 'gen_ai.mcp.tool.name';
export const GEN_AI_MCP_SESSION_ID = 'gen_ai.mcp.session.id';

export const STAVR_BROKER_EVENT_NAME = 'stavr.event.emitted';

function tracer() {
  return trace.getTracer(STAVR_TRACER_NAME);
}

export interface InvokeAgentSpanAttrs {
  agentName?: string;
  bomId?: string;
  bomTitle?: string;
  profileMode?: string;
  stepCount?: number;
  correlationId?: string;
}

/**
 * Wrap a function in a top-level `invoke_agent` span — the canonical OTel
 * GenAI root for an agentic operation. Stavr's "agent invocation" is a
 * BOM run; one `invoke_agent` per `runBom`. Always emit `gen_ai.operation.name`
 * and `gen_ai.agent.name`; other attrs are best-effort.
 */
export async function withInvokeAgentSpan<T>(
  attrs: InvokeAgentSpanAttrs,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const attributes: Attributes = {
    [GEN_AI_OPERATION_NAME]: 'invoke_agent',
    [GEN_AI_AGENT_NAME]: attrs.agentName ?? 'stavr-steward',
  };
  if (attrs.bomId !== undefined) attributes['stavr.bom.id'] = attrs.bomId;
  if (attrs.bomTitle !== undefined) attributes['stavr.bom.title'] = attrs.bomTitle;
  if (attrs.profileMode !== undefined) attributes['stavr.bom.profile_mode'] = attrs.profileMode;
  if (attrs.stepCount !== undefined) attributes['stavr.bom.step_count'] = attrs.stepCount;
  if (attrs.correlationId !== undefined) attributes['stavr.correlation_id'] = attrs.correlationId;

  return tracer().startActiveSpan(
    'invoke_agent',
    { kind: SpanKind.INTERNAL, attributes },
    async (span) => {
      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
        span.recordException(err as Error);
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

export interface ExecuteToolSpanAttrs {
  toolName: string;
  toolCallId?: string;
  bomId?: string;
  stepNo?: number;
  riskClass?: string;
  brickId?: string;
}

/**
 * Wrap a BOM step (or any single tool/MCP invocation) in an `execute_tool`
 * child span. Must be called INSIDE an active `invoke_agent` span so the
 * GenAI two-tier shape is preserved — never collapse these levels.
 */
export async function withExecuteToolSpan<T>(
  attrs: ExecuteToolSpanAttrs,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const attributes: Attributes = {
    [GEN_AI_OPERATION_NAME]: 'execute_tool',
    [GEN_AI_TOOL_NAME]: attrs.toolName,
  };
  if (attrs.toolCallId !== undefined) attributes[GEN_AI_TOOL_CALL_ID] = attrs.toolCallId;
  if (attrs.bomId !== undefined) attributes['stavr.bom.id'] = attrs.bomId;
  if (attrs.stepNo !== undefined) attributes['stavr.bom.step_no'] = attrs.stepNo;
  if (attrs.riskClass !== undefined) attributes['stavr.step.risk_class'] = attrs.riskClass;
  if (attrs.brickId !== undefined) attributes['stavr.brick.id'] = attrs.brickId;

  return tracer().startActiveSpan(
    'execute_tool',
    { kind: SpanKind.INTERNAL, attributes },
    async (span) => {
      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
        span.recordException(err as Error);
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

/**
 * Attach MCP semconv attributes to whatever span is active. Used inside the
 * /mcp HTTP handler — the auto-instrumentation already created a server span
 * for the request; we just decorate it with the MCP-layer details.
 */
export function attachMcpAttributes(attrs: {
  method?: string;
  toolName?: string;
  sessionId?: string;
}): void {
  const span = trace.getActiveSpan();
  if (!span) return;
  if (attrs.method !== undefined) span.setAttribute(GEN_AI_MCP_METHOD, attrs.method);
  if (attrs.toolName !== undefined) span.setAttribute(GEN_AI_MCP_TOOL_NAME, attrs.toolName);
  if (attrs.sessionId !== undefined) span.setAttribute(GEN_AI_MCP_SESSION_ID, attrs.sessionId);
}

/**
 * Record a broker `publish()` as an `addEvent` on the active span rather than
 * a new span — the event log is the system-of-record; spans only need to know
 * that an emission happened during this request. Avoids span explosion under
 * high event rates.
 */
export function addBrokerSpanEvent(kind: string, attrs?: { correlationId?: string; sourceAgent?: string }): void {
  const span = trace.getActiveSpan();
  if (!span) return;
  const payload: Attributes = { 'event.kind': kind };
  if (attrs?.correlationId) payload['event.correlation_id'] = attrs.correlationId;
  if (attrs?.sourceAgent) payload['event.source_agent'] = attrs.sourceAgent;
  span.addEvent(STAVR_BROKER_EVENT_NAME, payload);
}

/**
 * Stamp token-usage attributes on the active span. Called from worker emit
 * handlers when the upstream LLM returns usage in stream-json. No-op when no
 * span is active.
 */
export function recordTokenUsage(input: number | undefined, output: number | undefined): void {
  const span = trace.getActiveSpan();
  if (!span) return;
  if (typeof input === 'number') span.setAttribute(GEN_AI_USAGE_INPUT_TOKENS, input);
  if (typeof output === 'number') span.setAttribute(GEN_AI_USAGE_OUTPUT_TOKENS, output);
}
