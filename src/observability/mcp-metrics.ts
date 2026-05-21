// src/observability/mcp-metrics.ts
//
// Layer 5 (MCP gateway / server / client) metrics.
// Spec: proposed/observability-metrics-spec.md — Layer 5 (stavR's core).
// BOM: proposed/observability-instrumentation-bom.md — Wave 1.
//
// Naming: spec names are OTel-style (dots) — `mcp.gateway.request.duration`.
// Prometheus' wire format does not accept dots in metric names, so the
// registered name is the underscored form (`mcp_gateway_request_duration`)
// and the spec name lives in the metric help text. Operators reading
// /metrics see both.
//
// Dual-emit during deprecation window
// -----------------------------------
// The existing `stavr_http_request_duration_seconds` and `stavr_sse_sessions`
// remain registered + emitted. The new `mcp_gateway_request_duration_seconds`
// and `mcp_server_sessions_active` emit alongside. External scrape configs
// keep working; v0.7.0 will drop the legacy aliases.
//
// Cardinality discipline (BOM Rule 2)
// ----------------------------------
// Labels: `upstream` from a small registered set (today: "self"), `tool` from
// the bounded MCP tool catalog (transports.normalizeMcpTool truncates
// unknown names to "other"), `client` from the bounded peer roster, `error_type`
// from a small enum, `server` from a small enum, `dependency` from
// `connectors.yaml`, `code` from JSON-RPC error codes (bounded), `tenant`
// from peer identity. None unbounded.

import { Counter, Gauge, Histogram } from 'prom-client';
import { registry } from './metrics.js';

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

function makeHistogram(name: string, help: string, labelNames: string[], buckets: number[]): Histogram<string> {
  const existing = registry.getSingleMetric(name);
  if (existing) return existing as Histogram<string>;
  return new Histogram({ name, help, labelNames, buckets, registers: [registry] });
}

// Bucket presets — same as stavr_http_request_duration so the new gateway
// histogram is directly comparable while both names emit.
const REQUEST_BUCKETS = [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5];
const TOKEN_BUCKETS = [10, 50, 100, 500, 1000, 5000, 20_000, 100_000];

// ---- Gateway ----

export const mcpGatewayRequestDuration = makeHistogram(
  'mcp_gateway_request_duration_seconds',
  'MCP gateway request duration in seconds (spec name mcp.gateway.request.duration). SLO p99.',
  ['upstream', 'tool'],
  REQUEST_BUCKETS,
);

export const mcpGatewayRequestRate = makeCounter(
  'mcp_gateway_request_rate_total',
  'MCP gateway request count (spec name mcp.gateway.request.rate). Capacity tracking.',
  ['upstream', 'tool', 'client'],
);

export const mcpGatewayRequestErrors = makeCounter(
  'mcp_gateway_request_errors_total',
  'MCP gateway request errors (spec name mcp.gateway.request.errors). Warn ratio >1%.',
  ['upstream', 'error_type'],
);

export const mcpGatewayUpstreamConnectionsActive = makeGauge(
  'mcp_gateway_upstream_connections_active',
  'Active gateway upstream connections (spec name mcp.gateway.upstream.connections.active). Warn near pool max.',
  ['upstream'],
);

export const mcpGatewayUpstreamConnectionsQueued = makeGauge(
  'mcp_gateway_upstream_connections_queued',
  'Queued gateway upstream connections (spec name mcp.gateway.upstream.connections.queued). Warn >0.',
  ['upstream'],
);

export const mcpGatewayCircuitBreakerState = makeGauge(
  'mcp_gateway_circuit_breaker_state',
  'Per-upstream circuit breaker state (0=closed 1=half 2=open). Spec name mcp.gateway.circuit_breaker.state. Page on open.',
  ['upstream'],
);

export const mcpGatewayRateLimitHits = makeCounter(
  'mcp_gateway_rate_limit_hits_total',
  'Gateway rate-limit hits (spec name mcp.gateway.rate_limit.hits). Track.',
  ['tenant'],
);

export const mcpGatewayUpstreamHealth = makeGauge(
  'mcp_gateway_upstream_health',
  'Per-upstream health (1=healthy 0=unhealthy). Spec name mcp.gateway.upstream.health. Page on unhealthy.',
  ['upstream'],
);

