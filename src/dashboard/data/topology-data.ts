/**
 * src/dashboard/data/topology-data.ts
 *
 * Fetcher for the additional node families that the Topology page renders
 * around the daemon core but that aren't carried by the legacy
 * `{ workers, bricks, scopes, inFlightBoms }` snapshot:
 *
 *   - **mcpCategoryNodes** — one virtual MCP-local node per category of
 *     tools registered in the in-process `ToolRegistry`. Lets the operator
 *     see stavR's own tool surfaces (worker_*, github_*, steward_*) on the
 *     constellation even before any external brick is installed.
 *   - **peers** — federation peers read from `${STAVR_HOME}/peers.yaml`.
 *     Each entry becomes a `t-peer` cyan node orbiting outside the local
 *     cluster. File is optional; missing or unreadable file ⇒ empty list.
 *   - **eventDensity** — Task 3 heatmap timeline buckets. ~50–100 buckets
 *     per fetch covering a recent rolling window; thickness ∝ sqrt(count).
 *
 * Pure function shape — the fetcher receives the registry / store / path
 * handles it needs and returns a plain data snapshot, so the page renderer
 * and unit tests both consume the same surface.
 *
 * Phase C #1 / v0.6.10 dispatch.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import type { ToolRegistry } from '../../tools/registry.js';
import type { ToolCategory } from '../../tools/categories.js';
import type { EventStore, StoredEvent } from '../../persistence.js';
import { stavrHome } from '../../config.js';

export const PEERS_YAML_FILENAME = 'peers.yaml';

/**
 * Lightweight peer record consumed by the Topology renderer. Mirrors the
 * shape the v0.7 federation work will write — keeping it stable now means
 * the page doesn't have to be reshaped when the real peers feature lands.
 */
export interface PeerEntryLite {
  id: string;
  display_name: string;
  endpoint?: string;
  /** Halo color per CLAUDE.md §5 — peer-local status, not type. */
  status: 'ok' | 'warn' | 'crit' | 'unknown';
  /** Optional human role hint shown in node label (e.g., "child · twin-A"). */
  role?: string;
}

/**
 * Virtual MCP node, one per category present in the tool registry. The
 * count surfaces in the inspector + node label so an operator can tell at
 * a glance which categories are well-populated.
 */
export interface McpCategoryNodeLite {
  id: string;           // 'mcp-cat-<category>'
  category: ToolCategory;
  display_name: string; // human-readable category label
  tool_count: number;
  /**
   * Origin of the node. 'registry' = derived from in-process registrations;
   * 'brick' = backed by an installed brick (reserved for future federation
   * of external MCPs). Today everything is 'registry'.
   */
  source: 'registry' | 'brick';
}

/**
 * One bucket in the heatmap timeline. `at` is the bucket-start ISO; `count`
 * is the number of events that landed inside it. `kinds` is a compact
 * breakdown used by the hover tooltip (capped at 6 distinct kinds; the
 * `other` aggregate captures everything beyond that to keep the payload
 * bounded).
 */
export interface EventDensityBucket {
  at: string;
  count: number;
  kinds: Record<string, number>;
}

export interface EventDensitySnapshot {
  /** Bucket width in ms. 60_000 default (1-minute zoom). */
  bucketMs: number;
  /** Snapshot start (oldest bucket's `at`). */
  from: string;
  /** Snapshot end (newest bucket's `at` + bucketMs). */
  to: string;
  buckets: EventDensityBucket[];
  /** Highest `count` across the snapshot — used by the renderer to scale. */
  peak: number;
}

export interface TopologyExtras {
  mcpCategoryNodes: McpCategoryNodeLite[];
  peers: PeerEntryLite[];
  eventDensity: EventDensitySnapshot;
}

// ---------------- peers.yaml ----------------

const PeerYamlSchema = z.object({
  id: z.string().min(1),
  display_name: z.string().optional(),
  endpoint: z.string().optional(),
  status: z.enum(['ok', 'warn', 'crit', 'unknown']).optional(),
  role: z.string().optional(),
});

const PeersYamlSchema = z.object({
  peers: z.array(PeerYamlSchema).optional(),
});

export function defaultPeersYamlPath(): string {
  return join(stavrHome(), PEERS_YAML_FILENAME);
}

/**
 * Read federation peers from disk. Returns an empty list on any failure
 * (missing file, parse error, schema mismatch). The daemon must never
 * crash because peers.yaml is malformed — operators may still be editing
 * it.
 */
