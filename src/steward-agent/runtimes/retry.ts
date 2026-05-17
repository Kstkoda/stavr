// v0.5 P2 — Retry + schema-validation wrapper shared by all runtimes.
//
// ADR-032 §Decision 5: model output passes a Zod schema. Malformed → retry up
// to 3× with sharpened instruction. After the 3rd failure return a
// ValidationFailure sentinel rather than throwing; calling site surfaces it as
// a Decision card so the loop survives bad LLM output.

import { z } from 'zod';
import { getLogger } from '../../log.js';
import type { TaskKind, ValidationFailure } from './types.js';

export interface RetryAttempt {
  index: number;
  rawOutput: string;
  error?: string;
}

export interface RunWithRetryOpts<T> {
  runtime: string;
  task: TaskKind;
  schema: z.ZodSchema<T>;
  maxAttempts?: number;
  /**
   * Caller-provided callback: given the current attempt index and any prior
   * error text, return the raw model output (string) for that attempt. The
   * wrapper passes the error so the caller can sharpen the system prompt.
   */
  call: (attempt: number, priorError: string | null) => Promise<string>;
}

/**
 * Pull a JSON object out of a model response. LLMs sometimes wrap JSON in
 * ```json ... ``` fences despite instruction; we strip those gracefully.
 * If no parseable JSON found, throws.
 */
export function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('empty model output');
  // Fenced block — extract inner content
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    return JSON.parse(fence[1].trim());
  }
  // Greedy match for outermost { ... }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`no JSON object found in output (length ${trimmed.length})`);
  }
  return JSON.parse(trimmed.slice(start, end + 1));
}

export async function runWithRetry<T>(opts: RunWithRetryOpts<T>): Promise<T | ValidationFailure> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const attempts: RetryAttempt[] = [];
  let priorError: string | null = null;
  let lastRaw = '';

  for (let i = 0; i < maxAttempts; i++) {
    let raw = '';
    try {
      raw = await opts.call(i, priorError);
      lastRaw = raw;
      const obj = extractJson(raw);
      const parsed = opts.schema.parse(obj);
      return parsed;
    } catch (err) {
      const message = (err as Error).message;
      attempts.push({ index: i, rawOutput: raw, error: message });
      priorError = message;
      getLogger().warn('model runtime output failed validation', {
        runtime: opts.runtime,
        task: opts.task,
        attempt: i + 1,
        max: maxAttempts,
        error: message.slice(0, 500),
      });
    }
  }

  const failure: ValidationFailure = {
    __kind: 'validation_failure',
    runtime: opts.runtime,
    task_kind: opts.task,
    last_error: attempts.at(-1)?.error ?? 'unknown',
    attempts: attempts.length,
    raw_last_output: lastRaw.slice(0, 1000),
  };
  return failure;
}

/** Sharpen instruction on retry. */
export function sharpenInstruction(base: string, priorError: string | null, attemptIdx: number): string {
  if (!priorError || attemptIdx === 0) return base;
  return [
    base,
    '',
    `Your previous output failed schema validation: ${priorError.slice(0, 400)}`,
    'Respond with ONLY the JSON object. No prose, no code fences, no explanation.',
    attemptIdx >= 2 ? 'This is your final attempt before the system fails over to manual decision.' : '',
  ]
    .filter(Boolean)
    .join('\n');
}
