/**
 * Peer registry — merges peers.yaml (trust root) + mDNS discoveries +
 * runtime ping state into one canonical view the dashboard reads.
 *
 * Phase 2-trimmed scope: in-memory only. Persisting registry state across
 * daemon restarts is a v1.0 follow-up — mDNS rediscovery + peers.yaml
 * reload is fast enough that the operator won't notice a missing cache.
 */
import { EventEmitter } from 'node:events';
import {
  type PeerEntry,
  type PeerRecord,
  type PeersYaml,
} from '../types/federation.js';
import type { DiscoveredPeer } from './mdns.js';

export interface PeerRegistryEvents {
  /** A peer record changed (added, trust updated, state transitioned). */
  changed: (record: PeerRecord) => void;
  /** A peer record was removed from the registry (e.g., yaml reload). */
  removed: (peerId: string) => void;
}

export class PeerRegistry extends EventEmitter {
  private records = new Map<string, PeerRecord>();

  constructor() {
    super();
  }

  /** Replace the configured peer set wholesale (peers.yaml reload).
   *  Existing discovered-only peers are preserved; configured peers are
   *  merged on top. Records that drop out of the new yaml lose their
   *  `configured` flag (and may stick around as discovered-only). */
  loadFromYaml(yaml: PeersYaml): void {
    const yamlIds = new Set(yaml.peers.map((p) => p.id));

    // Demote any record that was configured but isn't anymore.
    for (const [id, rec] of this.records) {
      if (rec.configured && !yamlIds.has(id)) {
        const nextRec: PeerRecord = {
          ...rec,
          configured: false,
          trust: 'untrusted',
          public_key: undefined,
          notes: undefined,
        };
        if (rec.discovered) {
          this.records.set(id, nextRec);
          this.emit('changed', nextRec);
        } else {
          this.records.delete(id);
          this.emit('removed', id);
        }
      }
    }

    // Insert / update from yaml.
    for (const entry of yaml.peers) {
      this.upsertConfigured(entry);
    }
  }

  /** Apply an mDNS discovery — creates a new record or updates the
   *  liveness fields of an existing one. */
  upsertDiscovered(discovered: DiscoveredPeer, now: number = Date.now()): PeerRecord {
    const existing = this.records.get(discovered.id);
    const merged: PeerRecord = existing
      ? {
          ...existing,
          hostname: discovered.hostname,
          addresses: discovered.addresses,
          port: discovered.port,
          discovered: true,
          state: 'online',
          last_seen_at: now,
        }
      : {
          id: discovered.id,
          display_name: discovered.display_name,
          hostname: discovered.hostname,
          addresses: discovered.addresses,
          port: discovered.port,
          trust: 'untrusted',
          state: 'online',
          configured: false,
          discovered: true,
          last_seen_at: now,
        };
    this.records.set(discovered.id, merged);
    this.emit('changed', merged);
    return merged;
  }

  /** Apply a peers.yaml entry — creates or updates with operator-set
   *  trust + display info. */
  upsertConfigured(entry: PeerEntry, now: number = Date.now()): PeerRecord {
    const existing = this.records.get(entry.id);
    const merged: PeerRecord = existing
      ? {
          ...existing,
          display_name: entry.display_name,
          hostname: entry.hostname,
          port: entry.port,
          trust: entry.trust,
          configured: true,
          ...(entry.public_key !== undefined ? { public_key: entry.public_key } : { public_key: undefined }),
          ...(entry.notes !== undefined ? { notes: entry.notes } : { notes: undefined }),
        }
      : {
          id: entry.id,
          display_name: entry.display_name,
          hostname: entry.hostname,
          addresses: [],
          port: entry.port,
          trust: entry.trust,
          state: 'offline',
          configured: true,
          discovered: false,
          last_seen_at: 0,
          ...(entry.public_key !== undefined ? { public_key: entry.public_key } : {}),
          ...(entry.notes !== undefined ? { notes: entry.notes } : {}),
        };
    this.records.set(entry.id, merged);
    this.emit('changed', merged);
    return merged;
  }

  /** Mark a peer as lost (mDNS service-down). Doesn't delete the record —
   *  if the peer is configured, we keep it visible in the family-mode UI
   *  with state=offline. Discovered-only peers fall out. */
  markLost(peerId: string, now: number = Date.now()): void {
    const existing = this.records.get(peerId);
    if (!existing) return;
    if (existing.configured) {
      const next: PeerRecord = {
        ...existing,
        state: 'offline',
        discovered: false,
        last_seen_at: now,
      };
      this.records.set(peerId, next);
      this.emit('changed', next);
    } else {
      this.records.delete(peerId);
      this.emit('removed', peerId);
    }
  }

  /** Update the registry with a ping result — used by peer-client to
   *  reconcile "discovered but unreachable". */
  recordPingResult(peerId: string, ok: boolean, now: number = Date.now()): void {
    const existing = this.records.get(peerId);
    if (!existing) return;
    const nextState = ok ? 'online' : existing.state === 'online' ? 'degraded' : existing.state;
    if (nextState === existing.state && (!ok || existing.last_seen_at === now)) return;
    const next: PeerRecord = {
      ...existing,
      state: nextState,
      last_seen_at: ok ? now : existing.last_seen_at,
    };
    this.records.set(peerId, next);
    this.emit('changed', next);
  }

  /** Get one record by id. */
  get(peerId: string): PeerRecord | undefined {
    return this.records.get(peerId);
  }

  /** Snapshot of every record, sorted by display name. */
  list(): PeerRecord[] {
    return Array.from(this.records.values()).sort((a, b) =>
      a.display_name.localeCompare(b.display_name),
    );
  }

  /** Count of records the family-mode UI will render. */
  size(): number {
    return this.records.size;
  }

  // Typed event emitter surface.
  override on<K extends keyof PeerRegistryEvents>(
    event: K,
    listener: PeerRegistryEvents[K],
  ): this;
  override on(event: string, listener: (...args: never[]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  override emit<K extends keyof PeerRegistryEvents>(
    event: K,
    ...args: Parameters<PeerRegistryEvents[K]>
  ): boolean;
  override emit(event: string, ...args: unknown[]): boolean {
    return super.emit(event, ...args);
  }
}