export const mcpGatewayToolInvocations = makeCounter(
  'mcp_gateway_tool_invocations_total',
  'Gateway tool invocations (spec name mcp.gateway.tool.invocations). Usage analytics.',
  ['client', 'tool', 'server'],
);

export const mcpGatewayAuthFailures = makeCounter(
  'mcp_gateway_auth_failures_total',
  'Gateway auth failures (spec name mcp.gateway.auth.failures). Warn on spike.',
  ['client'],
);

// ---- Server (stavR-as-server, exposing its own tool surface) ----

export const mcpServerToolDuration = makeHistogram(
  'mcp_server_tool_duration_seconds',
  'Server-side per-tool duration in seconds (spec name mcp.server.tool.duration). SLO p95.',
  ['tool'],
  REQUEST_BUCKETS,
);

export const mcpServerToolErrors = makeCounter(
  'mcp_server_tool_errors_total',
  'Server-side per-tool errors (spec name mcp.server.tool.errors). Warn ratio >1%.',
  ['tool', 'error_type'],
);

export const mcpServerToolInvocations = makeCounter(
  'mcp_server_tool_invocations_total',
  'Server-side per-tool invocations (spec name mcp.server.tool.invocations). Usage tracking.',
  ['tool'],
);

export const mcpServerInvocationsInFlight = makeGauge(
  'mcp_server_invocations_in_flight',
  'Server-side in-flight invocations (spec name mcp.server.invocations.in_flight). Warn near capacity.',
  ['server'],
);

export const mcpServerSessionsActive = makeGauge(
  'mcp_server_sessions_active',
  'Active MCP server sessions (spec name mcp.server.sessions.active). Capacity tracking. Replaces stavr_sse_sessions (kept dual-emit through v0.6.x).',
  ['server'],
);

export const mcpServerDownstreamDuration = makeHistogram(
  'mcp_server_downstream_duration_seconds',
  'Server downstream-call duration in seconds (spec name mcp.server.downstream.duration). SLO p95.',
  ['tool', 'dependency'],
  REQUEST_BUCKETS,
);

export const mcpServerDownstreamErrors = makeCounter(
  'mcp_server_downstream_errors_total',
  'Server downstream-call errors (spec name mcp.server.downstream.errors). Warn ratio.',
  ['tool', 'dependency'],
);

export const mcpServerColdStartDuration = makeHistogram(
  'mcp_server_cold_start_duration_seconds',
  'Server cold-start duration in seconds (spec name mcp.server.cold_start.duration). SLO (serverless).',
  ['server'],
  REQUEST_BUCKETS,
);

export const mcpServerProtocolViolations = makeCounter(
  'mcp_server_protocol_violations_total',
  'Server-observed MCP protocol violations (spec name mcp.server.protocol.violations). Warn on any.',
  ['type'],
);

// ---- Client (stavR-as-client, brokering out to upstream MCP servers) ----

export const mcpClientToolDuration = makeHistogram(
  'mcp_client_tool_duration_seconds',
  'Client-side per-tool duration in seconds (spec name mcp.client.tool.duration). SLO p95.',
  ['tool', 'server'],
  REQUEST_BUCKETS,
);

export const mcpClientToolErrors = makeCounter(
  'mcp_client_tool_errors_total',
  'Client-side per-tool errors (spec name mcp.client.tool.errors). Warn ratio.',
  ['tool', 'error_type'],
);

export const mcpClientConnectionState = makeGauge(
  'mcp_client_connection_state',
  'Client connection state per upstream server (1=connected 0=disconnected). Spec name mcp.client.connection.state. Page on disconnected.',
  ['server'],
);

export const mcpClientReconnectAttempts = makeCounter(
  'mcp_client_reconnect_attempts_total',
  'Client reconnect attempts (spec name mcp.client.reconnect.attempts). Warn on spike.',
  ['server'],
);

export const mcpClientSchemaValidationFailures = makeCounter(
  'mcp_client_schema_validation_failures_total',
  'Client-side schema validation failures (spec name mcp.client.schema.validation.failures). Warn on any.',
  ['server', 'tool'],
);

export const mcpClientToolTimeouts = makeCounter(
  'mcp_client_tool_timeouts_total',
  'Client-side tool timeouts (spec name mcp.client.tool.timeouts). Warn on ratio.',
  ['tool'],
);

