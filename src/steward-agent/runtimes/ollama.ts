// v0.5 P2 — OllamaRuntime.
//
// Wraps src/steward/providers/ollama.ts. For models with native function
// calling (llama3.2+, mistral-nemo, …), schema validation usually passes on
// first attempt. For models without (older quantized GGUFs), JSON-mode + the
// retry/sharpen loop carries the load — third-attempt prompt explicitly lists
// the field names and types.

import { makeOllamaProvider } from '../../steward/providers/ollama.js';
import { drainTextAndUsage } from './_drain.js';
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

export interface OllamaRuntimeOpts {
  host?: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export function makeOllamaRuntime(opts: OllamaRuntimeOpts = {}): ModelRuntime {
  const provider = makeOllamaProvider(opts);
  const model = opts.model ?? 'llama3.2:3b';

  async function call(systemPrompt: string, userMsg: string, maxTokens: number): Promise<string> {
    const { text, usage } = await drainTextAndUsage(provider, {
      systemPrompt,
      messages: [{ role: 'user', content: userMsg }],
      tools: [],
      maxTokens,
      model,
    });
    return injectUsage(text, usage);
  }

  return {
    name: 'ollama',
    // Local inference — no per-token cost.
    costPerKtoken: { in: 0, out: 0 },
    contextWindow: 32_000,
    async plan(ctx, tools): Promise<ValidatedBOM | ValidationFailure> {
      return runWithRetry({
        runtime: 'ollama',
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
        runtime: 'ollama',
        task: 'decide',
        schema: ValidatedChoiceZ,
        call: (attempt, priorError) =>
          call(sharpenInstruction(decideSystemPrompt(), priorError, attempt), buildDecideUserPrompt(req), 1000),
      });
    },
    async summarize(events): Promise<ValidatedDigest | ValidationFailure> {
      return runWithRetry({
        runtime: 'ollama',
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
  const lessons = (ctx.lessons ?? []).slice(0, 10).map((l) => `- ${l.title}: ${l.body}`).join('\n');
  return [
    `Goal: ${ctx.goal}`,
    `Profile mode: ${ctx.profile_mode}`,
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
    .slice(-100)
    .map((e) => `${e.at} [${e.kind}]: ${e.summary}`)
    .join('\n');
  return [`Events:`, list, 'Respond with a ValidatedDigest JSON object.'].join('\n');
}

function injectUsage(
  text: string,
  usage: { input_tokens: number; output_tokens: number; cost_usd?: number },
): string {
  const trimmed = text.trim();
  try {
    const stripped = stripFence(trimmed);
    const obj = JSON.parse(stripped) as Record<string, unknown>;
    if (!obj.usage) {
      obj.usage = {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cost_usd: 0,
      };
    }
    return JSON.stringify(obj);
  } catch {
    return trimmed;
  }
}

function stripFence(s: string): string {
  const m = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  return m ? m[1].trim() : s;
}
