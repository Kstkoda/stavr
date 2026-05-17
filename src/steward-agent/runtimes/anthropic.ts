// v0.5 P2 — AnthropicRuntime.
//
// Wraps the existing src/steward/providers/anthropic.ts streaming generator
// with the three-method ModelRuntime surface + Zod validation + retry. The
// claude-code transport path (Max OAuth) is selectable via the `transport`
// option so users with Max plans stay on it.

import { makeAnthropicProvider, estimateCostUsd } from '../../steward/providers/anthropic.js';
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

export interface AnthropicRuntimeOpts {
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
  apiUrl?: string;
  /** Selects the wire path. 'api' = direct REST; 'claude-code' = subprocess. */
  transport?: 'api' | 'claude-code';
}

export function makeAnthropicRuntime(opts: AnthropicRuntimeOpts): ModelRuntime {
  const provider = makeAnthropicProvider({
    apiKey: opts.apiKey,
    model: opts.model,
    fetchImpl: opts.fetchImpl,
    apiUrl: opts.apiUrl,
  });
  // claude-code transport is wired separately via makeClaudeCodeProvider;
  // P2 keeps the API path as the active runtime — opts.transport reserved
  // for the spawner to flip.
  const model = opts.model ?? 'claude-opus-4-7';

  const runtime: ModelRuntime = {
    name: 'anthropic',
    // Opus 4.7 pricing as of 2026-05.
    costPerKtoken: { in: 15 / 1000, out: 75 / 1000 },
    contextWindow: 1_000_000,
    async plan(ctx: PlanCtx, tools: ToolSpec[]): Promise<ValidatedBOM | ValidationFailure> {
      return runWithRetry({
        runtime: 'anthropic',
        task: 'plan',
        schema: ValidatedBOMZ,
        call: async (attempt, priorError) => {
          const system = sharpenInstruction(planSystemPrompt(), priorError, attempt);
          const userMsg = buildPlanUserPrompt(ctx, tools);
          const { text, usage } = await drainTextAndUsage(provider, {
            systemPrompt: system,
            messages: [{ role: 'user', content: userMsg }],
            tools: [],
            maxTokens: ctx.max_tokens ?? 4000,
            model,
          });
          return injectUsage(text, usage, model);
        },
      });
    },
    async decide(req: DecideReq): Promise<ValidatedChoice | ValidationFailure> {
      return runWithRetry({
        runtime: 'anthropic',
        task: 'decide',
        schema: ValidatedChoiceZ,
        call: async (attempt, priorError) => {
          const system = sharpenInstruction(decideSystemPrompt(), priorError, attempt);
          const userMsg = buildDecideUserPrompt(req);
          const { text, usage } = await drainTextAndUsage(provider, {
            systemPrompt: system,
            messages: [{ role: 'user', content: userMsg }],
            tools: [],
            maxTokens: 1000,
            model,
          });
          return injectUsage(text, usage, model);
        },
      });
    },
    async summarize(events: EpisodicEvent[]): Promise<ValidatedDigest | ValidationFailure> {
      return runWithRetry({
        runtime: 'anthropic',
        task: 'summarize',
        schema: ValidatedDigestZ,
        call: async (attempt, priorError) => {
          const system = sharpenInstruction(summarizeSystemPrompt(), priorError, attempt);
          const userMsg = buildSummarizeUserPrompt(events);
          const { text, usage } = await drainTextAndUsage(provider, {
            systemPrompt: system,
            messages: [{ role: 'user', content: userMsg }],
            tools: [],
            maxTokens: 2000,
            model,
          });
          return injectUsage(text, usage, model);
        },
      });
    },
  };
  return runtime;
}

function buildPlanUserPrompt(ctx: PlanCtx, tools: ToolSpec[]): string {
  const lessons = (ctx.lessons ?? [])
    .slice(0, 20)
    .map((l) => `- [${l.id}] ${l.title}: ${l.body}`)
    .join('\n');
  const wm = ctx.working_memory ? JSON.stringify(ctx.working_memory).slice(0, 2000) : '{}';
  const toolList = tools.map((t) => `- ${t.name}: ${t.description}`).join('\n');
  return [
    `Goal: ${ctx.goal}`,
    `Profile mode: ${ctx.profile_mode}`,
    `Correlation id: ${ctx.correlation_id ?? '(none)'}`,
    '',
    'Working memory:',
    wm,
    '',
    'Active lessons:',
    lessons || '(none)',
    '',
    'Tools available:',
    toolList || '(none)',
    '',
    'Produce a ValidatedBOM JSON object. Include cost_estimate, cost_max, duration_sec_est, risk_envelope, and steps.',
  ].join('\n');
}

function buildDecideUserPrompt(req: DecideReq): string {
  const opts = req.options
    .map((o) => `- id="${o.id}" — ${o.label}${o.rationale ? ` (rationale: ${o.rationale})` : ''}`)
    .join('\n');
  return [
    `Question: ${req.question}`,
    req.context ? `Context: ${req.context}` : '',
    '',
    'Options:',
    opts,
    '',
    'Choose one option id. Respond with the ValidatedChoice JSON object.',
  ]
    .filter(Boolean)
    .join('\n');
}

function buildSummarizeUserPrompt(events: EpisodicEvent[]): string {
  const sampled = events.slice(-200);
  const list = sampled
    .map((e) => `${e.at} [${e.kind}]${e.correlation_id ? ` (${e.correlation_id})` : ''}: ${e.summary}`)
    .join('\n');
  return [
    `Episodic events (${sampled.length} of ${events.length}):`,
    list || '(none)',
    '',
    'Produce a ValidatedDigest JSON object with summary, highlights, recommendations.',
  ].join('\n');
}

/**
 * The drain helper hands us raw text + usage. We need to surface a JSON object
 * to runWithRetry — but the LLM JSON may not include the usage field (we ask
 * it to, but we inject server-side anyway so cost accounting is authoritative).
 * Inject if missing.
 */
function injectUsage(
  text: string,
  usage: { input_tokens: number; output_tokens: number; cost_usd?: number },
  model: string,
): string {
  const trimmed = text.trim();
  // Fast path: if parse fails, hand the raw text back — retry layer will report.
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(stripFence(trimmed)) as Record<string, unknown>;
  } catch {
    return trimmed;
  }
  if (!obj.usage) {
    obj.usage = {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cost_usd: usage.cost_usd ?? estimateCostUsd(model, usage),
    };
  }
  return JSON.stringify(obj);
}

function stripFence(s: string): string {
  const m = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  return m ? m[1].trim() : s;
}
