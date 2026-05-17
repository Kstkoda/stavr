// v0.5 P2 — Runtime barrel + selector.
//
// Reads pinned_runtime + task_runtime_overrides_json from prefs.db and returns
// the right ModelRuntime for the requested task. Centralizes credential lookup
// so the loop in P3 doesn't have to know which env var goes with which runtime.

import type { PrefsStore } from '../db/types.js';
import { PREF_KEYS } from '../db/types.js';
import { makeAnthropicRuntime, type AnthropicRuntimeOpts } from './anthropic.js';
import { makeOpenAIRuntime, type OpenAIRuntimeOpts } from './openai.js';
import { makeOllamaRuntime, type OllamaRuntimeOpts } from './ollama.js';
import type { ModelRuntime, TaskKind, TaskRuntimeOverrides } from './types.js';

export * from './types.js';
export * from './schemas.js';
export { runWithRetry, extractJson, sharpenInstruction } from './retry.js';
export { makeAnthropicRuntime, makeOpenAIRuntime, makeOllamaRuntime };

export type RuntimeName = 'anthropic-opus' | 'anthropic-sonnet' | 'openai-gpt5' | 'ollama' | string;

export interface RuntimeFactoryOpts {
  anthropic?: AnthropicRuntimeOpts;
  openai?: OpenAIRuntimeOpts;
  ollama?: OllamaRuntimeOpts;
}

/**
 * Build a concrete runtime for a registered name. Tests pass a fetchImpl on
 * the corresponding sub-opt; production callers pass api keys from environment.
 */
export function buildRuntime(name: RuntimeName, opts: RuntimeFactoryOpts): ModelRuntime {
  switch (name) {
    case 'anthropic-opus':
      return makeAnthropicRuntime({ ...opts.anthropic, apiKey: opts.anthropic?.apiKey ?? '', model: opts.anthropic?.model ?? 'claude-opus-4-7' });
    case 'anthropic-sonnet':
      return makeAnthropicRuntime({ ...opts.anthropic, apiKey: opts.anthropic?.apiKey ?? '', model: opts.anthropic?.model ?? 'claude-sonnet-4-6' });
    case 'openai-gpt5':
      return makeOpenAIRuntime({ ...opts.openai, apiKey: opts.openai?.apiKey ?? '', model: opts.openai?.model ?? 'gpt-5.5' });
    case 'ollama':
      return makeOllamaRuntime(opts.ollama ?? {});
    default:
      // Names like "anthropic-haiku" or arbitrary tags fall through to anthropic
      // with the literal model name; lets callers experiment without recompile.
      if (name.startsWith('anthropic-')) {
        return makeAnthropicRuntime({
          ...opts.anthropic,
          apiKey: opts.anthropic?.apiKey ?? '',
          model: name.slice('anthropic-'.length),
        });
      }
      if (name.startsWith('ollama:')) {
        return makeOllamaRuntime({ ...opts.ollama, model: name.slice('ollama:'.length) });
      }
      throw new Error(`unknown runtime: ${name}`);
  }
}

/**
 * Reads prefs.pinned_runtime + prefs.task_runtime_overrides_json and returns
 * the runtime to use for a given task kind. Used by the loop in P3 — daily
 * self-critique pins to Ollama for cost reasons via the per-task override.
 */
export function runtimeFor(
  task: TaskKind,
  prefs: PrefsStore,
  buildOpts: RuntimeFactoryOpts,
): ModelRuntime {
  const overrides = (prefs.getOrDefault<TaskRuntimeOverrides>(PREF_KEYS.TASK_RUNTIME_OVERRIDES) ?? {}) as TaskRuntimeOverrides;
  const pinned = prefs.getOrDefault<RuntimeName>(PREF_KEYS.PINNED_RUNTIME);
  const chosen: RuntimeName = overrides[task] ?? pinned;
  return buildRuntime(chosen, buildOpts);
}
