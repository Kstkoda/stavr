/**
 * Central tool catalog — the single source of truth for "which MCP tools
 * has stavR registered, and what is each one's category / tier / risk?"
 *
 * The registry is populated automatically when `wrapServerForRegistry` wraps
 * an McpServer instance: every `server.registerTool(name, config, handler)`
 * call records a `ToolMetadata` row before delegating to the original
 * registration. The MCP tool-registration mechanism is unchanged (CLAUDE.md
 * BOM hard rule — "extend metadata, don't change how registration works"),
 * so subsystem authors continue to write `server.registerTool(...)` exactly
 * as before; the registry is a passive observer.
 *
 * Storage is in-process per Broker (the broker is the natural daemon-scope
 * boundary). The dashboard's `/dashboard/tools` page reads the registry to
 * render the catalog; the PR #2 authorisation gate reads it to look up
 * default tiers when no actor-specific override exists.
 *
 * What the registry intentionally does NOT do:
 * - Persist to disk — the registration set is rebuilt from code on every
 *   daemon boot, so disk persistence would just risk staleness. The
 *   per-actor overrides (PR #2) WILL persist; those are operator-set, not
 *   code-derived.
 * - Track invocation counts — that's the events table's job (PR #2 adds
 *   the `tool_invoked` event kind + 24h count fetcher).
 * - Provide the runtime gate — Layer 0 disables + per-actor checks come
 *   in PR #2 (`src/security/capability-overrides.ts` +
 *   `actor-permissions.ts`).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  categorize,
  defaultTierFor,
  reversibilityFor,
  type Tier,
  type ToolCategory,
} from './categories.js';

/**
 * Metadata recorded for every tool stavR exposes. Mirrors the BOM's design
 * shape (`v0_6_9-tool-catalog-and-permissions-bom.md` P1) plus a few
 * implementation-side conveniences (`registered_at` for ordering;
 * `registered_by` for debug attribution; `paramsSchema` left optional
 * because the MCP SDK's runtime shape varies).
 */
export interface ToolMetadata {
  /** Stable wire-level id used by MCP clients (e.g., `worker_spawn`). */
  id: string;
  /** Broad bucket for the dashboard catalog + permissions matrix. */
  category: ToolCategory;
  /** Pulled from the tool's MCP `description` field at registration time. */
  description: string;
  /** Baseline tier per the 4-tier model — overridable per-actor in PR #2. */
  defaultTier: Tier;
  /** Whether a successful call leaves the world recoverable without operator help. */
  reversibility: 'reversible' | 'irreversible';
  /** Raw inputSchema as supplied by the registration site. */
  paramsSchema?: unknown;
  /** ISO timestamp recorded when the tool was first seen. */
  registered_at: string;
  /** Free-form attribution hint (e.g., `'server.ts'`, `'workers/tools.ts'`). */
  registered_by: string;
}

/**
 * In-memory tool catalog. Reads return defensive copies so callers can't
 * accidentally mutate stored metadata. The registry is meant to be
 * append-only at runtime — re-registration with the same id is treated as
 * idempotent (keeps the first observation; logs nothing because cross-
 * session re-registrations are the common case).
 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolMetadata>();

  /**
   * Record a tool. Idempotent in id — first registration wins. Returns
   * the metadata that ended up in the registry (which may be the
   * first-registered copy, not the one this call passed in).
   */
  record(meta: ToolMetadata): ToolMetadata {
    const existing = this.tools.get(meta.id);
    if (existing) return existing;
    this.tools.set(meta.id, meta);
    return meta;
  }

  /** Look up by id. Returns undefined if not registered. */
  get(id: string): ToolMetadata | undefined {
    const found = this.tools.get(id);
    return found ? { ...found } : undefined;
  }

  /** All tools, sorted by id for stable rendering. */
  all(): ToolMetadata[] {
    return Array.from(this.tools.values())
      .map((m) => ({ ...m }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** All tools matching `category`, sorted by id. */
  byCategory(category: ToolCategory): ToolMetadata[] {
    return this.all().filter((m) => m.category === category);
  }

  /** Total count — used by the page header ("Tools · N registered"). */
  size(): number {
    return this.tools.size;
  }

  /** Distinct category list seen in the registry, ordered. */
  categories(): ToolCategory[] {
    const set = new Set<ToolCategory>();
    for (const m of this.tools.values()) set.add(m.category);
    return Array.from(set).sort();
  }
}

/**
 * Build a ToolMetadata from a registration call. Pulls the description out
 * of the config (MCP `description` field) and derives category / tier /
 * reversibility via the heuristics in `./categories.ts`.
 */
export function buildMetadata(
  id: string,
  config: { description?: string; inputSchema?: unknown },
  registered_by: string,
): ToolMetadata {
  return {
    id,
    category: categorize(id),
    description: config.description ?? '',
    defaultTier: defaultTierFor(id),
    reversibility: reversibilityFor(id),
    paramsSchema: config.inputSchema,
    registered_at: new Date().toISOString(),
    registered_by,
  };
}

/**
 * Wrap an `McpServer` so every subsequent `registerTool` call records into
 * the supplied registry before delegating to the SDK's original method.
 * The MCP SDK exposes a single registration entry point and the schema is
 * intentionally loose (description optional, inputSchema unknown), so we
 * stay duck-typed and trust the SDK's runtime validation.
 *
 * Idempotent — calling twice on the same server is a no-op for the second
 * call (we tag the patched method so the wrapper recognises itself).
 */
const PATCH_TAG = Symbol.for('stavr.toolRegistry.patched');

export function wrapServerForRegistry(
  server: McpServer,
  registry: ToolRegistry,
  registered_by = 'server',
): void {
  const proto = server as unknown as {
    registerTool: (name: string, config: { description?: string; inputSchema?: unknown }, handler: unknown) => unknown;
  };
  const existing = proto.registerTool as unknown as {
    [PATCH_TAG]?: boolean;
    bind: (thisArg: unknown) => typeof proto.registerTool;
  };
  if (existing[PATCH_TAG]) return;
  const original = existing.bind(server);
  const wrapped = function (
    name: string,
    config: { description?: string; inputSchema?: unknown },
    handler: unknown,
  ): unknown {
    registry.record(buildMetadata(name, config, registered_by));
    return original(name, config, handler);
  } as typeof proto.registerTool & { [PATCH_TAG]?: boolean };
  wrapped[PATCH_TAG] = true;
  proto.registerTool = wrapped;
}
