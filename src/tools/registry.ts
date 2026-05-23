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
 * Optional `gate` parameter (v0.6.9 PR #2) wraps the supplied tool
 * handler with a Layer 0 capability check — every call hits the gate
 * BEFORE the user-supplied handler runs. When the gate denies, the
 * handler returns an MCP toolError without touching the original
 * handler, so Layer 0 disables apply instantly to every subsystem
 * without each subsystem needing to call the gate explicitly.
 *
 * Idempotent — calling twice on the same server is a no-op for the
 * second call (we tag the patched method so the wrapper recognises
 * itself).
 */
const PATCH_TAG = Symbol.for('stavr.toolRegistry.patched');

/** Pluggable gate used by `wrapServerForRegistry` to decide whether to run a handler. */
export interface RuntimeToolGate {
  /**
   * Called BEFORE the tool's handler runs. Resolve `{ allowed: true }` to
   * delegate; `{ allowed: false, reason }` to short-circuit with a
   * `toolError`. Errors thrown / rejections from the gate are surfaced as
   * `toolError` too — never propagated to the SDK (which would 500 the MCP
   * session).
   *
   * Async signature (v0.7+) because the per-actor tier path may open an
   * `await_decision` and block on operator response before resolving.
   */
  check(toolId: string, args: unknown): Promise<{ allowed: boolean; reason?: string }>;
}

export function wrapServerForRegistry(
  server: McpServer,
  registry: ToolRegistry,
  registered_by = 'server',
  gate?: RuntimeToolGate,
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
    const finalHandler = gate
      ? wrapHandlerWithGate(name, handler, gate)
      : handler;
    return original(name, config, finalHandler);
  } as typeof proto.registerTool & { [PATCH_TAG]?: boolean };
  wrapped[PATCH_TAG] = true;
  proto.registerTool = wrapped;
}

/**
 * Wrap a tool handler so its invocation goes through `gate.check` first.
 * The gate returns `{ allowed: true }` to delegate to the original
 * handler, or `{ allowed: false, reason }` to short-circuit with an MCP
 * `toolError` — the standard "deny" shape used by other subsystems.
 *
 * Exported for unit tests; production callers should use
 * `wrapServerForRegistry({ ..., gate })`.
 */
export function wrapHandlerWithGate(
  toolId: string,
  handler: unknown,
  gate: RuntimeToolGate,
): unknown {
  const inner = handler as (...args: unknown[]) => Promise<unknown>;
  return async function (...args: unknown[]): Promise<unknown> {
    let decision: { allowed: boolean; reason?: string };
    try {
      decision = await gate.check(toolId, args[0]);
    } catch (err) {
      decision = { allowed: false, reason: `gate error: ${(err as Error).message}` };
    }
    if (!decision.allowed) {
      const reason = decision.reason ?? `tool ${toolId} denied by runtime gate`;
      return {
        isError: true,
        content: [{ type: 'text', text: reason }],
      };
    }
    return inner(...args);
  };
}
