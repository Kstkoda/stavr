import type {
  StewardCompleteOpts,
  StewardEvent,
  StewardProvider,
  StewardToolCall,
} from './types.js';

interface AnthropicMessageResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  >;
  model: string;
  stop_reason: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

export interface AnthropicProviderOpts {
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
  apiUrl?: string;
}

/**
 * Direct call to https://api.anthropic.com/v1/messages. Streams the full
 * response as discrete StewardEvents — text chunks, tool calls, usage,
 * then a final 'done'. We use the non-streaming endpoint (much simpler) and
 * yield events from the parsed response; richer SSE streaming is a future
 * improvement.
 */
export function makeAnthropicProvider(opts: AnthropicProviderOpts): StewardProvider {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const apiUrl = opts.apiUrl ?? 'https://api.anthropic.com/v1/messages';
  const defaultModel = opts.model ?? 'claude-opus-4-7';

  return {
    name: 'anthropic',
    defaultModel,
    async *complete(call: StewardCompleteOpts): AsyncGenerator<StewardEvent> {
      const body = {
        model: call.model ?? defaultModel,
        max_tokens: call.maxTokens ?? 4000,
        system: call.systemPrompt,
        messages: call.messages.filter((m) => m.role !== 'system'),
        tools: call.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.input_schema,
        })),
      };
      const res = await fetchImpl(apiUrl, {
        method: 'POST',
        headers: {
          'x-api-key': opts.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`anthropic api ${res.status}: ${txt.slice(0, 500)}`);
      }
      const json = (await res.json()) as AnthropicMessageResponse;
      for (const block of json.content) {
        if (block.type === 'text') {
          yield { kind: 'text', text: block.text };
        } else if (block.type === 'tool_use') {
          const call: StewardToolCall = {
            id: block.id,
            name: block.name,
            args: block.input,
          };
          yield { kind: 'tool_call', call };
        }
      }
      yield {
        kind: 'usage',
        usage: {
          input_tokens: json.usage.input_tokens,
          output_tokens: json.usage.output_tokens,
          cache_read_tokens: json.usage.cache_read_input_tokens,
          cache_creation_tokens: json.usage.cache_creation_input_tokens,
          cost_usd: estimateCostUsd(json.model, json.usage),
        },
      };
      yield { kind: 'done', stop_reason: json.stop_reason };
    },
  };
}

/**
 * Best-effort cost estimate. Opus 4.x is ~$15/1M input, ~$75/1M output (May 2026
 * publicized pricing). Sonnet is ~$3/$15. Haiku ~$0.80/$4. If the model name
 * doesn't match a known family, we return 0 — the dashboard surfaces "cost
 * unknown" so the User can update the table.
 */
export function estimateCostUsd(
  model: string,
  usage: { input_tokens: number; output_tokens: number },
): number {
  const m = model.toLowerCase();
  let inPer1M = 0;
  let outPer1M = 0;
  if (m.includes('opus')) {
    inPer1M = 15;
    outPer1M = 75;
  } else if (m.includes('sonnet')) {
    inPer1M = 3;
    outPer1M = 15;
  } else if (m.includes('haiku')) {
    inPer1M = 0.8;
    outPer1M = 4;
  }
  return (usage.input_tokens * inPer1M + usage.output_tokens * outPer1M) / 1_000_000;
}

// ---------------------------------------------------------------------------
// family-son-mcp Phase 5 Phase 3b — raw HTTP forward helper for the
// /anthropic/v1/messages gateway path.
// ---------------------------------------------------------------------------
//
// `makeAnthropicProvider(...).complete()` above wraps the same upstream
// endpoint but yields StewardEvents (text / tool_call / usage / done).
// That shape is wrong for the gateway path, which needs to return the
// son's CC the raw Anthropic response body verbatim. This helper does
// the minimum: prepare headers (operator key + version), POST, parse
// the response, extract usage tokens for Phase 4 metering, and return
// a structured result. It NEVER throws on upstream non-2xx — those are
// returned as `{ status, body }`; the route handler decides shape.
//
// Credential hygiene (BOM hard invariant #1 + recon F6):
//
//   - The `apiKey` arrives via the closure of the caller. It is used
//     ONLY in the `x-api-key` header of the outbound request. It is
//     not assigned to any returned field, not interpolated into any
//     error message, not held beyond the synchronous header
//     construction.
//   - Upstream fetch failures (network/abort/timeout) return a
//     constant `errorMessage` token. The native error's `.message`
//     is intentionally NOT forwarded — Node's fetch implementation
//     does not include request headers in its error messages today,
//     but the safer rule is "no native error text crosses the
//     gateway boundary."
//   - Upstream body that fails to read or JSON-parse returns a
//     constant `errorMessage` token; the partial bodyText is
//     dropped. (Anthropic 5xx HTML pages will trip the JSON parse
//     fallback, returning errorMessage='upstream_body_not_json'.)
//   - The route handler is responsible for the response shape it
//     sends to the son and the audit-event payload. This helper
//     only returns structured data.

