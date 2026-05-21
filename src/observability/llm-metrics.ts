// src/observability/llm-metrics.ts
//
// Layer 4 (LLM / AI execution) metrics — OTel GenAI conventions.
// Spec: proposed/observability-metrics-spec.md — Layer 4.
// BOM: proposed/observability-instrumentation-bom.md — Wave 3.
//
// Naming
// ------
// Spec uses OTel-style dotted names (gen_ai.server.request.duration); Prom
// wire format only accepts [a-zA-Z_:][a-zA-Z0-9_:]*. We register the
// underscored form (gen_ai_server_request_duration_seconds) and put the
// spec name in the help text. `token.type` collapses to `token_type` on
// the label name for the same reason.
//
// Dual-emit during deprecation
// ----------------------------
// `stavr_provider_requests_total` and `stavr_provider_latency_seconds`
// stay registered + emitted alongside the new names. v0.7.0 drops the
// stavr_* aliases.
//
// Cardinality discipline (BOM Rule 2)
// ----------------------------------
// `model` is bounded by the operator's configured runtime list and is
// already truncated to 48 chars by normalizeModelLabel in metrics.ts.
// `error_type`, `reason`, `policy`, `feature` are bounded enums.
// `tenant` is bounded by the federation peer roster. `operation` is a
// bounded enum (chat / embedding / completion / tools).

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

const DURATION_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120];
const TOKEN_BUCKETS = [10, 50, 100, 500, 1000, 5000, 20_000, 100_000];
const BATCH_BUCKETS = [1, 2, 4, 8, 16, 32, 64, 128];
const COST_BUCKETS = [0.0001, 0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10];

// ---- OTel GenAI client/server ----

export const genAiClientTokenUsage = makeHistogram(
  'gen_ai_client_token_usage',
  'GenAI client token usage histogram (spec name gen_ai.client.token.usage). Cost tracking.',
  ['model', 'token_type'],
  TOKEN_BUCKETS,
);

export const genAiClientOperationDuration = makeHistogram(
  'gen_ai_client_operation_duration_seconds',
  'GenAI client operation duration in seconds (spec name gen_ai.client.operation.duration). SLO p95.',
  ['model', 'operation'],
  DURATION_BUCKETS,
);

export const genAiClientTtfc = makeHistogram(
  'gen_ai_client_operation_time_to_first_chunk_seconds',
  'GenAI client TTFC in seconds (spec name gen_ai.client.operation.time_to_first_chunk). SLO p95.',
  ['model'],
  DURATION_BUCKETS,
);

export const genAiClientTpoc = makeHistogram(
  'gen_ai_client_operation_time_per_output_chunk_seconds',
  'GenAI client time-per-output-chunk in seconds (spec name gen_ai.client.operation.time_per_output_chunk). SLO p95.',
  ['model'],
  DURATION_BUCKETS,
);

export const genAiServerRequestDuration = makeHistogram(
  'gen_ai_server_request_duration_seconds',
  'GenAI server request duration in seconds (spec name gen_ai.server.request.duration). SLO p95.',
  ['model'],
  DURATION_BUCKETS,
);

export const genAiServerTtft = makeHistogram(
  'gen_ai_server_time_to_first_token_seconds',
  'GenAI server TTFT in seconds (spec name gen_ai.server.time_to_first_token). SLO p95 e.g. <500ms.',
  ['model'],
  DURATION_BUCKETS,
);

export const genAiServerTpot = makeHistogram(
  'gen_ai_server_time_per_output_token_seconds',
  'GenAI server time-per-output-token in seconds (spec name gen_ai.server.time_per_output_token). SLO p95 e.g. <50ms.',
  ['model'],
  DURATION_BUCKETS,
);

// ---- vLLM / Ollama-style runtime ----

export const llmRequests = makeCounter(
  'llm_requests_total',
  'LLM requests count (spec name llm_requests_per_sec). Capacity tracking.',
  ['model'],
);

