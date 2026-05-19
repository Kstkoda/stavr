// v0.6.9 P7 — YAML import/export for the permissions matrix + Layer 0
// capability overrides.
//
// Schema lives at `${STAVR_HOME}/permissions.yaml` (operator-readable
// mirror; the database remains authoritative). Two shapes share the
// file:
//
//   capability_overrides:
//     <tool_id>:
//       state: enabled | disabled-temporary | disabled-permanent
//       disabled_until: <ISO timestamp, present only for temporary>
//       reason: <free text>
//
//   actor_permissions:
//     <actor_id>:
//       <tool_id>: AUTO | CONFIRM | EXPLICIT | NO_GO
//
// Operator workflows:
//   - export: read live state from the stores, write YAML to disk
//   - import: parse YAML, validate, apply via the stores (audit events
//     fire via the standard transport path when called through the
//     daemon; direct calls from the CLI emit explicit events)
//
// The CLI surface (`stavr permissions {export, import, show, set}`)
// wraps these functions; see src/cli.ts.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { join } from 'node:path';
import { z } from 'zod';
import type { ActorPermissionStore } from './actor-permissions.js';
import type {
  CapabilityOverrideStore,
  CapabilityOverrideRow,
} from './capability-overrides.js';
import { stavrHome } from '../config.js';
import { TIERS, type Tier } from '../tools/categories.js';

export const PERMISSIONS_YAML_FILENAME = 'permissions.yaml';

export function defaultPermissionsYamlPath(): string {
  return join(stavrHome(), PERMISSIONS_YAML_FILENAME);
}

// ----- schema -----

const CapabilityYamlSchema = z.object({
  state: z.enum(['enabled', 'disabled-temporary', 'disabled-permanent']),
  disabled_until: z.string().optional(),
  reason: z.string().optional(),
});

const ActorPermissionsYamlSchema = z.record(z.enum(TIERS as readonly Tier[] as [Tier, ...Tier[]]));

const PermissionsYamlSchema = z.object({
  // v0.6.9 P7 — bump when the on-disk format changes meaningfully.
  version: z.number().int().positive().optional(),
  capability_overrides: z.record(CapabilityYamlSchema).optional(),
  actor_permissions: z.record(ActorPermissionsYamlSchema).optional(),
});

export type PermissionsYaml = z.infer<typeof PermissionsYamlSchema>;
export const PERMISSIONS_YAML_VERSION = 1;

// ----- export -----

export interface ExportInput {
  caps: CapabilityOverrideStore;
  perms: ActorPermissionStore;
}

/**
 * Build the YAML-ready document from live store state. Doesn't write
 * to disk — the caller writes (lets tests inspect the structure without
 * touching the filesystem).
 */
export function buildPermissionsYaml(input: ExportInput): PermissionsYaml {
  const capabilityOverrides: PermissionsYaml['capability_overrides'] = {};
  for (const row of input.caps.list()) {
    if (row.state === 'enabled') continue; // skip no-op rows
    capabilityOverrides[row.tool_id] = capabilityRowToYaml(row);
  }
  const actorPermissions: PermissionsYaml['actor_permissions'] = {};
  for (const row of input.perms.list()) {
    if (!actorPermissions[row.actor_id]) actorPermissions[row.actor_id] = {};
    actorPermissions[row.actor_id]![row.tool_id] = row.tier;
  }
  return {
    version: PERMISSIONS_YAML_VERSION,
    ...(Object.keys(capabilityOverrides).length > 0
      ? { capability_overrides: capabilityOverrides }
      : {}),
    ...(Object.keys(actorPermissions).length > 0
      ? { actor_permissions: actorPermissions }
      : {}),
  };
}

function capabilityRowToYaml(row: CapabilityOverrideRow): z.infer<typeof CapabilityYamlSchema> {
  const entry: z.infer<typeof CapabilityYamlSchema> = { state: row.state };
  if (row.disabled_until != null) {
    entry.disabled_until = new Date(row.disabled_until).toISOString();
  }
  if (row.reason) entry.reason = row.reason;
  return entry;
}

