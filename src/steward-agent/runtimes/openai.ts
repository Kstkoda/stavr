// v0.5 P2 — OpenAIRuntime.
//
// Direct fetch against https://api.openai.com/v1/chat/completions — we avoid
// adding the `openai` SDK as a mid-flight dep (CLAUDE.md don't-touch list
// implicitly + v0.5 BOM's "don't introduce a new dep mid-flight" note). The
// chat-completions JSON-mode produces well-formed JSON which the retry layer
// validates against ValidatedBOM / ValidatedChoice / ValidatedDigest.

import {
  ValidatedBOMZ,
  ValidatedChoiceZ,
  ValidatedDigestZ,
  planSystemPrompt,
  decideSystemPrompt,
  summarizeSystemPrompt,
} from './schemas.js';
import { runWithRetry, sharpenInstruction } from './retry.js';
import type {
  DecideReq,
  EpisodicEvent,
  ModelRuntime,
  PlanCtx,
  ToolSpec,
  ValidatedBOM,
  ValidatedChoice,
  ValidatedDigest,
  ValidationFailure,
} from './types.js';

export interface OpenAIRuntimeOpts {
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
  apiUrl?: string;
}

interface ChatCompletionResponse {
  choices: Array<{ message: { content: string | null } }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
  model: string;
}

const DEFAULT_MODEL = 'gpt-5.5';
const DEFAULT_URL = 'https://api.openai.com/v1/chat/completions';

// gpt-5.5 pricing — best-effort; update when published. The runtime accepts
// arbitrary models, so cost is estimated from a small lookup table; unknown
// models report 0 and the dashboard shows "cost unknown".
const COST_TABLE: Record<string, { in: number; out: number }> = {
  'gpt-5.5': { in: 5 / 1000, out: 15 / 1000 },
  'gpt-5': { in: 10 / 1000, out: 30 / 1000 },
  'gpt-4o': { in: 2.5 / 1000, out: 10 / 1000 },
};

function costPerKtoken(model: string): { in: number; out: number } {
  for (const k of Object.keys(COST_TABLE)) if (model.startsWith(k)) return COST_TABLE[k];
  return { in: 0, out: 0 };
}

export function makeOpenAIRuntime(opts: OpenAIRuntimeOpts): ModelRuntime {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const apiUrl = opts.apiUrl ?? DEFAULT_URL;
  const model = opts.model ?? DEFAULT_MODEL;
  const rate = costPerKtoken(model);

  async function call(systemPrompt: string, userMsg: string, maxTokens: number): Promise<string> {
    const res = await fetchImpl(apiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        // JSON mode (response_format) — supported on gpt-4o and later. Forces
        // the model to emit syntactically valid JSON, removing one whole class
        // of validation failure.
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMsg },
        ],
      }),
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`openai api ${res.status}: ${txt.slice(0, 500)}`);
    }
    const json = (await res.json()) as ChatCompletionResponse;
    const content = json.choices[0]?.message?.content ?? '';
    const promptTokens = json.usage?.prompt_tokens ?? 0;
    const completionTokens = json.usage?.completion_tokens ?? 0;
    const cost = (promptTokens * rate.in + completionTokens * rate.out) / 1000;
    return injectUsage(content, {
      input_tokens: promptTokens,
      output_tokens: completionTokens,
      cost_usd: cost,
    });
  }

  return {
    name: 'openai',
    costPerKtoken: rate,
    contextWindow: 200_000,
    async plan(ctx, tools): Promise<ValidatedBOM | ValidationFailure> {
      return runWithRetry({
        runtime: 'openai',
        task: 'plan',
        schema: ValidatedBOMZ,
        call: (attempt, priorError) =>
          call(
            sharpenInstruction(planSystemPrompt(), priorError, attempt),
            buildPlanUserPrompt(ctx, tools),
            ctx.max_tokens ?? 4000,
          ),
      });
    },
    async decide(req): Promise<ValidatedChoice | ValidationFailure> {
      return runWithRetry({
        runtime: 'openai',
        task: 'decide',
        schema: ValidatedChoiceZ,
        call: (attempt, priorError) =>
          call(sharpenInstruction(decideSystemPrompt(), priorError, attempt), buildDecideUserPrompt(req), 1000),
      });
    },
    async summarize(events): Promise<ValidatedDigest | ValidationFailure> {
      return runWithRetry({
        runtime: 'openai',
        task: 'summarize',
        schema: ValidatedDigestZ,
        call: (attempt, priorError) =>
          call(
            sharpenInstruction(summarizeSystemPrompt(), priorError, attempt),
            buildSummarizeUserPrompt(events),
            2000,
          ),
      });
    },
  };
}

function buildPlanUserPrompt(ctx: PlanCtx, tools: ToolSpec[]): string {
  const lessons = (ctx.lessons ?? []).slice(0, 20).map((l) => `- ${l.title}: ${l.body}`).join('\n');
  const wm = ctx.working_memory ? JSON.stringify(ctx.working_memory).slice(0, 2000) : '{}';
  return [
    `Goal: ${ctx.goal}`,
    `Profile mode: ${ctx.profile_mode}`,
    'Working memory:',
    wm,
    'Active lessons:',
    lessons || '(none)',
    `Tools available: ${tools.map((t) => t.name).join(', ') || '(none)'}`,
    'Produce a ValidatedBOM JSON object.',
  ].join('\n');
}

function buildDecideUserPrompt(req: DecideReq): string {
  const opts = req.options.map((o) => `id="${o.id}" — ${o.label}`).join('\n');
  return [`Question: ${req.question}`, req.context ?? '', opts, 'Respond with a ValidatedChoice JSON object.']
    .filter(Boolean)
    .join('\n');
}

function buildSummarizeUserPrompt(events: EpisodicEvent[]): string {
  const list = events
    .slice(-200)
    .map((e) => `${e.at} [${e.kind}]: ${e.summary}`)
    .join('\n');
  return [`Events:`, list, 'Respond with a ValidatedDigest JSON object.'].join('\n');
}

function injectUsage(
  text: string,
  usage: { input_tokens: number; output_tokens: number; cost_usd: number },
): string {
  const trimmed = text.trim();
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    if (!obj.usage) obj.usage = usage;
    return JSON.stringify(obj);
  } catch {
    return trimmed;
  }
}