export const llmPromptTokensPerSec = makeGauge(
  'llm_prompt_tokens_per_sec',
  'LLM prompt-token throughput (spec name llm_prompt_tokens_per_sec). Capacity tracking.',
  ['model'],
);

export const llmGenerationTokensPerSec = makeGauge(
  'llm_generation_tokens_per_sec',
  'LLM generation-token throughput (spec name llm_generation_tokens_per_sec). Capacity tracking.',
  ['model'],
);

export const llmRequestsWaiting = makeGauge(
  'llm_requests_waiting',
  'LLM requests waiting in queue (spec name llm_requests_waiting). Warn sustained >0.',
  ['model'],
);

export const llmRequestsRunning = makeGauge(
  'llm_requests_running',
  'LLM requests currently running (spec name llm_requests_running). Warn near max batch.',
  ['model'],
);

export const llmQueueTimeSeconds = makeHistogram(
  'llm_queue_time_seconds',
  'LLM time spent waiting in queue (spec name llm_queue_time_seconds). SLO p95.',
  ['model'],
  DURATION_BUCKETS,
);

export const llmBatchSize = makeHistogram(
  'llm_batch_size',
  'LLM batch size at execution (spec name llm_batch_size). Utilization tracking.',
  ['model'],
  BATCH_BUCKETS,
);

export const llmRequestPreemptions = makeCounter(
  'llm_request_preemptions_total',
  'LLM request preemptions (spec name llm_request_preemptions_total). Warn on increase.',
  ['model'],
);

export const llmKvCacheUtilizationPct = makeGauge(
  'llm_kv_cache_utilization_pct',
  'LLM KV-cache utilization pct (spec name llm_kv_cache_utilization_pct). Warn >90%.',
  ['model'],
);

export const llmPrefixCacheHitRate = makeGauge(
  'llm_prefix_cache_hit_rate',
  'LLM prefix-cache hit rate 0..1 (spec name llm_prefix_cache_hit_rate). Low = prompt-structure tuning.',
  ['model'],
);

export const llmKvCacheEvictions = makeCounter(
  'llm_kv_cache_evictions_total',
  'LLM KV-cache evictions (spec name llm_kv_cache_evictions_total). Anomaly vs baseline.',
  ['model'],
);

export const llmRequestsSwapped = makeGauge(
  'llm_requests_swapped',
  'LLM requests swapped to CPU (spec name llm_requests_swapped). Warn >0.',
  ['model'],
);

export const llmRequestErrors = makeCounter(
  'llm_request_errors_total',
  'LLM request errors (spec name llm_request_errors_total). Warn ratio >1%.',
  ['model', 'error_type'],
);

export const llmFinishReason = makeCounter(
  'llm_finish_reason_total',
  'LLM finish reasons (spec name llm_finish_reason_total). Watch length / content_filter share.',
  ['model', 'reason'],
);

export const llmContextLengthExceeded = makeCounter(
  'llm_context_length_exceeded_total',
  'LLM context-length-exceeded responses (spec name llm_context_length_exceeded_total). Warn on increase.',
  ['model'],
);

export const llmGuardrailBlocks = makeCounter(
  'llm_guardrail_blocks_total',
  'LLM guardrail blocks (spec name llm_guardrail_blocks_total). Track rate.',
  ['model', 'policy'],
);

export const llmOutputSchemaInvalid = makeCounter(
  'llm_output_schema_invalid_total',
  'LLM output schema-validation failures (spec name llm_output_schema_invalid_total). Warn on ratio.',
  ['model'],
);

export const llmEvalGroundednessScore = makeGauge(
  'llm_eval_groundedness_score',
  'LLM groundedness score 0..1 (spec name llm_eval_groundedness_score). Alert below quality floor.',
  ['model'],
);

export const llmEvalToxicityFlags = makeCounter(
  'llm_eval_toxicity_flags_total',
  'LLM toxicity-eval flags raised (spec name llm_eval_toxicity_flags_total). Warn on increase.',
  ['model'],
);

export const llmRefusalRate = makeGauge(
  'llm_refusal_rate',
  'LLM refusal rate 0..1 (spec name llm_refusal_rate). Track.',
  ['model'],
);

