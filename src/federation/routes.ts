/**
 * Federation HTTP routes mounted under `/api/federation/*` — Phase 2-trimmed.
 *
 * The receiving side of peer-to-peer traffic. Peers use the PeerClient in
 * `peer-client.ts` to call these endpoints on each other.
 *
 *   GET  /api/federation/health  — liveness + protocol version + peer id
 *   GET  /api/federation/peers   — this daemon's peer registry snapshot
 *
 * Phase 3 adds:
 *   POST /api/federation/event   — receive a mirrored broker event
 *   POST /api/federation/bom     — receive a federated BOM dispatch
 */
import type { Express, Request, Response } from 'express';
import type { PeerRegistry } from './peer-registry.js';
import { STAVR_PROTOCOL_VERSION } from './mdns.js';

export interface FederationRoutesOptions {
  /** Returns the singleton registry. */
  getRegistry: () => PeerRegistry;
  /** This daemon's peer id (typically from peers.yaml self_id or mDNS name). */
  selfId: () => string;
  /** Daemon version string for the health response. */
  daemonVersion: string;
  /** Daemon start time, for uptime calculation. */
  startedAt: Date;
}

export function mountFederationRoutes(app: Express, opts: FederationRoutesOptions): void {
  app.get('/api/federation/health', (_req: Request, res: Response) => {
    res.json({
      peer_id: opts.selfId(),
      protocol_version: STAVR_PROTOCOL_VERSION,
      daemon_version: opts.daemonVersion,
      uptime_seconds: Math.floor((Date.now() - opts.startedAt.getTime()) / 1000),
    });
  });

  app.get('/api/federation/peers', (_req: Request, res: Response) => {
    const records = opts.getRegistry().list();
    res.json({
      self_id: opts.selfId(),
      protocol_version: STAVR_PROTOCOL_VERSION,
      peers: records.map((r) => ({
        id: r.id,
        display_name: r.display_name,
        hostname: r.hostname,
        port: r.port,
        addresses: r.addresses,
        trust: r.trust,
        state: r.state,
        configured: r.configured,
        discovered: r.discovered,
        last_seen_at: r.last_seen_at,
      })),
    });
  });
}
