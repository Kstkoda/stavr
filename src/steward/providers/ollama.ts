// src/steward/providers/ollama.ts
//
// Ollama provider — local LLM backend speaking the standard StewardProvider
// async-generator interface. Hits the Ollama HTTP API at /api/chat (non-stream
// for v1 — the loop's tool-call protocol doesn't yet need token-by-token
// streaming for local models). Used by the Eco profile and by the Balanced
// profile for capability tags that don't need a frontier model.
//
// Observability:
//   - Prometheus counters/histograms recorded via observability/metrics.ts
//     (`stavr_provider_*`)
//   - OTel span attributes via observability/spans.ts when the caller wraps
//     this in withExecuteToolSpan (the two-tier shape is preserved upstream
//     in the agent loop — this provider does not start its own invoke_agent
//     span).

import {
  type StewardCompleteOpts,
  type StewardEvent,
  type StewardProvider,
  type StewardToolCall,
} from './types.js';
import {
  recordProviderRequest,
  recordProviderLatency,
} from '../../observability/metrics.js';
import { recordSloSample } from '../../observability/slo.js';

export interface OllamaProviderOpts {
  /** Default `http://127.0.0.1:11434`. The Ollama daemon binds loopback by
   *  default and stavr explicitly does not support remote Ollama endpoints
   *  in v0.4 — that's a v0.6+ remote-runtime concern (ADR-035). */
  host?: string;
  /** Default model used when the call doesn't pass one. */
  model?: string;
  /** Per-request timeout. Default 120s — local inference can be slow on
   *  CPU-only boxes; the planner's per-step duration estimate is the upper
   *  bound for whether a local route was a reasonable choice. */
  timeoutMs?: number;
  /** Test seam. */
  fetchImpl?: typeof fetch;
}

interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
}

interface OllamaChatResponse {
  model: string;
  message: OllamaChatMessage;
  done: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  total_duration?: number;
}

interface OllamaTagsResponse {
  models: Array<{
    name: string;
    model: string;
    size: number;
    details?: { parameter_size?: string; family?: string };
  }>;
}

const DEFAULT_HOST = 'http://127.0.0.1:11434';
const DEFAULT_MODEL = 'llama3.2:3b';

/** Convert Steward tool specs into the Ollama /api/chat `tools` array. The
 *  shape mirrors OpenAI's function-calling schema, which Ollama adopted. */
function mapTools(tools: StewardCompleteOpts['tools']): Array<{
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}> {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

function mapMessages(
  systemPrompt: string,
  messages: StewardCompleteOpts['messages'],
): OllamaChatMessage[] {
  const out: OllamaChatMessage[] = [];
  if (systemPrompt) out.push({ role: 'system', content: systemPrompt });
  for (const m of messages) {
    if (m.role === 'system') continue;
    out.push({ role: m.role, content: m.content });
  }
  return out;
}

export function makeOllamaProvider(opts: OllamaProviderOpts = {}): StewardProvider & {
  listAvailableModels: () => Promise<string[]>;
} {
  const host = (opts.host ?? DEFAULT_HOST).replace(/\/+$/, '');
  const defaultModel = opts.model ?? DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const fetchImpl = opts.fetchImpl ?? fetch;

  return {
    name: 'ollama',
    defaultModel,
    complete(call: StewardCompleteOpts): AsyncGenerator<StewardEvent> {
      return runOllamaChat({
        host,
        model: call.model ?? defaultModel,
        timeoutMs,
        fetchImpl,
        body: {
          model: call.model ?? defaultModel,
          messages: mapMessages(call.systemPrompt, call.messages),
          tools: call.tools.length > 0 ? mapTools(call.tools) : undefined,
          stream: false,
          options: { num_predict: call.maxTokens ?? 4000 },
        },
      });
    },
    async listAvailableModels(): Promise<string[]> {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), Math.min(timeoutMs, 10_000));
      try {
        const res = await fetchImpl(`${host}/api/tags`, { signal: ctl.signal });
        if (!res.ok) return [];
        const json = (await res.json()) as OllamaTagsResponse;
        return json.models.map((m) => m.name).sort();
      } catch {
        return [];
      } finally {
        clearTimeout(to);
      }
    },
  };
}

interface RunOpts {
  host: string;
  model: string;
  timeoutMs: number;
  fetchImpl: typeof fetch;
  body: Record<string, unknown>;
}

async function* runOllamaChat(opts: RunOpts): AsyncGenerator<StewardEvent> {
  const start = Date.now();
  let status: 'ok' | 'error' | 'timeout' = 'ok';
  const ctl = new AbortController();
  const to = setTimeout(() => {
    status = 'timeout';
    ctl.abort();
  }, opts.timeoutMs);

  try {
    const res = await opts.fetchImpl(`${opts.host}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(opts.body),
      signal: ctl.signal,
    });
    if (!res.ok) {
      status = 'error';
      const txt = await res.text();
      throw new Error(`ollama api ${res.status}: ${txt.slice(0, 500)}`);
    }
    const json = (await res.json()) as OllamaChatResponse;

    // text content
    if (json.message?.content) {
      yield { kind: 'text', text: json.message.content };
    }

    // tool calls — Ollama emits OpenAI-style tool_calls when the model
    // decides to invoke a tool; emit each as a tool_call StewardEvent.
    for (const tc of json.message?.tool_calls ?? []) {
      const call: StewardToolCall = {
        id: cryptoRandomId(),
        name: tc.function.name,
        args: tc.function.arguments ?? {},
      };
      yield { kind: 'tool_call', call };
    }

    yield {
      kind: 'usage',
      usage: {
        input_tokens: json.prompt_eval_count ?? 0,
        output_tokens: json.eval_count ?? 0,
        cost_usd: 0, // local inference has no per-token cost
      },
    };
    yield { kind: 'done', stop_reason: json.done_reason ?? 'stop' };
  } catch (err) {
    if (status === 'ok') status = 'error';
    throw err;
  } finally {
    clearTimeout(to);
    const elapsed = (Date.now() - start) / 1000;
    recordProviderRequest('ollama', opts.model, status);
    recordProviderLatency('ollama', opts.model, elapsed);
    // BOM Wave 0 — llm_provider_availability SLO sample.
    recordSloSample('llm_provider_availability', status === 'ok');
  }
}

function cryptoRandomId(): string {
  // 8 hex chars is enough — the loop uses this only to thread responses.
  return Math.random().toString(16).slice(2, 10);
}
