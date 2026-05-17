import { describe, expect, it } from 'vitest';
import { makeOpenAIRuntime } from '../../../src/steward-agent/runtimes/openai.js';
import { isValidationFailure } from '../../../src/steward-agent/runtimes/types.js';

function openaiResponse(content: string) {
  return {
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 20, completion_tokens: 80 },
    model: 'gpt-5.5',
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
      capability: 'reading',
      risk_class: 'read-only',
      brick_id: 'b',
      model: 'gpt-5.5',
      cost_estimate: 0.02,
      duration_sec_est: 1,
      depends_on: [],
    },
  ],
  cost_estimate: 0.02,
  cost_max: 0.1,
  duration_sec_est: 1,
  risk_envelope: ['read-only'],
};

describe('v0.5 P2 — OpenAIRuntime', () => {
  it('plan() returns a ValidatedBOM on first valid response', async () => {
    const fetchImpl = makeFetch([openaiResponse(JSON.stringify(validBom))]);
    const rt = makeOpenAIRuntime({ apiKey: 'k', fetchImpl });
    const r = await rt.plan({ goal: 'g', profile_mode: 'balanced' }, []);
    if (isValidationFailure(r)) throw new Error('expected success');
    expect(r.goal).toBe('g');
    expect(r.usage.cost_usd).toBeGreaterThan(0);
  });

  it('retries 3× and surfaces ValidationFailure', async () => {
    const fetchImpl = makeFetch([
      openaiResponse('{"not":"a bom"}'),
      openaiResponse('{"still":"wrong"}'),
      openaiResponse('{"final":"miss"}'),
    ]);
    const rt = makeOpenAIRuntime({ apiKey: 'k', fetchImpl });
    const r = await rt.plan({ goal: 'g', profile_mode: 'balanced' }, []);
    expect(isValidationFailure(r)).toBe(true);
    if (!isValidationFailure(r)) throw new Error('unreachable');
    expect(r.runtime).toBe('openai');
    expect(r.task_kind).toBe('plan');
    expect(r.attempts).toBe(3);
  });

  it('decide() validates option choice', async () => {
    const choice = { chosen_option_id: 'x', reason: 'r', confidence: 0.9 };
    const fetchImpl = makeFetch([openaiResponse(JSON.stringify(choice))]);
    const rt = makeOpenAIRuntime({ apiKey: 'k', fetchImpl });
    const r = await rt.decide({ question: 'q?', options: [{ id: 'x', label: 'X' }] });
    if (isValidationFailure(r)) throw new Error('expected success');
    expect(r.chosen_option_id).toBe('x');
  });

  it('summarize() validates digest shape', async () => {
    const digest = { summary: 's', highlights: ['h1'], recommendations: [] };
    const fetchImpl = makeFetch([openaiResponse(JSON.stringify(digest))]);
    const rt = makeOpenAIRuntime({ apiKey: 'k', fetchImpl });
    const r = await rt.summarize([{ at: 't', kind: 'k', summary: 's' }]);
    if (isValidationFailure(r)) throw new Error('expected success');
    expect(r.highlights).toEqual(['h1']);
  });
});
