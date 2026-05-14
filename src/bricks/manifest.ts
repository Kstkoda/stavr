// src/bricks/manifest.ts
//
// Zod schema for a brick's `stavr-brick.json` manifest. The manifest is what
// turns a folder of code into something the daemon can install. Anything not
// in this schema is ignored.

import { z } from 'zod';

const ConfigFieldKindEnum = z.enum([
  'text',
  'password',
  'url',
  'select',
  'toggle',
  'number',
  'headers',
  'schedule',
  'path',
  'oauth',
  'json',
]);

const CapabilityTagEnum = z.enum([
  'reading',
  'cheap-classifier',
  'code-execution',
  'code-reasoning',
  'long-context',
  'multimodal-vision',
  'multimodal-audio',
  'tool-use-heavy',
  'simple-summary',
  'no-model',
]);

const RiskClassEnum = z.enum([
  'read-only',
  'write-local',
  'write-remote',
  'execute',
  'external-comm',
  'financial',
  'credential',
  'destructive',
]);

const ConfigFieldSchemaZ = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  kind: ConfigFieldKindEnum,
  hint: z.string().optional(),
  options: z
    .array(
      z.object({
        value: z.string(),
        label: z.string(),
      }),
    )
    .optional(),
  required: z.boolean().optional(),
  default: z.unknown().optional(),
  secret: z.boolean().optional(),
});

const ManifestCapabilityZ = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  capability_tag: CapabilityTagEnum,
  risk_class: RiskClassEnum,
  args_schema: z.array(ConfigFieldSchemaZ).default([]),
  enabled: z.boolean().default(true),
});

export const BrickManifestSchema = z.object({
  /** Stable globally-unique id within stavr (e.g., 'webhook-stripe'). */
  id: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9][a-z0-9_.-]*$/, 'id must be lowercase a-z0-9 . _ - and start with alphanumeric'),
  /** Kind groups instances of the same connector type. */
  kind: z.string().min(1).max(120),
  display_name: z.string().min(1).max(120),
  /** Above-the-bus (external) or below (local). */
  position: z.enum(['above', 'below']),
  /** Optional logo asset path relative to the brick's install dir. */
  logo_path: z.string().optional(),
  /** Brick entry point relative to the brick dir. Must end in .js or .mjs. */
  entry: z
    .string()
    .min(1)
    .max(255)
    .refine((p) => p.endsWith('.js') || p.endsWith('.mjs'), 'entry must end in .js or .mjs')
    .refine(
      (p) => !p.includes('..') && !p.startsWith('/') && !p.match(/^[a-zA-Z]:[\\/]/),
      'entry must be a relative path inside the brick',
    ),
  /** Optional config fields rendered by the inspector. */
  config_schema: z.array(ConfigFieldSchemaZ).default([]),
  /** Capabilities exposed to the planner. */
  capabilities: z.array(ManifestCapabilityZ).min(1, 'at least one capability required'),
  /** Optional semver. */
  version: z.string().optional(),
});

export type BrickManifest = z.infer<typeof BrickManifestSchema>;

export interface ParseManifestResult {
  ok: true;
  manifest: BrickManifest;
  raw: string;
}

export interface ParseManifestError {
  ok: false;
  error: string;
}

/**
 * Parse and validate raw JSON. Returns a structured error string on failure
 * (caller turns this into a thrown Error or a tool response, as appropriate).
 */
export function parseBrickManifest(rawJson: string): ParseManifestResult | ParseManifestError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    return { ok: false, error: `manifest is not valid JSON: ${(err as Error).message}` };
  }
  const result = BrickManifestSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n');
    return { ok: false, error: `manifest validation failed:\n${issues}` };
  }
  return { ok: true, manifest: result.data, raw: rawJson };
}
