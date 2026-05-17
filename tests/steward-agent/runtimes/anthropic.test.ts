import { describe, expect, it } from 'vitest';
import { makeAnthropicRuntime } from '../../../src/steward-agent/runtimes/anthropic.js';
import { isValidationFailure } from '../../../src/steward-agent/runtimes/types.js';

function makeFetch(responses: Array<unknown | { __status?: number; __body?: string }>): typeof fetch {
  let i = 0;
  return (async (_url: string | URL | Request, _init?: RequestInit) => {
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    if (r && typeof r === 'object' && '__status' in r) {
      return new Response(r.__body ?? '', { status: r.__status as number });
    }
    return new Response(JSON.stringify(r), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

function anthropicResponseWithText(text: string) {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text }],
    model: 'claude-opus-4-7',
    stop_reason: 'end_turn',
    usage: { input_tokens: 12, output_tokens: 50 },
  };
}

const validBom = {
  goal: 'test goal',
  steps: [
    {
      step_no: 1,
      title: 'step a',
      capability: 'reading',
      risk_class: 'read-only',
      brick_id: 'b',
      model: 'claude-opus-4-7',
      cost_estimate: 0.01,
      duration_sec_est: 5,
      depends_on: [],
    },
  ],
  cost_estimate: 0.01,
  cost_max: 0.05,
  duration_sec_est: 5,
  risk_envelope: ['read-only'],
};

describe('v0.5 P2 — AnthropicRuntime', () => {
  it('plan() returns a ValidatedBOM on first valid response', async () => {
    const fetchImpl = makeFetch([
      anthropicResponseWithText(JSON.stringify(validBom)),
    ]);
    const rt = makeAnthropicRuntime({ apiKey: 'k', fetchImpl });
    const r = await rt.plan(
      { goal: 'g', profile_mode: 'balanced' },
      [],
    );
    if (isValidationFailure(r)) throw new Error('expected success');
    expect(r.steps).toHaveLength(1);
    expect(r.usage.input_tokens).toBe(12);
  });

  it('plan() retries up to 3× on schema failure, sharpens system prompt each attempt', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? '{}');
      calls.push(body.system as string);
      // Always reply with invalid JSON (missing required fields).
      return new Response(JSON.stringify(anthropicResponseWithText('{"goal":"x"}')), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const rt = makeAnthropicRuntime({ apiKey: 'k', fetchImpl });
    const r = await rt.plan({ goal: 'g', profile_mode: 'balanced' }, []);
    expect(isValidationFailure(r)).toBe(true);
    if (!isValidationFailure(r)) throw new Error('unreachable');
    expect(r.attempts).toBe(3);
    // First call uses base prompt; subsequent calls include error from prior attempt.
    expect(calls).toHaveLength(3);
    expect(calls[1]).toContain('Your previous output failed schema validation');
    expect(calls[2]).toContain('final attempt');
  });

  it('decide() returns ValidatedChoice on valid response', async () => {
    const choice = {
      chosen_option_id: 'opt-a',
      reason: 'because',
      confidence: 0.7,
    };
    const fetchImpl = makeFetch([anthropicResponseWithText(JSON.stringify(choice))]);
    const rt = makeAnthropicRuntime({ apiKey: 'k', fetchImpl });
    const r = await rt.decide({
      question: 'q?',
      options: [{ id: 'opt-a', label: 'A' }],
    });
    if (isValidationFailure(r)) throw new Error('expected success');
    expect(r.chosen_option_id).toBe('opt-a');
    expect(r.confidence).toBe(0.7);
  });

  it('summarize() returns ValidatedDigest on valid response', async () => {
    const digest = {
      summary: 'all good',
      highlights: ['one'],
      recommendations: ['two'],
    };
    const fetchImpl = makeFetch([anthropicResponseWithText(JSON.stringify(digest))]);
    const rt = makeAnthropicRuntime({ apiKey: 'k', fetchImpl });
    const r = await rt.summarize([
      { at: '2026-05-17T12:00:00Z', kind: 'bom_step_done', summary: 's' },
    ]);
    if (isValidationFailure(r)) throw new Error('expected success');
    expect(r.summary).toBe('all good');
    expect(r.highlights).toEqual(['one']);
  });

  it('injects usage server-side if model omits it', async () => {
    // Model returns a BOM without usage field; runtime should fill from
    // anthropic usage block.
    const bomNoUsage = { ...validBom };
    const fetchImpl = makeFetch([
      {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: JSON.stringify(bomNoUsage) }],
        model: 'claude-opus-4-7',
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 200 },
      },
    ]);
    const rt = makeAnthropicRuntime({ apiKey: 'k', fetchImpl });
    const r = await rt.plan({ goal: 'g', profile_mode: 'balanced' }, []);
    if (isValidationFailure(r)) throw new Error('expected success');
    expect(r.usage.input_tokens).toBe(100);
    expect(r.usage.output_tokens).toBe(200);
    expect(r.usage.cost_usd).toBeGreaterThan(0);
  });

  it('cost_max=$1000 fails validation (off-by-1000 guard)', async () => {
    const badBom = { ...validBom, cost_max: 1000 };
    const fetchImpl = makeFetch([anthropicResponseWithText(JSON.stringify(badBom))]);
    const rt = makeAnthropicRuntime({ apiKey: 'k', fetchImpl });
    const r = await rt.plan({ goal: 'g', profile_mode: 'balanced' }, []);
    expect(isValidationFailure(r)).toBe(true);
  });
});
