import { randomUUID } from 'node:crypto';
import type { Broker } from '../broker.js';
import type { StewardConfig } from './config.js';
import type {
  StewardEvent,
  StewardMessage,
  StewardProvider,
  StewardToolSpec,
} from './providers/types.js';

/**
 * Spec 49 Layer 1 — daemon-hosted Steward agent loop (in-process variant).
 *
 * Testable, broker-driven. The production deployment spawns this in a forked
 * child and connects via IPC (src/steward/ipc.ts); the in-process variant
 * here lets us unit-test the contract — prompt → thinking → tool calls →
 * response → usage events.
 *
 * The loop subscribes to `steward_prompt` events. For each prompt:
 *   1. Emit `steward_thinking`.
 *   2. Call the provider.
 *   3. For every tool call, invoke via `toolDispatcher` (broker passes through
 *      tier/scope/no-go pipeline). Emit `steward_tool_call`.
 *   4. Emit `steward_usage` with the run's cost.
 *   5. Emit `steward_response` with the assistant's final text.
 *
 * Budget enforcement: every `steward_usage` event accumulates against the
 * configured daily budget. Exceeding it emits `steward_paused_for_budget`
 * and refuses new prompts until the next UTC day OR until `steward_resumed`
 * fires with `override_budget: true`.
 */

export interface LoopDeps {
  broker: Broker;
  provider: StewardProvider;
  config: StewardConfig;
  /** Invoked for each tool call. Returns the result that should go into context. */
  toolDispatcher: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
  /** Used by tests to control "now" for budget rollover. */
  now?: () => Date;
  /** Optional initial usage record (resume across daemon restarts). */
  initialDailySpend?: { day: string; usd: number };
}

export interface RunningLoop {
  handlePrompt: (text: string, source?: 'cli' | 'dashboard' | 'mcp' | 'scheduled') => Promise<{
    correlation_id: string;
    response_text?: string;
    paused?: boolean;
  }>;
  status: () => {
    daily_spend_usd: number;
    paused_for_budget: boolean;
    budget_override_active: boolean;
  };
  resume: (overrideBudget: boolean) => Promise<void>;
  stop: (reason: 'shutdown' | 'crashed' | 'budget_paused') => Promise<void>;
}

export async function startStewardLoop(deps: LoopDeps): Promise<RunningLoop> {
  const { broker, provider, config } = deps;
  const now = deps.now ?? (() => new Date());
  let dailySpend = deps.initialDailySpend ?? { day: dayKey(now()), usd: 0 };
  let pausedForBudget = false;
  let budgetOverride = false;

  await broker.publish({
    kind: 'steward_started',
    at: now().toISOString(),
    source_agent: 'steward',
    payload: {
      provider: provider.name,
      model: provider.defaultModel,
      display_name: config.steward.display_name,
      pid: process.pid,
    },
  });

  function rollDayIfNeeded(): void {
    const today = dayKey(now());
    if (dailySpend.day !== today) {
      dailySpend = { day: today, usd: 0 };
      budgetOverride = false;
      pausedForBudget = false;
    }
  }

  function checkBudget(): boolean {
    rollDayIfNeeded();
    if (budgetOverride) return true;
    if (dailySpend.usd >= config.steward.budget.daily_usd) return false;
    return true;
  }

  async function emit(kind: string, payload: unknown, correlationId?: string): Promise<void> {
    await broker.publish({
      kind: kind as never,
      at: now().toISOString(),
      correlation_id: correlationId,
      source_agent: 'steward',
      payload,
    });
  }

  async function handlePrompt(
    text: string,
    source: 'cli' | 'dashboard' | 'mcp' | 'scheduled' = 'cli',
  ): Promise<{ correlation_id: string; response_text?: string; paused?: boolean }> {
    const correlationId = randomUUID();

    rollDayIfNeeded();
    if (pausedForBudget && !budgetOverride) {
      await emit('steward_response', {
        text:
          'Paused for budget — daily spend has reached the configured cap. Run `cowire steward resume --override-budget` to continue today, or wait until the next UTC day.',
      }, correlationId);
      return { correlation_id: correlationId, paused: true };
    }
    if (!checkBudget()) {
      await pauseForBudget('daily');
      await emit('steward_response', {
        text:
          'Paused for budget — daily spend has reached the configured cap. Run `cowire steward resume --override-budget` to continue today, or wait until the next UTC day.',
      }, correlationId);
      return { correlation_id: correlationId, paused: true };
    }

    await emit('steward_prompt', { text, source }, correlationId);
    await emit('steward_thinking', {}, correlationId);

    const messages: StewardMessage[] = [{ role: 'user', content: text }];
    const tools: StewardToolSpec[] = []; // Filled when registerStewardToolCatalog ships
    const systemPrompt =
      'You are the daemon-hosted Steward. Be concise. When you need a tool, return a tool_use block.';

    let responseText = '';
    for await (const ev of provider.complete({
      systemPrompt,
      messages,
      tools,
      maxTokens: config.steward.max_tokens_per_action,
    })) {
      await handleProviderEvent(ev, correlationId, (extra) => {
        responseText += extra;
      });
    }

    if (responseText) await emit('steward_response', { text: responseText.trim() }, correlationId);
    return { correlation_id: correlationId, response_text: responseText.trim() };
  }

  async function handleProviderEvent(
    ev: StewardEvent,
    correlationId: string,
    appendText: (s: string) => void,
  ): Promise<void> {
    switch (ev.kind) {
      case 'thinking':
        await emit('steward_thinking', { text: ev.text }, correlationId);
        break;
      case 'text':
        appendText(ev.text);
        break;
      case 'tool_call': {
        await emit(
          'steward_tool_call',
          { tool: ev.call.name, args: ev.call.args, call_id: ev.call.id },
          correlationId,
        );
        try {
          await deps.toolDispatcher(ev.call.name, ev.call.args);
        } catch (err) {
          await emit(
            'error',
            {
              message: `tool ${ev.call.name} failed: ${(err as Error).message}`,
              recoverable: true,
            },
            correlationId,
          );
        }
        break;
      }
      case 'usage': {
        const cost = ev.usage.cost_usd ?? 0;
        dailySpend.usd += cost;
        await emit(
          'steward_usage',
          {
            provider: provider.name,
            model: provider.defaultModel,
            input_tokens: ev.usage.input_tokens,
            output_tokens: ev.usage.output_tokens,
            cache_read_tokens: ev.usage.cache_read_tokens,
            cache_creation_tokens: ev.usage.cache_creation_tokens,
            cost_usd: cost,
            credential_id: config.steward.credential_id,
          },
          correlationId,
        );
        if (!budgetOverride && dailySpend.usd >= config.steward.budget.daily_usd) {
          await pauseForBudget('daily');
        }
        break;
      }
      case 'done':
        break;
    }
  }

  async function pauseForBudget(period: 'daily' | 'weekly'): Promise<void> {
    pausedForBudget = true;
    await emit('steward_paused_for_budget', {
      period,
      budget_usd:
        period === 'daily'
          ? config.steward.budget.daily_usd
          : config.steward.budget.weekly_usd,
      spent_usd: dailySpend.usd,
    });
  }

  return {
    handlePrompt,
    status: () => ({
      daily_spend_usd: dailySpend.usd,
      paused_for_budget: pausedForBudget,
      budget_override_active: budgetOverride,
    }),
    async resume(overrideBudget: boolean) {
      budgetOverride = overrideBudget;
      pausedForBudget = false;
      await emit('steward_resumed', { override_budget: overrideBudget });
    },
    async stop(reason) {
      await emit('steward_stopped', { reason });
    },
  };
}

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}
