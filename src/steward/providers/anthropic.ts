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
