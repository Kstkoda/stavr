/**
 * src/dashboard/widgets/topology-actor-nodes.ts
 *
 * v0.6.10 Task 4a — Decision 4 instruction-flow visualization, layer 1.
 *
 * Operator, CC, Cowork-Claude, and remote stavR peers appear on the
 * topology constellation as **first-class actor-nodes**, distinct from
 * stavR-internal nodes (MCPs, workers, DB). When an operator types in
 * Cowork the "operator (cowork)" actor lights up; when a remote peer
 * sends instructions the "peer-<name>" actor lights up.
 *
 * Sources of truth (fetcher composes these):
 *   - `source_agent` strings observed in the recent event stream — every
 *     event has one (see src/event-types.ts:888). Unique values from a
 *     rolling window (default 24h) feed the dynamic actor set.
 *   - peers.yaml — already-known federation peer identities so they
 *     show up even when no recent event references them.
 *
 * Color palette (see src/dashboard/tokens.ts → --actor-*):
 *   - operator     → rust    (var(--actor-operator))
 *   - cc           → blue    (var(--actor-cc))
 *   - cowork       → teal    (var(--actor-cowork))
 *   - peer         → cyan    (var(--actor-peer))
 *   - default      → neutral (var(--actor-default))  — fallback for
 *                                                       unrecognised
 *                                                       source_agent
 *                                                       prefixes
 *
 * Halo / status comes from per-actor recent-activity heuristics:
 *   - last event within 60s              → ok
 *   - last event within 5 minutes        → warn (idle but recent)
 *   - older                              → crit (gone-quiet flag)
 *
 * Status encodes activity recency only, NEVER node identity (CLAUDE.md
 * §5 — status lives in the halo, type in the node color).
 */

import type { StoredEvent } from '../../persistence.js';
import type { PeerEntryLite } from '../data/topology-data.js';

export type ActorClass = 'operator' | 'cc' | 'cowork' | 'peer' | 'default';

export interface ActorNodeLite {
  /** Stable id used as the topology graph node id (e.g., `actor-operator-cowork`). */
  id: string;
  /** Color/family bucket; drives the node fill via the --actor-* tokens. */
  actorClass: ActorClass;
  /** Short human-readable label rendered on the node. */
  display_name: string;
  /** Free-form descriptor: session, peer endpoint, etc. */
  role?: string;
  /** Halo color per CLAUDE.md §5 — recency-driven. */
  status: 'ok' | 'warn' | 'crit' | 'unknown';
  /** ISO timestamp of the most recent event attributed to this actor. */
  last_seen_at?: string;
  /** Raw `source_agent` string when the actor was derived from events. */
  source_agent?: string;
  /** When the actor was matched from `peers.yaml` rather than events. */
  peer_id?: string;
}

const OK_THRESHOLD_MS  = 60_000;          // 1 minute
const WARN_THRESHOLD_MS = 5 * 60_000;     // 5 minutes
const DEFAULT_GRACE_MS  = 60 * 60_000;    // 1h grace per the dispatch

/**
 * Classify a `source_agent` string into an actor family. Conservative
 * substring checks — operators see what they expect, unknown strings
 * fall through to `default` rather than getting a guessed color.
 *
 * Returns null for `null` / undefined / empty strings so a malformed
 * event doesn't bloat the actor set with a phantom node.
 */
export function classifyActor(agent: string | null | undefined): ActorClass | null {
  if (!agent) return null;
  const s = String(agent).toLowerCase();
  if (s.includes('operator')) return 'operator';
  if (s.includes('cowork')) return 'cowork';
  // Match "cc-" prefix, "claude-code" hyphenated, or the wire-level
  // "cc" agent string the CLI emits. Order matters: cowork must be
  // checked first since cowork-claude contains "claude".
  if (s.includes('claude-code') || s.startsWith('cc-') || s === 'cc') return 'cc';
  if (s.startsWith('peer-') || s.includes('stavr-peer') || s.includes('federated')) return 'peer';
  return 'default';
}

function statusFromRecency(now: number, lastSeenAt: number | undefined): ActorNodeLite['status'] {
  if (!lastSeenAt || !Number.isFinite(lastSeenAt)) return 'unknown';
  const delta = now - lastSeenAt;
  if (delta <= OK_THRESHOLD_MS) return 'ok';
  if (delta <= WARN_THRESHOLD_MS) return 'warn';
  return 'crit';
}

function displayNameFor(actorClass: ActorClass, source: string): string {
  switch (actorClass) {
    case 'operator': return 'operator';
    case 'cc':       return source.length > 18 ? source.slice(0, 16) + '…' : source;
    case 'cowork':   return 'cowork';
    case 'peer':     return source.length > 18 ? source.slice(0, 16) + '…' : source;
    default:         return source.length > 18 ? source.slice(0, 16) + '…' : source;
  }
}

export interface DeriveActorsInput {
  events: readonly StoredEvent[];
  peers: readonly PeerEntryLite[];
  now?: number;
  /** Window in milliseconds for event-derived actors. Default 24h. */
  windowMs?: number;
}