export function fetchPeers(path?: string): PeerEntryLite[] {
  const target = path ?? defaultPeersYamlPath();
  if (!existsSync(target)) return [];
  let raw: string;
  try {
    raw = readFileSync(target, 'utf8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch {
    return [];
  }
  const result = PeersYamlSchema.safeParse(parsed);
  if (!result.success) return [];
  const peers = result.data.peers ?? [];
  return peers.map((p) => ({
    id: p.id,
    display_name: p.display_name ?? p.id,
    endpoint: p.endpoint,
    status: p.status ?? 'unknown',
    role: p.role,
  }));
}

// ---------------- MCP category nodes ----------------

const CATEGORY_LABELS: Record<ToolCategory, string> = {
  worker: 'Workers',
  scope: 'Trust scopes',
  github: 'GitHub',
  steward: 'Steward',
  credentials: 'Credentials',
  subscription: 'Subscriptions',
  event: 'Events',
  decision: 'Decisions',
  shell: 'Shell',
  plan: 'Planning',
  other: 'Other',
};

/**
 * Group tools by category and emit one virtual MCP-local node per group.
 * Categories with zero registrations are omitted — only show what stavR
 * actually exposes right now.
 */
export function fetchMcpCategoryNodes(registry: ToolRegistry): McpCategoryNodeLite[] {
  const tally = new Map<ToolCategory, number>();
  for (const t of registry.all()) {
    tally.set(t.category, (tally.get(t.category) ?? 0) + 1);
  }
  const out: McpCategoryNodeLite[] = [];
  for (const [category, tool_count] of tally) {
    out.push({
      id: `mcp-cat-${category}`,
      category,
      display_name: CATEGORY_LABELS[category] ?? category,
      tool_count,
      source: 'registry',
    });
  }
  // Stable order — alphabetical by category id for deterministic rendering.
  out.sort((a, b) => a.category.localeCompare(b.category));
  return out;
}

// ---------------- event density (heatmap) ----------------

/**
 * Aggregate events into time buckets for the heatmap timeline. Default
 * window 60 minutes, bucket width 1 minute → 60 buckets. Pure function
 * over an event list so the caller controls both the lookback and the
 * bucket granularity.
 *
 * `kinds` is capped at top-6 by count; everything beyond rolls into
 * `other` so the payload doesn't explode when the daemon is bursty.
 */
export function bucketEventDensity(
  events: readonly StoredEvent[],
  opts: { now?: number; bucketMs?: number; bucketCount?: number } = {},
): EventDensitySnapshot {
  const now = opts.now ?? Date.now();
  const bucketMs = opts.bucketMs ?? 60_000;
  const bucketCount = Math.max(1, opts.bucketCount ?? 60);
  // Align `to` to bucket boundary so consecutive fetches don't produce
  // half-overlapping buckets.
  const to = Math.floor(now / bucketMs) * bucketMs + bucketMs;
  const from = to - bucketCount * bucketMs;

  // counts[i] = count for bucket i; kindCounts[i] = per-kind tally.
  const counts = new Array<number>(bucketCount).fill(0);
  const kindCounts: Array<Map<string, number>> = Array.from(
    { length: bucketCount },
    () => new Map<string, number>(),
  );

  for (const ev of events) {
    const at = Date.parse(ev.at);
    if (!Number.isFinite(at)) continue;
    if (at < from || at >= to) continue;
    const idx = Math.floor((at - from) / bucketMs);
    if (idx < 0 || idx >= bucketCount) continue;
    counts[idx] += 1;
    const kindMap = kindCounts[idx];
    const kind = String(ev.kind || 'unknown');
    kindMap.set(kind, (kindMap.get(kind) ?? 0) + 1);
  }

  const buckets: EventDensityBucket[] = [];
  let peak = 0;
  for (let i = 0; i < bucketCount; i++) {
    const bucketAt = new Date(from + i * bucketMs).toISOString();
    const count = counts[i];
    if (count > peak) peak = count;
    const kinds = condenseKinds(kindCounts[i]);
    buckets.push({ at: bucketAt, count, kinds });
  }
  return {
    bucketMs,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    buckets,
    peak,
  };
}

function condenseKinds(src: Map<string, number>): Record<string, number> {
  const entries = Array.from(src.entries()).sort((a, b) => b[1] - a[1]);
  const out: Record<string, number> = {};
  const TOP = 6;
  let otherSum = 0;
  entries.forEach(([kind, n], i) => {
    if (i < TOP) out[kind] = n;
    else otherSum += n;
  });
  if (otherSum > 0) out.other = otherSum;
  return out;
}

// ---------------- bundle ----------------

export interface FetchTopologyExtrasInput {
  registry: ToolRegistry;
  store: EventStore;
  /** Override for peers.yaml path (defaults to ${STAVR_HOME}/peers.yaml). */
  peersYamlPath?: string;
  /** Clock override for the density buckets. */
  now?: number;
  bucketMs?: number;
  bucketCount?: number;
}

export function fetchTopologyExtras(input: FetchTopologyExtrasInput): TopologyExtras {
  const mcpCategoryNodes = fetchMcpCategoryNodes(input.registry);
  const peers = fetchPeers(input.peersYamlPath);
  const bucketMs = input.bucketMs ?? 60_000;
  const bucketCount = input.bucketCount ?? 60;
  // Bound the event pull to the bucket window — no point paging older
  // events the heatmap will never plot.
  const limit = bucketCount * 200; // generous; daemon caps the SQL fetch.
  let events: StoredEvent[] = [];
  try {
    events = input.store.getEvents({ limit }).events;
  } catch {
    events = [];
  }
  const eventDensity = bucketEventDensity(events, {
    now: input.now,
    bucketMs,
    bucketCount,
  });
  return { mcpCategoryNodes, peers, eventDensity };
}