export const llmInputDriftScore = makeGauge(
  'llm_input_drift_score',
  'LLM input drift score (spec name llm_input_drift_score). Alert above drift threshold.',
  ['model'],
);

export const llmOutputDriftScore = makeGauge(
  'llm_output_drift_score',
  'LLM output drift score (spec name llm_output_drift_score). Alert above drift threshold.',
  ['model'],
);

export const llmCostUsdPerRequest = makeHistogram(
  'llm_cost_usd_per_request',
  'LLM per-request cost in USD (spec name llm_cost_usd_per_request). Track.',
  ['model', 'tenant'],
  COST_BUCKETS,
);

export const llmCostUsdTotal = makeCounter(
  'llm_cost_usd_total',
  'LLM cumulative cost in USD (spec name llm_cost_usd_total). Budget tracking.',
  ['model', 'tenant', 'feature'],
);

// ---- Recorders ----

const KNOWN_OPERATIONS = new Set(['chat', 'completion', 'embedding', 'tools', 'plan']);

export function normalizeOperation(op: string | undefined): string {
  if (!op) return 'chat';
  if (KNOWN_OPERATIONS.has(op)) return op;
  return 'other';
}

export interface RecordLlmCallOpts {
  /** Bounded by the configured model list. */
  model: string;
  /** Bounded enum — see KNOWN_OPERATIONS. */
  operation?: string;
  /** Total wall-clock seconds. */
  durationSeconds: number;
  /** True iff the call returned an LLM result successfully. */
  success: boolean;
  /** Error class on failure. */
  errorType?: string;
  /** Optional token counts. */
  promptTokens?: number;
  completionTokens?: number;
  /** Optional finish reason — `stop` / `length` / `content_filter` / `tool_calls`. */
  finishReason?: string;
  /** Tenant identity (default `local`). Bounded by federation peer roster. */
  tenant?: string;
  /** Feature bucket (default `default`). Bounded enum. */
  feature?: string;
  /** Optional cost USD. Local Ollama is zero by definition. */
  costUsd?: number;
}

export function recordLlmCall(opts: RecordLlmCallOpts): void {
  const operation = normalizeOperation(opts.operation);
  const tenant = opts.tenant ?? 'local';
  const feature = opts.feature ?? 'default';

  // Counters
  llmRequests.labels(opts.model).inc();

  // Durations
  genAiClientOperationDuration.labels(opts.model, operation).observe(opts.durationSeconds);
  genAiServerRequestDuration.labels(opts.model).observe(opts.durationSeconds);

  // Tokens (when available)
  if (typeof opts.promptTokens === 'number' && opts.promptTokens > 0) {
    genAiClientTokenUsage.labels(opts.model, 'input').observe(opts.promptTokens);
  }
  if (typeof opts.completionTokens === 'number' && opts.completionTokens > 0) {
    genAiClientTokenUsage.labels(opts.model, 'output').observe(opts.completionTokens);
  }

  // Outcome
  if (!opts.success) {
    llmRequestErrors.labels(opts.model, opts.errorType ?? 'internal').inc();
  } else if (opts.finishReason) {
    llmFinishReason.labels(opts.model, normalizeFinishReason(opts.finishReason)).inc();
    if (opts.finishReason === 'length') {
      llmContextLengthExceeded.labels(opts.model).inc();
    }
  }

  // Cost (always emit; local providers pass 0).
  const cost = typeof opts.costUsd === 'number' ? opts.costUsd : 0;
  llmCostUsdPerRequest.labels(opts.model, tenant).observe(cost);
  llmCostUsdTotal.labels(opts.model, tenant, feature).inc(cost);
}

const KNOWN_FINISH_REASONS = new Set([
  'stop',
  'length',
  'content_filter',
  'tool_calls',
  'function_call',
  'eos',
]);

export function normalizeFinishReason(reason: string | undefined): string {
  if (!reason) return 'unknown';
  if (KNOWN_FINISH_REASONS.has(reason)) return reason;
  return 'other';
}
