/**
 * Fetcher for the `/dashboard/permissions` page (v0.6.9 PR #2).
 *
 * Pulls the catalog from `ToolRegistry` and joins it with operator-set
 * Layer 0 disables (`CapabilityOverrideStore`) and per-actor tier
 * overrides (`ActorPermissionStore`) to produce the matrix shape the
 * page renders.
 *
 * Topology overlay (BOM P5) is intentionally deferred to PR #3 — the
 * existing topology page is too dense to retrofit a side-drawer cleanly
 * tonight; a standalone `/dashboard/permissions` page delivers the same
 * operator-controllable surface with less integration risk. Topology
 * gets a link to this page (and the future v0.7 topology overlay can
 * replace the page if/when the operator prefers the drawer form).
 */

import type { ActorPermissionStore } from '../../security/actor-permissions.js';
import type { CapabilityOverrideStore, CapabilityOverrideRow } from '../../security/capability-overrides.js';
import type { ToolRegistry } from '../../tools/registry.js';
import { KNOWN_ACTORS, type KnownActor } from '../../security/actor-permissions.js';
import {
  defaultTierFor,
  type Tier,
  type ToolCategory,
} from '../../tools/categories.js';

export interface PermissionsToolSummary {
  id: string;
  category: ToolCategory;
  description: string;
  defaultTier: Tier;
  /** Layer 0 status — `null` when no override row exists (fully enabled). */
  layer0: CapabilityOverrideRow | null;
  /** Whether Layer 0 currently blocks the tool. */
  disabledNow: boolean;
}

export interface PermissionsMatrixCell {
  actor: string;
  tool: string;
  /** Effective tier (matrix-set if present, else registered default). */
  tier: Tier;
  /** Whether the tier came from a matrix row or the registered default. */
  source: 'default' | 'matrix';
}

export interface PermissionsData {
  /** Tool catalog snapshot, sorted by id. */
  tools: PermissionsToolSummary[];
  /** Actor ids present in the matrix UI (known + discovered). */
  actors: string[];
  /** Effective tier for every (actor, tool) pair the UI renders. */
  matrix: PermissionsMatrixCell[];
  /** Currently-active Layer 0 disables (for the header pill). */
  disabledCount: number;
  /** Total registered tool count. */
  toolCount: number;
  /** Whether the YAML mirror has been written (PR #3 feature; false today). */
  yamlMirrorEnabled: boolean;
}

/**
 * Build the page snapshot. Pure — accepts stores + registry as
 * parameters so tests construct them in-memory.
 */
export function fetchPermissionsData(opts: {
  registry: ToolRegistry;
  caps: CapabilityOverrideStore;
  perms: ActorPermissionStore;
  now?: number;
}): PermissionsData {
  const now = opts.now ?? Date.now();
  const tools = opts.registry.all().map<PermissionsToolSummary>((m) => {
    const layer0 = opts.caps.get(m.id) ?? null;
    const disabledNow = !opts.caps.check(m.id, now).allowed;
    return {
      id: m.id,
      category: m.category,
      description: m.description,
      defaultTier: m.defaultTier,
      layer0,
      disabledNow,
    };
  });
  // Actor list = known actors + any others discovered in the matrix
  const discovered = new Set<string>(opts.perms.actors());
  const actors = Array.from(new Set<string>([
    ...(KNOWN_ACTORS as readonly KnownActor[]),
    ...Array.from(discovered),
  ]));
  const matrix: PermissionsMatrixCell[] = [];
  for (const actor of actors) {
    for (const t of tools) {
      const row = opts.perms.get(actor, t.id);
      matrix.push({
        actor,
        tool: t.id,
        tier: row?.tier ?? defaultTierFor(t.id),
        source: row ? 'matrix' : 'default',
      });
    }
  }
  return {
    tools,
    actors,
    matrix,
    disabledCount: opts.caps.activeDisabledCount(now),
    toolCount: tools.length,
    yamlMirrorEnabled: false,
  };
}

export function emptyPermissionsData(): PermissionsData {
  return {
    tools: [],
    actors: [...(KNOWN_ACTORS as readonly KnownActor[])],
    matrix: [],
    disabledCount: 0,
    toolCount: 0,
    yamlMirrorEnabled: false,
  };
}