/**
 * Compose actor-nodes from event source_agents + peers.yaml entries.
 * Idempotent — same input always produces same output (modulo `now`).
 *
 * Identity rules:
 *   - One node per (actorClass, source_agent) pair from the event stream
 *   - One node per peers.yaml entry; if a peer is also active in events
 *     the peer entry wins (we keep the operator-named display_name).
 *   - Actors are sorted operator → cc → cowork → peer → default for
 *     stable rendering order.
 */
export function deriveActorNodes(input: DeriveActorsInput): ActorNodeLite[] {
  const now = input.now ?? Date.now();
  const windowMs = input.windowMs ?? 24 * 60 * 60 * 1000;
  const cutoff = now - windowMs;

  // Track per-source_agent the latest timestamp seen.
  const seen = new Map<string, { lastAt: number; cls: ActorClass; source: string }>();
  for (const ev of input.events) {
    const at = Date.parse(ev.at);
    if (!Number.isFinite(at) || at < cutoff) continue;
    const cls = classifyActor(ev.source_agent);
    if (!cls) continue;
    const source = String(ev.source_agent);
    const prior = seen.get(source);
    if (!prior || at > prior.lastAt) {
      seen.set(source, { lastAt: at, cls, source });
    }
  }

  const out: ActorNodeLite[] = [];
  for (const [source, { lastAt, cls }] of seen) {
    out.push({
      id: `actor-${cls}-${source}`,
      actorClass: cls,
      display_name: displayNameFor(cls, source),
      role: cls === 'cc' || cls === 'cowork' ? source : undefined,
      status: statusFromRecency(now, lastAt),
      last_seen_at: new Date(lastAt).toISOString(),
      source_agent: source,
    });
  }

  // Layer peers.yaml on top. A peer that's also event-active keeps its
  // event-derived recency but takes the peer display name.
  for (const peer of input.peers) {
    const peerId = `actor-peer-${peer.id}`;
    const existing = out.find((a) => a.id === peerId);
    if (existing) {
      existing.display_name = peer.display_name;
      existing.role = peer.role ?? existing.role;
      existing.peer_id = peer.id;
      continue;
    }
    out.push({
      id: peerId,
      actorClass: 'peer',
      display_name: peer.display_name,
      role: peer.role,
      // No event evidence → carry the peers.yaml-declared status as the
      // halo signal. v0.7 federation health-checks will turn this into
      // a live probe; for now it's operator-declared.
      status: peer.status === 'crit' ? 'crit' : peer.status === 'warn' ? 'warn' : peer.status === 'ok' ? 'ok' : 'unknown',
      peer_id: peer.id,
    });
  }

  const ORDER: Record<ActorClass, number> = {
    operator: 0, cc: 1, cowork: 2, peer: 3, default: 4,
  };
  out.sort((a, b) => {
    const c = ORDER[a.actorClass] - ORDER[b.actorClass];
    if (c !== 0) return c;
    return a.id.localeCompare(b.id);
  });
  return out;

  // Unused but exported for symmetry; the grace window logic above
  // never deletes — it just downgrades the halo. v0.7 will eviction-
  // sweep transient cc/cowork sessions older than DEFAULT_GRACE_MS.
  void DEFAULT_GRACE_MS;
}

// ----------------------------------------------------------------------
// CSS for the actor-node visual treatment. The shape pattern is the same
// as other graph nodes (.gnode + .shape.round + .halo) but with an
// `.actor-node` modifier that swaps the node color and adds a subtle
// glyph ring so actors read as a distinct family.
// ----------------------------------------------------------------------

export const TOPOLOGY_ACTOR_NODES_CSS = `
.gnode.actor-node .shape {
  border-width: 2px;
  background:
    radial-gradient(circle at 30% 30%, rgba(255,255,255,0.10), transparent 60%),
    var(--surface-2);
}
.gnode.actor-node[data-actor-class="operator"] .shape { color: var(--actor-operator); }
.gnode.actor-node[data-actor-class="cc"]       .shape { color: var(--actor-cc); }
.gnode.actor-node[data-actor-class="cowork"]   .shape { color: var(--actor-cowork); }
.gnode.actor-node[data-actor-class="peer"]     .shape { color: var(--actor-peer); }
.gnode.actor-node[data-actor-class="default"]  .shape { color: var(--actor-default); }

/* Actor glyph ring — thin double border so actors visually distinguish
   from MCP/worker nodes even when zoomed out. */
.gnode.actor-node .shape::after {
  content: '';
  position: absolute; inset: -3px;
  border-radius: 50%;
  border: 1px dashed currentColor;
  opacity: .55;
  pointer-events: none;
}
.gnode.actor-node[data-status="ok"]   .shape::after { animation: actor-ring-ok 3.2s linear infinite; }
.gnode.actor-node[data-status="warn"] .shape::after { opacity: .35; }
.gnode.actor-node[data-status="crit"] .shape::after { opacity: .25; border-style: dotted; }
@keyframes actor-ring-ok {
  from { transform: rotate(0deg); }
  to   { transform: rotate(360deg); }
}

.gnode.actor-node .node-label {
  font-weight: 500;
}
.gnode.actor-node .node-label .role {
  font-size: 11px;
  color: var(--ink-3);
}
`;