export const mcpClientToolResultTokens = makeHistogram(
  'mcp_client_tool_result_tokens',
  'Client-side tool result size in tokens (spec name mcp.client.tool.result.tokens). Context-bloat tracking.',
  ['tool'],
  TOKEN_BUCKETS,
);

export const mcpClientListToolsDuration = makeHistogram(
  'mcp_client_list_tools_duration_seconds',
  'Client-side list_tools duration in seconds (spec name mcp.client.list_tools.duration). SLO p95.',
  ['server'],
  REQUEST_BUCKETS,
);

// ---- Protocol-level ----

export const mcpJsonrpcErrors = makeCounter(
  'mcp_jsonrpc_errors_total',
  'JSON-RPC error responses by code (spec name mcp.jsonrpc.errors). Watch distribution.',
  ['code'],
);

export const mcpProtocolVersionMismatch = makeCounter(
  'mcp_protocol_version_mismatch_total',
  'Protocol-version mismatches observed (spec name mcp.protocol.version_mismatch). Warn on any.',
  ['peer'],
);

// ---- Bounded normalizers ----

const KNOWN_TOOLS = new Set([
  'tools/list',
  'tools/call',
  'initialize',
  'notifications/initialized',
  'resources/list',
  'resources/read',
  'prompts/list',
  'prompts/get',
  'logging/setLevel',
  'ping',
  'completion/complete',
]);

/** Collapse an MCP method or tool name to a bounded label value.
 *  Unknown names go into "other". Spec rule 2 — never let request-shaped
 *  data leak into label values. */
export function normalizeMcpMethod(method: string | undefined): string {
  if (!method) return 'unknown';
  if (KNOWN_TOOLS.has(method)) return method;
  return 'other';
}

/** Truncate user-supplied tool names (the `params.name` of a tools/call) to a
 *  bounded value. We DON'T pre-list every tool — the cardinality bound is the
 *  union of registered tool names, plus a "(invalid)" bucket. */
export function normalizeMcpToolName(name: string | undefined): string {
  if (!name) return '(none)';
  if (name.length > 64) return name.slice(0, 64);
  // Reject obviously path-like or identifier-like values
  if (/[\s\\\/]/.test(name)) return '(invalid)';
  return name;
}

// ---- Recorders ----

export interface RecordGatewayRequestOpts {
  /** Logical upstream — `self` for in-process tools, `<peer>` for federated brokering. */
  upstream?: string;
  /** Method name (`tools/call`, `tools/list`, ...) collapsed to bounded set. */
  method?: string;
  /** Tool name on `tools/call`, undefined otherwise. */
  toolName?: string;
  /** Client identity — bounded by the peer roster; default `local`. */
  client?: string;
  /** Server-side identity — default `stavr`. */
  server?: string;
  /** Elapsed seconds. */
  durationSeconds: number;
  /** Whether the request succeeded at the gateway layer. */
  success: boolean;
  /** Error class on failure — `protocol`, `timeout`, `upstream`, `auth`, `internal`. */
  errorType?: string;
}

export function recordGatewayRequest(opts: RecordGatewayRequestOpts): void {
  const upstream = opts.upstream ?? 'self';
  const method = normalizeMcpMethod(opts.method);
  const tool = method === 'tools/call' ? normalizeMcpToolName(opts.toolName) : method;
  const client = opts.client ?? 'local';
  const server = opts.server ?? 'stavr';

  mcpGatewayRequestDuration.labels(upstream, tool).observe(opts.durationSeconds);
  mcpGatewayRequestRate.labels(upstream, tool, client).inc();
  mcpGatewayToolInvocations.labels(client, tool, server).inc();
  if (!opts.success) {
    mcpGatewayRequestErrors.labels(upstream, opts.errorType ?? 'internal').inc();
  }
}

export function setMcpServerSessionsActive(n: number, server: string = 'stavr'): void {
  mcpServerSessionsActive.labels(server).set(n);
}

export function recordJsonRpcError(code: number | string): void {
  mcpJsonrpcErrors.labels(String(code)).inc();
}

export function recordProtocolVersionMismatch(peer: string = 'unknown'): void {
  mcpProtocolVersionMismatch.labels(peer).inc();
}
