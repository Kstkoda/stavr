import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * Spec 49 Layer 1 — daemon-hosted Steward configuration.
 *
 * Loaded from `~/.cowire/steward-config.yaml` (or .yml / .json) at daemon
 * boot. If the file is absent OR `steward.enabled: false`, the daemon does
 * not spawn the Steward subprocess — keeps current users unaffected.
 *
 * We intentionally don't pull in a YAML dependency (no js-yaml in the tree).
 * The parser supports JSON unconditionally and a minimal YAML subset
 * (key:value pairs, nested two-space indent, strings, numbers, booleans).
 * Users with complex configs can write JSON instead — the schema is the same.
 */

export const StewardConfigZ = z.object({
  steward: z.object({
    enabled: z.boolean().default(false),
    display_name: z.string().min(1).default('Co'),
    provider: z.enum(['anthropic', 'claude-code']).default('anthropic'),
    model: z.string().min(1).default('claude-opus-4-7'),
    credential_id: z.string().optional(),
    max_tokens_per_action: z.number().int().positive().default(4000),
    budget: z
      .object({
        daily_usd: z.number().nonnegative().default(10),
        weekly_usd: z.number().nonnegative().default(50),
      })
      .default({ daily_usd: 10, weekly_usd: 50 }),
    system_prompt_path: z.string().optional(),
    memory_path: z.string().default(join(homedir(), '.cowire', 'steward-memory')),
    trust_scope: z
      .object({
        auto_grant_basics: z.boolean().default(true),
      })
      .default({ auto_grant_basics: true }),
  }),
});

export type StewardConfig = z.infer<typeof StewardConfigZ>;

export const DEFAULT_CONFIG_PATHS = [
  join(homedir(), '.cowire', 'steward-config.yaml'),
  join(homedir(), '.cowire', 'steward-config.yml'),
  join(homedir(), '.cowire', 'steward-config.json'),
];

export interface LoadConfigResult {
  path?: string;
  config?: StewardConfig;
  /** Set when a file exists but failed Zod validation. */
  error?: string;
}

export function loadStewardConfig(candidates: string[] = DEFAULT_CONFIG_PATHS): LoadConfigResult {
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const raw = readFileSync(path, 'utf8');
      const parsed = path.endsWith('.json') ? JSON.parse(raw) : parseMiniYaml(raw);
      const config = StewardConfigZ.parse(parsed);
      return { path, config };
    } catch (err) {
      return { path, error: (err as Error).message };
    }
  }
  return {};
}

/**
 * Minimal YAML parser — accepts two-space indented nested key:value pairs.
 * Strings can be quoted or bare. Numbers, booleans, and nulls auto-coerce.
 * Lists are not supported — anything beyond simple structured config should
 * use the JSON variant.
 */
export function parseMiniYaml(input: string): Record<string, unknown> {
  const lines = input
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l, i) => ({ raw: l, idx: i }))
    .filter(({ raw }) => raw.trim().length > 0 && !raw.trim().startsWith('#'));

  interface Frame {
    indent: number;
    obj: Record<string, unknown>;
  }
  const root: Record<string, unknown> = {};
  const stack: Frame[] = [{ indent: -1, obj: root }];

  for (const { raw, idx } of lines) {
    const indent = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx < 0) {
      throw new Error(`yaml line ${idx + 1}: expected 'key: value', got "${trimmed}"`);
    }
    const key = trimmed.slice(0, colonIdx).trim();
    const rest = trimmed.slice(colonIdx + 1).trim();

    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1];
    if (rest === '') {
      const child: Record<string, unknown> = {};
      parent.obj[key] = child;
      stack.push({ indent, obj: child });
    } else {
      parent.obj[key] = coerceScalar(rest);
    }
  }
  return root;
}

function coerceScalar(s: string): unknown {
  // Strip optional quotes.
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}
