import { describe, expect, it } from 'vitest';
import { registry } from '../../src/observability/metrics.js';
import {
  recordLlmCall,
  normalizeOperation,
  normalizeFinishReason,
  llmRequests,
  llmRequestErrors,
  llmFinishReason,
  llmContextLengthExceeded,
  llmCostUsdTotal,
  genAiClientOperationDuration,
  genAiServerRequestDuration,
  genAiClientTokenUsage,
} from '../../src/observability/llm-metrics.js';

describe('LLM metrics — Wave 3 catalog', () => {
  it('exposes the L4 GenAI + vLLM-style catalog on /metrics', async () => {
    const text = await registry.metrics();
    // GenAI
    expect(text).toContain('gen_ai_client_token_usage');
    expect(text).toContain('gen_ai_client_operation_duration_seconds');
    expect(text).toContain('gen_ai_client_operation_time_to_first_chunk_seconds');
    expect(text).toContain('gen_ai_client_operation_time_per_output_chunk_seconds');
    expect(text).toContain('gen_ai_server_request_duration_seconds');
    expect(text).toContain('gen_ai_server_time_to_first_token_seconds');
    expect(text).toContain('gen_ai_server_time_per_output_token_seconds');
    // vLLM-style runtime
    expect(text).toContain('llm_requests_total');
    expect(text).toContain('llm_prompt_tokens_per_sec');
    expect(text).toContain('llm_generation_tokens_per_sec');
    expect(text).toContain('llm_requests_waiting');
    expect(text).toContain('llm_requests_running');
    expect(text).toContain('llm_queue_time_seconds');
    expect(text).toContain('llm_batch_size');
    expect(text).toContain('llm_request_preemptions_total');
    expect(text).toContain('llm_kv_cache_utilization_pct');
    expect(text).toContain('llm_prefix_cache_hit_rate');
    expect(text).toContain('llm_kv_cache_evictions_total');
    expect(text).toContain('llm_requests_swapped');
    expect(text).toContain('llm_request_errors_total');
    expect(text).toContain('llm_finish_reason_total');
    expect(text).toContain('llm_context_length_exceeded_total');
    expect(text).toContain('llm_guardrail_blocks_total');
    expect(text).toContain('llm_output_schema_invalid_total');
    expect(text).toContain('llm_eval_groundedness_score');
    expect(text).toContain('llm_eval_toxicity_flags_total');
    expect(text).toContain('llm_refusal_rate');
    expect(text).toContain('llm_input_drift_score');
    expect(text).toContain('llm_output_drift_score');
    expect(text).toContain('llm_cost_usd_per_request');
    expect(text).toContain('llm_cost_usd_total');
  });
});

describe('LLM normalizers', () => {
  it('normalizeOperation keeps known ops, collapses unknown', () => {
    expect(normalizeOperation('chat')).toBe('chat');
    expect(normalizeOperation('embedding')).toBe('embedding');
    expect(normalizeOperation(undefined)).toBe('chat');
    expect(normalizeOperation('mystery')).toBe('other');
  });

  it('normalizeFinishReason keeps known reasons, collapses unknown', () => {
    expect(normalizeFinishReason('stop')).toBe('stop');
    expect(normalizeFinishReason('length')).toBe('length');
    expect(normalizeFinishReason('tool_calls')).toBe('tool_calls');
    expect(normalizeFinishReason('mystery')).toBe('other');
    expect(normalizeFinishReason(undefined)).toBe('unknown');
  });
});

describe('recordLlmCall', () => {
  it('feeds requests counter, durations, and tokens on success', async () => {
    const model = 'llama3.2:3b';
    const before = (await llmRequests.get()).values.find((v) => v.labels.model === model)?.value ?? 0;
    recordLlmCall({
      model,
      operation: 'chat',
      durationSeconds: 0.42,
      success: true,
      promptTokens: 1024,
      completionTokens: 256,
      finishReason: 'stop',
    });
    const after = (await llmRequests.get()).values.find((v) => v.labels.model === model)?.value ?? 0;
    expect(after).toBe(before + 1);

    const clientDur = (await genAiClientOperationDuration.get()).values.find(
      (v) =>
        v.metricName === 'gen_ai_client_operation_duration_seconds_count' &&
        v.labels.model === model &&
        v.labels.operation === 'chat',
    );
    expect(clientDur?.value ?? 0).toBeGreaterThan(0);

    const serverDur = (await genAiServerRequestDuration.get()).values.find(
      (v) =>
        v.metricName === 'gen_ai_server_request_duration_seconds_count' &&
        v.labels.model === model,
    );
    expect(serverDur?.value ?? 0).toBeGreaterThan(0);

    const tokIn = (await genAiClientTokenUsage.get()).values.find(
      (v) =>
        v.metricName === 'gen_ai_client_token_usage_count' &&
        v.labels.model === model &&
        v.labels.token_type === 'input',
    );
    const tokOut = (await genAiClientTokenUsage.get()).values.find(
      (v) =>
        v.metricName === 'gen_ai_client_token_usage_count' &&
        v.labels.model === model &&
        v.labels.token_type === 'output',
    );
    expect(tokIn?.value ?? 0).toBeGreaterThan(0);
    expect(tokOut?.value ?? 0).toBeGreaterThan(0);
  });

  it('feeds errors counter on failure and finish-reason on length', async () => {
    const model = 'llama3.2:3b';
    recordLlmCall({
      model,
      operation: 'chat',
      durationSeconds: 0.1,
      success: false,
      errorType: 'timeout',
    });
    const err = (await llmRequestErrors.get()).values.find(
      (v) => v.labels.model === model && v.labels.error_type === 'timeout',
    );
    expect(err?.value ?? 0).toBeGreaterThanOrEqual(1);

    recordLlmCall({
      model,
      operation: 'chat',
      durationSeconds: 0.1,
      success: true,
      finishReason: 'length',
    });
    const fr = (await llmFinishReason.get()).values.find(
      (v) => v.labels.model === model && v.labels.reason === 'length',
    );
    expect(fr?.value ?? 0).toBeGreaterThanOrEqual(1);
    const ctx = (await llmContextLengthExceeded.get()).values.find((v) => v.labels.model === model);
    expect(ctx?.value ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('writes cost counter with bounded labels', async () => {
    const model = 'gpt-fake';
    recordLlmCall({
      model,
      operation: 'chat',
      durationSeconds: 0.5,
      success: true,
      costUsd: 0.0123,
      tenant: 'local',
      feature: 'steward',
    });
    const cost = (await llmCostUsdTotal.get()).values.find(
      (v) => v.labels.model === model && v.labels.tenant === 'local' && v.labels.feature === 'steward',
    );
    expect(cost?.value ?? 0).toBeCloseTo(0.0123, 5);
  });
});
