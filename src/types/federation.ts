/**
 * Canonical federation types — ADR-042 §Decision 1 (per-task roles) +
 * §Decision 2 (layered discovery).
 *
 * Phase 2-trimmed scope (v0.7): LAN-only federation. peers.yaml is the
 * trust root; mDNS auto-discovers peers on the same LAN; plain HTTP
 * carries the federation traffic. WebRTC + internet-side NAT traversal
 * is documented as a v1.0 follow-up.
 *
 * The role taxonomy (Originator / Participant / Convener) is defined
 * here; enforcement of cross-role permissions lives in `src/broker.ts`
 * and `src/workers/orchestrator.ts` (Phase 3).
 */
import { z } from 'zod';

/** Per-task federation role attribution.
 *  - Originator: holds intent, owns the decision log, one per task.
 *  - Participant: contributes capacity to a task originated elsewhere.
 *  - Convener: hosts the federation event log for a multi-peer task. */
export const FEDERATION_ROLES = ['originator', 'participant', 'convener'] as const;
export type FederationRole = (typeof FEDERATION_ROLES)[number];

/** Trust level the operator has assigned to a peer.
 *  - local-equivalent: peer's actions count as operator's (e.g., your
 *    own second machine, fully signed by your passkey).
 *  - verified: paired peer with confirmed identity; cross-peer Tier 3
 *    actions require operator's passkey assertion on the originating side.
 *  - untrusted: discovered but not paired; mDNS sees it, federation
 *    does NOT mirror events to or from it. */
export const TRUST_LEVELS = ['local-equivalent', 'verified', 'untrusted'] as const;
export type PeerTrustLevel = (typeof TRUST_LEVELS)[number];

/** Per-peer connection state, tracked by the peer-registry. */
export const PEER_STATES = ['offline', 'discovered', 'online', 'degraded'] as const;
export type PeerState = (typeof PEER_STATES)[number];

/** peers.yaml entry — the operator's affirmative trust statement.
 *  `public_key` carries the operator's Ed25519 public key as they're
 *  registered on the target peer. Pairing flow (out of scope for v0.7
 *  Phase 2-trimmed) generates these from the peer's WebAuthn root. */
export const PeerEntrySchema = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9_-]*$/i, 'peer id must be alphanumeric + dash/underscore'),
  display_name: z.string().min(1).max(128),
  hostname: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65535).default(7777),
  /** Optional Ed25519 public key (base64 or `ed25519:<base64>` prefix). The
   *  pairing ceremony populates this; presence is required for
   *  trust levels above 'untrusted'. */
  public_key: z.string().optional(),
  trust: z.enum(TRUST_LEVELS).default('untrusted'),
  notes: z.string().optional(),
});

export type PeerEntry = z.infer<typeof PeerEntrySchema>;

export const PeersYamlSchema = z.object({
  /** This installation's peer id, used in mDNS TXT records and federation
   *  event attribution. Defaults to the host's mDNS name (derived at
   *  runtime if omitted). */
  self_id: z.string().min(1).max(64).optional(),
  /** This installation's display name. */
  self_display_name: z.string().min(1).max(128).optional(),
  peers: z.array(PeerEntrySchema).default([]),
});

export type PeersYaml = z.infer<typeof PeersYamlSchema>;

/** Runtime peer record — what the in-memory registry tracks. Combines
 *  the static yaml entry with live discovery state from mDNS + the last
 *  HTTP ping result. */
export interface PeerRecord {
  /** Stable peer identifier. */
  id: string;
  /** Display name for the family-mode UI. */
  display_name: string;
  /** Hostname (with .local suffix for mDNS hits). */
  hostname: string;
  /** Daemon HTTP port. */
  port: number;
  /** Last-known IPv4 addresses from mDNS A records. */
  addresses: string[];
  /** Operator-set trust level. Defaults to untrusted for mDNS-only finds. */
  trust: PeerTrustLevel;
  /** Connection state. */
  state: PeerState;
  /** Whether the peer is also in peers.yaml (operator-affirmed). */
  configured: boolean;
  /** Whether the peer was found via mDNS. */
  discovered: boolean;
  /** Last time the registry saw this peer (mDNS ttl bump or HTTP success). */
  last_seen_at: number;
  /** Optional Ed25519 public key as configured in peers.yaml. */
  public_key?: string | undefined;
  /** Optional free-text notes from peers.yaml. */
  notes?: string | undefined;
}

/** Federation context that rides on every BOM + every broker event when
 *  federation is active. Phase 3 wires this into the broker; Phase 2
 *  just defines the type so peer-registry can stamp it on discovery
 *  events. */
export interface FederationContext {
  /** Stable peer id of the originating instance. */
  origin_peer: string;
  /** Per-task role assignment of THIS peer for this task. */
  role: FederationRole;
  /** Optional convener peer (defaults to originator). */
  convener_peer?: string;
}
