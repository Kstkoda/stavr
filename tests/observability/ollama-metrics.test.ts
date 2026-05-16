import { describe, expect, it, vi, beforeEach } from 'vitest';
import { makeOllamaProvider } from '../../src/steward/providers/ollama.js';
import {
  registry,
  stavrProviderRequests,
  stavrProviderLatency,
} from '../../src/observability/metrics.js';

function mockFetchOk(json: unknown): typeof fetch {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(json),
    json: async () => json,
  })) as unknown as typeof fetch;
}

function mockFetchErr(): typeof fetch {
  return vi.fn(async () => ({
    ok: false,
    status: 500,
    text: async () => 'boom',
    json: async () => ({}),
  })) as unknown as typeof fetch;
}

async function drain(gen: AsyncGenerator<unknown>): Promise<void> {
  try {
    for await (const _ev of gen) {
      void _ev;
    }
  } catch {
    /* test expects this for the error case */
  }
}

beforeEach(() => {
  stavrProviderRequests.reset();
  stavrProviderLatency.reset();
});

describe('Ollama provider metrics integration', () => {
  it('records stavr_provider_requests_total with ok status on success', async () => {
    const p = makeOllamaProvider({
      fetchImpl: mockFetchOk({
        message: { role: 'assistant', content: 'hi' },
        done: true,
        prompt_eval_count: 5,
        eval_count: 2,
      }),
    });
    await drain(p.complete({ systemPrompt: '', messages: [{ role: 'user', content: 'a' }], tools: [] }));
    const text = await registry.metrics();
    expect(text).toMatch(/stavr_provider_requests_total\{[^}]*provider="ollama"[^}]*status="ok"[^}]*\}\s+1/);
    expect(text).toMatch(/stavr_provider_latency_seconds_count\{[^}]*provider="ollama"[^}]*\}\s+1/);
  });

  it('records status="error" when the call throws', async () => {
    const p = makeOllamaProvider({ fetchImpl: mockFetchErr() });
    await drain(p.complete({ systemPrompt: '', messages: [{ role: 'user', content: 'a' }], tools: [] }));
    const text = await registry.metrics();
    expect(text).toMatch(/stavr_provider_requests_total\{[^}]*provider="ollama"[^}]*status="error"[^}]*\}\s+1/);
  });

  it('labels include the model name so per-model rates can be aggregated', async () => {
    const p = makeOllamaProvider({
      model: 'phi3:mini',
      fetchImpl: mockFetchOk({
        message: { role: 'assistant', content: '' },
        done: true,
        prompt_eval_count: 1,
        eval_count: 1,
      }),
    });
    await drain(p.complete({ systemPrompt: '', messages: [{ role: 'user', content: 'a' }], tools: [] }));
    const text = await registry.metrics();
    expect(text).toMatch(/stavr_provider_requests_total\{[^}]*model="phi3:mini"[^}]*\}/);
  });
});