export interface ForwardAnthropicArgs {
  /** Operator's Anthropic API key. Held only for the duration of this
   *  function; passed through to the `x-api-key` header. */
  apiKey: string;
  /** The son's request body as parsed JSON. Forwarded as-is via
   *  JSON.stringify. */
  body: unknown;
  /** Selected request headers to forward from the son. F2 decision
   *  (2026-05-27): pass-through `anthropic-version` from the son if
   *  present; nothing else from the son is forwarded. */
  forwardHeaders: {
    'anthropic-version'?: string;
  };
  /** Override the upstream URL (tests). */
  apiUrl?: string;
  /** Override fetch (tests). */
  fetchImpl?: typeof fetch;
  /** Upstream timeout. Anthropic's published P99 for non-streaming
   *  Messages is ~30s; 120s gives the operator headroom for long
   *  contexts without holding the son's HTTP socket open forever. */
  timeoutMs?: number;
}

export interface ForwardAnthropicResult {
  /** HTTP status of the upstream response, or a synthetic 502/504
   *  when fetch failed before/while reading the response. */
  status: number;
  /** Parsed upstream JSON, or undefined when parsing failed. */
  body: unknown;
  /** Phase 4 metering hook: token counts from the upstream `usage`
   *  shape when the call succeeded. Absent on errors or non-Messages
   *  upstream shapes. */
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens?: number;
    cache_creation_tokens?: number;
  };
  /** Sanitized error class on failures. One of:
   *    'upstream_timeout' | 'upstream_unreachable' |
   *    'upstream_body_read_failed' | 'upstream_body_not_json'.
   *  Always a constant string — never interpolated from upstream
   *  text or native error messages. Absent on success. */
  errorMessage?: string;
  /** Duration of the upstream call in milliseconds. Surfaces for the
   *  audit-event payload regardless of success or failure. */
  durationMs: number;
}

export async function forwardAnthropicMessages(
  args: ForwardAnthropicArgs,
): Promise<ForwardAnthropicResult> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const apiUrl = args.apiUrl ?? 'https://api.anthropic.com/v1/messages';
  const anthropicVersion = args.forwardHeaders['anthropic-version'] ?? '2023-06-01';
  const timeoutMs = args.timeoutMs ?? 120_000;

  // Headers built immediately before fetch; not assigned to any
  // closure-escaping variable. Three keys exactly — anything else
  // (e.g., anthropic-beta) is a future widening decision, not Phase 5.
  const headers: Record<string, string> = {
    'x-api-key': args.apiKey,
    'anthropic-version': anthropicVersion,
    'content-type': 'application/json',
  };

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  const startedAtMs = Date.now();

  let res: Response;
  try {
    res = await fetchImpl(apiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(args.body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutHandle);
    const isAbort = (err as { name?: string }).name === 'AbortError';
    return {
      status: isAbort ? 504 : 502,
      body: undefined,
      errorMessage: isAbort ? 'upstream_timeout' : 'upstream_unreachable',
      durationMs: Date.now() - startedAtMs,
    };
  } finally {
    clearTimeout(timeoutHandle);
  }

  let bodyText: string;
  try {
    bodyText = await res.text();
  } catch {
    return {
      status: 502,
      body: undefined,
      errorMessage: 'upstream_body_read_failed',
      durationMs: Date.now() - startedAtMs,
    };
  }

  let parsedBody: unknown;
  try {
    parsedBody = bodyText.length > 0 ? JSON.parse(bodyText) : undefined;
  } catch {
    return {
      status: res.status,
      body: undefined,
      errorMessage: 'upstream_body_not_json',
      durationMs: Date.now() - startedAtMs,
    };
  }

  // Phase 4 metering hook: extract usage tokens from the standard
  // Anthropic Messages success shape. Absent on errors.
  let usage: ForwardAnthropicResult['usage'];
  if (
    res.ok &&
    parsedBody &&
    typeof parsedBody === 'object' &&
    'usage' in parsedBody
  ) {
    const u = (parsedBody as { usage?: Record<string, unknown> }).usage;
    if (u && typeof u === 'object') {
      const inT = typeof u.input_tokens === 'number' ? u.input_tokens : undefined;
      const outT = typeof u.output_tokens === 'number' ? u.output_tokens : undefined;
      if (inT !== undefined && outT !== undefined) {
        usage = {
          input_tokens: inT,
          output_tokens: outT,
          cache_read_tokens:
            typeof u.cache_read_input_tokens === 'number'
              ? u.cache_read_input_tokens
              : undefined,
          cache_creation_tokens:
            typeof u.cache_creation_input_tokens === 'number'
              ? u.cache_creation_input_tokens
              : undefined,
        };
      }
    }
  }

  return {
    status: res.status,
    body: parsedBody,
    usage,
    durationMs: Date.now() - startedAtMs,
  };
}
