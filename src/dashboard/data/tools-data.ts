/**
 * Fetcher for the `/dashboard/tools` page.
 *
 * Reads the daemon's `ToolRegistry` and serialises the snapshot into the
 * shape the page renderer consumes. Live invocation counts + top-caller
 * breakdowns are intentionally NOT computed here yet — they need the
 * `tool_invoked` event kind which lands in v0.6.9 PR #2 alongside the
 * Layer 0 + per-actor authorisation gate. Until then the page renders
 * usage cells as "—" with a banner explaining what's coming next.
 *
 * The fetcher is pure — it accepts a registry instance, never reaches into
 * the broker directly, so tests can construct a `ToolRegistry`, populate
 * it, and assert on the output without spinning up an MCP session.
 */

import type { ToolRegistry } from '../../tools/registry.js';
import type { Tier, ToolCategory } from '../../tools/categories.js';

export interface ToolRow {
  id: string;
  category: ToolCategory;
  description: string;
  defaultTier: Tier;
  reversibility: 'reversible' | 'irreversible';
  /** Subsystem hint recorded at registration time. */
  registered_by: string;
  /**
   * Last-24h invocation count. `null` indicates "tracking not yet wired"
   * (will surface a "—" cell in the UI). Once PR #2 lands the
   * `tool_invoked` event kind, this will hold the real count.
   */
  callsLast24h: number | null;
}

export interface ToolsByCategory {
  category: ToolCategory;
  count: number;
}

export interface ToolsData {
  /** Total registered tools. */
  registeredCount: number;
  /** Distinct categories present in the registry. */
  categoriesPresent: ToolCategory[];
  /** Per-category counts for the header / filter chip rendering. */
  byCategory: ToolsByCategory[];
  /** Flat tool list sorted by id. */
  tools: ToolRow[];
  /** True when live invocation counts are wired (false until PR #2). */
  invocationTrackingEnabled: boolean;
}

/**
 * Build a `ToolsData` snapshot from a `ToolRegistry`. Pure function — no
 * I/O, no broker access. Tests construct a registry, feed it tools, and
 * assert on the output.
 */
export function fetchToolsData(registry: ToolRegistry): ToolsData {
  const tools = registry.all();
  const tally = new Map<ToolCategory, number>();
  for (const t of tools) {
    tally.set(t.category, (tally.get(t.category) ?? 0) + 1);
  }
  // Sorted by id (registry.all() already sorts); we re-shape to ToolRow.
  const toolRows: ToolRow[] = tools.map((m) => ({
    id: m.id,
    category: m.category,
    description: m.description,
    defaultTier: m.defaultTier,
    reversibility: m.reversibility,
    registered_by: m.registered_by,
    // Tracking lands in PR #2; until then surface `null` so the renderer
    // can show a "—" cell + an explanatory banner.
    callsLast24h: null,
  }));
  const byCategory: ToolsByCategory[] = Array.from(tally.entries())
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => a.category.localeCompare(b.category));
  return {
    registeredCount: tools.length,
    categoriesPresent: registry.categories(),
    byCategory,
    tools: toolRows,
    invocationTrackingEnabled: false,
  };
}

/**
 * Empty snapshot — used by the dashboard renderer when no broker is wired
 * yet (e.g., tests that exercise the page shell without a daemon).
 */
export function emptyToolsData(): ToolsData {
  return {
    registeredCount: 0,
    categoriesPresent: [],
    byCategory: [],
    tools: [],
    invocationTrackingEnabled: false,
  };
}
