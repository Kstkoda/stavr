import { describe, expect, it } from 'vitest';
import { registry } from '../../src/observability/metrics.js';
import {
  normalizeMcpMethod,
  normalizeMcpToolName,
  recordGatewayRequest,
  setMcpServerSessionsActive,
  recordJsonRpcError,
  recordProtocolVersionMismatch,
  mcpGatewayRequestDuration,
  mcpGatewayRequestRate,
  mcpGatewayRequestErrors,
  mcpGatewayToolInvocations,
  mcpServerSessionsActive,
  mcpJsonrpcErrors,
  mcpProtocolVersionMismatch,
} from '../../src/observability/mcp-metrics.js';

describe('MCP metrics — Wave 1 catalog', () => {
  it('exposes the L5 metric names on /metrics', async () => {
    const text = await registry.metrics();
    // Gateway
    expect(text).toContain('mcp_gateway_request_duration_seconds');
    expect(text).toContain('mcp_gateway_request_rate_total');
    expect(text).toContain('mcp_gateway_request_errors_total');
    expect(text).toContain('mcp_gateway_upstream_connections_active');
    expect(text).toContain('mcp_gateway_upstream_connections_queued');
    expect(text).toContain('mcp_gateway_circuit_breaker_state');
    expect(text).toContain('mcp_gateway_rate_limit_hits_total');
    expect(text).toContain('mcp_gateway_upstream_health');
    expect(text).toContain('mcp_gateway_tool_invocations_total');
    expect(text).toContain('mcp_gateway_auth_failures_total');
    // Server
    expect(text).toContain('mcp_server_tool_duration_seconds');
    expect(text).toContain('mcp_server_tool_errors_total');
    expect(text).toContain('mcp_server_tool_invocations_total');
    expect(text).toContain('mcp_server_invocations_in_flight');
    expect(text).toContain('mcp_server_sessions_active');
    expect(text).toContain('mcp_server_downstream_duration_seconds');
    expect(text).toContain('mcp_server_downstream_errors_total');
    expect(text).toContain('mcp_server_cold_start_duration_seconds');
    expect(text).toContain('mcp_server_protocol_violations_total');
    // Client
    expect(text).toContain('mcp_client_tool_duration_seconds');
    expect(text).toContain('mcp_client_tool_errors_total');
    expect(text).toContain('mcp_client_connection_state');
    expect(text).toContain('mcp_client_reconnect_attempts_total');
    expect(text).toContain('mcp_client_schema_validation_failures_total');
    expect(text).toContain('mcp_client_tool_timeouts_total');
    expect(text).toContain('mcp_client_tool_result_tokens');
    expect(text).toContain('mcp_client_list_tools_duration_seconds');
    // Protocol
    expect(text).toContain('mcp_jsonrpc_errors_total');
    expect(text).toContain('mcp_protocol_version_mismatch_total');
  });
});

describe('MCP label normalizers', () => {
  it('normalizeMcpMethod keeps known methods, collapses unknown', () => {
    expect(normalizeMcpMethod('tools/call')).toBe('tools/call');
    expect(normalizeMcpMethod('tools/list')).toBe('tools/list');
    expect(normalizeMcpMethod('initialize')).toBe('initialize');
    expect(normalizeMcpMethod('mystery/method')).toBe('other');
    expect(normalizeMcpMethod(undefined)).toBe('unknown');
  });

  it('normalizeMcpToolName truncates long names and rejects path-shaped values', () => {
    expect(normalizeMcpToolName(undefined)).toBe('(none)');
    expect(normalizeMcpToolName('a'.repeat(70))).toHaveLength(64);
    expect(normalizeMcpToolName('a tool with space')).toBe('(invalid)');
    expect(normalizeMcpToolName('../../../etc/passwd')).toBe('(invalid)');
    expect(normalizeMcpToolName('host_exec')).toBe('host_exec');
  });
});

describe('recordGatewayRequest', () => {
  it('feeds duration histogram + rate counter on success', async () => {
    const before = (await mcpGatewayRequestRate.get()).values.find(
      (v) => v.labels.upstream === 'self' && v.labels.tool === 'host_exec' && v.labels.client === 'local',
    )?.value ?? 0;
    recordGatewayRequest({
      method: 'tools/call',
      toolName: 'host_exec',
      durationSeconds: 0.04,
      success: true,
    });
    const after = (await mcpGatewayRequestRate.get()).values.find(
      (v) => v.labels.upstream === 'self' && v.labels.tool === 'host_exec' && v.labels.client === 'local',
    )?.value ?? 0;
    expect(after).toBe(before + 1);
    const dur = (await mcpGatewayRequestDuration.get()).values.find(
      (v) => v.metricName === 'mcp_gateway_request_duration_seconds_count' && v.labels.tool === 'host_exec',
    );
    expect((dur?.value ?? 0)).toBeGreaterThan(0);
  });

  it('feeds errors counter on failure', async () => {
    const before = (await mcpGatewayRequestErrors.get()).values.find(
      (v) => v.labels.upstream === 'self' && v.labels.error_type === 'timeout',
    )?.value ?? 0;
    recordGatewayRequest({
      method: 'tools/call',
      toolName: 'host_exec',
      durationSeconds: 0.1,
      success: false,
      errorType: 'timeout',
    });
    const after = (await mcpGatewayRequestErrors.get()).values.find(
      (v) => v.labels.upstream === 'self' && v.labels.error_type === 'timeout',
    )?.value ?? 0;
    expect(after).toBe(before + 1);
  });

  it('feeds tool invocations counter with bounded labels', async () => {
    recordGatewayRequest({
      method: 'tools/call',
      toolName: 'github_create_pr',
      durationSeconds: 0.2,
      success: true,
    });
    const row = (await mcpGatewayToolInvocations.get()).values.find(
      (v) => v.labels.client === 'local' && v.labels.tool === 'github_create_pr' && v.labels.server === 'stavr',
    );
    expect(row?.value ?? 0).toBeGreaterThanOrEqual(1);
  });
});

describe('setMcpServerSessionsActive + recordJsonRpcError + recordProtocolVersionMismatch', () => {
  it('writes sessions gauge with server label', async () => {
    setMcpServerSessionsActive(7);
    const v = (await mcpServerSessionsActive.get()).values.find((row) => row.labels.server === 'stavr');
    expect(v?.value).toBe(7);
    setMcpServerSessionsActive(0);
    const v2 = (await mcpServerSessionsActive.get()).values.find((row) => row.labels.server === 'stavr');
    expect(v2?.value).toBe(0);
  });

  it('increments jsonrpc errors by code', async () => {
    const before = (await mcpJsonrpcErrors.get()).values.find((v) => v.labels.code === '-32600')?.value ?? 0;
    recordJsonRpcError(-32600);
    const after = (await mcpJsonrpcErrors.get()).values.find((v) => v.labels.code === '-32600')?.value ?? 0;
    expect(after).toBe(before + 1);
  });

  it('increments protocol version mismatch by peer', async () => {
    const before = (await mcpProtocolVersionMismatch.get()).values.find((v) => v.labels.peer === 'unknown')?.value ?? 0;
    recordProtocolVersionMismatch();
    const after = (await mcpProtocolVersionMismatch.get()).values.find((v) => v.labels.peer === 'unknown')?.value ?? 0;
    expect(after).toBe(before + 1);
  });
});
