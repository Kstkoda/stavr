import { describe, expect, it, vi } from 'vitest';
import { makeOllamaProvider } from '../../../src/steward/providers/ollama.js';
import type {
  StewardCompleteOpts,
  StewardEvent,
} from '../../../src/steward/providers/types.js';

function mockFetchOk(json: unknown): typeof fetch {
  return vi.fn(async (_url: unknown, _init?: unknown) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(json),
    json: async () => json,
  })) as unknown as typeof fetch;
}

function mockFetchErr(status: number, body = 'oops'): typeof fetch {
  return vi.fn(async () => ({
    ok: false,
    status,
    text: async () => body,
    json: async () => ({}),
  })) as unknown as typeof fetch;
}

const baseCall: StewardCompleteOpts = {
  systemPrompt: 'be brief',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [],
};

async function collect(gen: AsyncGenerator<StewardEvent>): Promise<StewardEvent[]> {
  const out: StewardEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

describe('OllamaProvider', () => {
  it('emits text + usage + done for a happy-path chat response', async () => {
    const fetchImpl = mockFetchOk({
      model: 'llama3.2:3b',
      message: { role: 'assistant', content: 'hello five words yo go' },
      done: true,
      done_reason: 'stop',
      prompt_eval_count: 12,
      eval_count: 6,
    });
    const p = makeOllamaProvider({ fetchImpl });
    const events = await collect(p.complete(baseCall));
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual(['text', 'usage', 'done']);
    const text = events.find((e) => e.kind === 'text');
    expect(text && text.kind === 'text' && text.text).toBe('hello five words yo go');
    const usage = events.find((e) => e.kind === 'usage');
    expect(usage && usage.kind === 'usage' && usage.usage.input_tokens).toBe(12);
    expect(usage && usage.kind === 'usage' && usage.usage.output_tokens).toBe(6);
    expect(usage && usage.kind === 'usage' && usage.usage.cost_usd).toBe(0);
  });

  it('maps tool_calls into tool_call StewardEvents', async () => {
    const fetchImpl = mockFetchOk({
      model: 'llama3.2:3b',
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          { function: { name: 'search', arguments: { query: 'cats' } } },
        ],
      },
      done: true,
      prompt_eval_count: 20,
      eval_count: 3,
    });
    const p = makeOllamaProvider({ fetchImpl });
    const events = await collect(p.complete(baseCall));
    const tc = events.find((e) => e.kind === 'tool_call');
    expect(tc).toBeDefined();
    if (tc && tc.kind === 'tool_call') {
      expect(tc.call.name).toBe('search');
      expect(tc.call.args).toEqual({ query: 'cats' });
    }
  });

  it('throws on non-2xx with body in the error message', async () => {
    const fetchImpl = mockFetchErr(500, 'kaboom');
    const p = makeOllamaProvider({ fetchImpl });
    await expect(collect(p.complete(baseCall))).rejects.toThrow(/ollama api 500/);
  });

  it('listAvailableModels returns sorted model names from /api/tags', async () => {
    const fetchImpl = mockFetchOk({
      models: [
        { name: 'phi3:mini', model: 'phi3:mini', size: 100 },
        { name: 'llama3.2:3b', model: 'llama3.2:3b', size: 200 },
      ],
    });
    const p = makeOllamaProvider({ fetchImpl });
    const names = await p.listAvailableModels();
    expect(names).toEqual(['llama3.2:3b', 'phi3:mini']);
  });

  it('listAvailableModels returns [] when the Ollama daemon is unreachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const p = makeOllamaProvider({ fetchImpl });
    const names = await p.listAvailableModels();
    expect(names).toEqual([]);
  });

  it('respects host override and strips trailing slash', async () => {
    const fetchImpl = vi.fn(async (url: unknown) => {
      expect(String(url)).toBe('http://localhost:9999/api/chat');
      return {
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({
          model: 'phi3:mini',
          message: { role: 'assistant', content: 'ok' },
          done: true,
          prompt_eval_count: 1,
          eval_count: 1,
        }),
      };
    }) as unknown as typeof fetch;
    const p = makeOllamaProvider({ host: 'http://localhost:9999/', fetchImpl });
    await collect(p.complete(baseCall));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('maps system + multi-turn messages, dropping inline system turns', async () => {
    let bodySeen: unknown;
    const fetchImpl = vi.fn(async (_url: unknown, init: { body?: string } | undefined) => {
      bodySeen = init?.body ? JSON.parse(init.body) : undefined;
      return {
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({
          model: 'llama3.2:3b',
          message: { role: 'assistant', content: 'done' },
          done: true,
          prompt_eval_count: 1,
          eval_count: 1,
        }),
      };
    }) as unknown as typeof fetch;
    const p = makeOllamaProvider({ fetchImpl });
    await collect(
      p.complete({
        systemPrompt: 'sys',
        messages: [
          { role: 'system', content: 'redundant' },
          { role: 'user', content: 'a' },
          { role: 'assistant', content: 'b' },
          { role: 'user', content: 'c' },
        ],
        tools: [],
      }),
    );
    const body = bodySeen as { messages: Array<{ role: string; content: string }> };
    expect(body.messages.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
    ]);
    expect(body.messages[0].content).toBe('sys');
  });
});
