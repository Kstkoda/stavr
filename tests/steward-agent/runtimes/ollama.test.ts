import { describe, expect, it } from 'vitest';
import { makeOllamaRuntime } from '../../../src/steward-agent/runtimes/ollama.js';
import { isValidationFailure } from '../../../src/steward-agent/runtimes/types.js';

function ollamaResponse(content: string) {
  return {
    model: 'llama3.2:3b',
    message: { role: 'assistant', content },
    done: true,
    done_reason: 'stop',
    prompt_eval_count: 30,
    eval_count: 60,
  };
}

function makeFetch(responses: unknown[]): typeof fetch {
  let i = 0;
  return (async () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return new Response(JSON.stringify(r), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

const validBom = {
  goal: 'g',
  steps: [
    {
      step_no: 1,
      title: 't',
      capability: 'simple-summary',
      risk_class: 'read-only',
      brick_id: 'b',
      model: 'llama3.2:3b',
      cost_estimate: 0,
      duration_sec_est: 30,
      depends_on: [],
    },
  ],
  cost_estimate: 0,
  cost_max: 1,
  duration_sec_est: 30,
  risk_envelope: ['read-only'],
};

describe('v0.5 P2 — OllamaRuntime', () => {
  it('plan() succeeds with cost_usd=0 (local inference)', async () => {
    const fetchImpl = makeFetch([ollamaResponse(JSON.stringify(validBom))]);
    const rt = makeOllamaRuntime({ fetchImpl });
    const r = await rt.plan({ goal: 'g', profile_mode: 'eco' }, []);
    if (isValidationFailure(r)) throw new Error('expected success');
    expect(r.usage.cost_usd).toBe(0);
    expect(rt.costPerKtoken).toEqual({ in: 0, out: 0 });
  });

  it('handles fenced JSON in model output', async () => {
    const fenced = '```json\n' + JSON.stringify(validBom) + '\n```';
    const fetchImpl = makeFetch([ollamaResponse(fenced)]);
    const rt = makeOllamaRuntime({ fetchImpl });
    const r = await rt.plan({ goal: 'g', profile_mode: 'eco' }, []);
    if (isValidationFailure(r)) throw new Error('expected success');
    expect(r.steps).toHaveLength(1);
  });

  it('retries on malformed output', async () => {
    const fetchImpl = makeFetch([
      ollamaResponse('not even close'),
      ollamaResponse('{"sort":"of"}'),
      ollamaResponse('still wrong'),
    ]);
    const rt = makeOllamaRuntime({ fetchImpl });
    const r = await rt.plan({ goal: 'g', profile_mode: 'eco' }, []);
    expect(isValidationFailure(r)).toBe(true);
    if (!isValidationFailure(r)) throw new Error('unreachable');
    expect(r.runtime).toBe('ollama');
    expect(r.attempts).toBe(3);
  });

  it('decide() works', async () => {
    const choice = { chosen_option_id: 'a', reason: 'r', confidence: 0.5 };
    const fetchImpl = makeFetch([ollamaResponse(JSON.stringify(choice))]);
    const rt = makeOllamaRuntime({ fetchImpl });
    const r = await rt.decide({ question: 'q?', options: [{ id: 'a', label: 'A' }] });
    if (isValidationFailure(r)) throw new Error('expected success');
    expect(r.chosen_option_id).toBe('a');
  });
});