/** Serialize the document to YAML text. */
export function permissionsYamlString(doc: PermissionsYaml): string {
  return stringifyYaml(doc, { lineWidth: 100, sortMapEntries: true });
}

/** Write the YAML mirror to `~/.stavr/permissions.yaml` (or override). */
export function writePermissionsYaml(input: ExportInput & { path?: string }): string {
  const doc = buildPermissionsYaml(input);
  const path = input.path ?? defaultPermissionsYamlPath();
  writeFileSync(path, permissionsYamlString(doc), { encoding: 'utf8', mode: 0o600 });
  return path;
}

// ----- import -----

export interface ImportInput {
  caps: CapabilityOverrideStore;
  perms: ActorPermissionStore;
  /** Operator identifier recorded on every write. */
  setBy: string;
  /** Path to read from (defaults to ~/.stavr/permissions.yaml). */
  path?: string;
  /** Pre-parsed YAML text (tests). When set, `path` is ignored. */
  yaml?: string;
}

export interface ImportResult {
  capabilityRowsWritten: number;
  actorRowsWritten: number;
  warnings: string[];
}

/**
 * Apply a YAML document on top of the existing stores.
 *
 * Semantics:
 *   - capability_overrides rows are upserted via disablePermanent /
 *     disableTemporary / enable depending on `state`
 *   - actor_permissions rows are upserted via ActorPermissionStore.set
 *   - Tools / actors / tiers present in the live stores but ABSENT from
 *     the YAML are LEFT UNTOUCHED (additive import). Operators that
 *     want a full replace should DELETE first then import.
 *
 * Throws `Error` with a descriptive message if the YAML fails schema
 * validation (file truncated, wrong types, unknown tier name).
 */
export function importPermissionsYaml(input: ImportInput): ImportResult {
  const path = input.path ?? defaultPermissionsYamlPath();
  let raw: string;
  if (input.yaml !== undefined) {
    raw = input.yaml;
  } else {
    if (!existsSync(path)) {
      throw new Error(`permissions.yaml not found at ${path}`);
    }
    raw = readFileSync(path, 'utf8');
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new Error(`permissions.yaml is not valid YAML: ${(err as Error).message}`);
  }
  const validation = PermissionsYamlSchema.safeParse(parsed ?? {});
  if (!validation.success) {
    throw new Error(`permissions.yaml schema failure: ${validation.error.message}`);
  }
  const doc = validation.data;
  const warnings: string[] = [];
  let capabilityRowsWritten = 0;
  let actorRowsWritten = 0;

  for (const [toolId, cap] of Object.entries(doc.capability_overrides ?? {})) {
    if (cap.state === 'enabled') {
      input.caps.enable(toolId, input.setBy);
    } else if (cap.state === 'disabled-permanent') {
      input.caps.disablePermanent(toolId, { reason: cap.reason, setBy: input.setBy });
    } else if (cap.state === 'disabled-temporary') {
      if (!cap.disabled_until) {
        warnings.push(`tool ${toolId}: disabled-temporary requires disabled_until — skipped`);
        continue;
      }
      const ms = Date.parse(cap.disabled_until);
      if (!Number.isFinite(ms)) {
        warnings.push(`tool ${toolId}: disabled_until not parseable as ISO timestamp — skipped`);
        continue;
      }
      input.caps.disableTemporary(toolId, {
        untilMs: ms,
        reason: cap.reason,
        setBy: input.setBy,
      });
    }
    capabilityRowsWritten++;
  }

  for (const [actorId, toolTiers] of Object.entries(doc.actor_permissions ?? {})) {
    for (const [toolId, tier] of Object.entries(toolTiers)) {
      input.perms.set(actorId, toolId, tier, input.setBy);
      actorRowsWritten++;
    }
  }

  return { capabilityRowsWritten, actorRowsWritten, warnings };
}
