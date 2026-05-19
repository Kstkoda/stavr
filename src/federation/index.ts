/**
 * Federation subsystem bootstrap — Phase 2-trimmed (LAN-only).
 *
 * The daemon constructs ONE `FederationSubsystem` per broker at boot. It
 * owns the peer registry, the mDNS coordinator, and the periodic ping
 * loop that keeps registry state honest.
 *
 * Exported entry points:
 *   - `createFederation(opts)` — build the subsystem without starting it
 *   - `subsystem.start(opts)`  — load peers.yaml, start mDNS, wire pings
 *   - `subsystem.stop()`       — clean tear-down at daemon shutdown
 *   - `subsystem.registry`     — readable handle for the dashboard
 *
 * Phase 3 will extend this with event mirroring across peers; v1.0 layers
 * WebRTC on top for internet-side NAT traversal.
 */
import { getLogger } from '../log.js';
import { loadPeersYaml, type LoadOptions as PeersLoadOptions } from './peers.js';
import { MdnsCoordinator } from './mdns.js';
import { PeerRegistry } from './peer-registry.js';
import { PeerClient } from './peer-client.js';

export interface FederationStartOptions {
  /** This daemon's HTTP port (so we can advertise it via mDNS). */
  port: number;
  /** Daemon start time for uptime reporting. */
  startedAt: Date;
  /** Optional override of the peers.yaml path. */
  peersYamlPath?: string;
  /** Test injection point — skip mDNS start. */
  skipMdns?: boolean;
  /** Test injection point — peer-client fetcher. */
  peerClient?: PeerClient;
  /** Periodic ping interval. Default 60_000 ms. Tests pass null to skip. */
  pingIntervalMs?: number | null;
}

export interface FederationSubsystem {
  registry: PeerRegistry;
  mdns: MdnsCoordinator;
  selfId: () => string;
  start(opts: FederationStartOptions): Promise<void>;
  stop(): void;
  /** Trigger an immediate ping pass — exposed for tests + dashboard "refresh now" button. */
  pingNow(): Promise<void>;
  /** Re-read peers.yaml. Returns the count of configured peers after reload. */
  reloadPeers(opts?: PeersLoadOptions): number;
}

export function createFederation(): FederationSubsystem {
  const registry = new PeerRegistry();
  const mdns = new MdnsCoordinator();
  let selfId: string = process.env['STAVR_PEER_ID'] ?? 'stavr-self';
  let pingTimer: NodeJS.Timeout | null = null;
  let peerClient: PeerClient | null = null;
  let started = false;
  const log = getLogger();

  return {
    registry,
    mdns,
    selfId: () => selfId,

    async start(opts: FederationStartOptions): Promise<void> {
      if (started) return;
      started = true;

      // 1. Load peers.yaml — this seeds the trust root.
      const loadOpts: PeersLoadOptions = {};
      if (opts.peersYamlPath !== undefined) loadOpts.path = opts.peersYamlPath;
      const { yaml, path } = loadPeersYaml(loadOpts);
      if (yaml.self_id) selfId = yaml.self_id;
      registry.loadFromYaml(yaml);
      log.info('federation: peers.yaml loaded', {
        path,
        peer_count: yaml.peers.length,
        self_id: selfId,
      });

      // 2. mDNS — advertise + discover. Errors are non-fatal: federation
      //    degrades to peers.yaml-only when multicast is blocked.
      if (!opts.skipMdns) {
        mdns.on('discovered', (peer) => {
          registry.upsertDiscovered(peer);
        });
        mdns.on('lost', (peerId) => {
          registry.markLost(peerId);
        });
        mdns.on('error', (err) => {
          log.warn('federation: mDNS error', { error: err.message });
        });
        const displayName = yaml.self_display_name ?? selfId;
        mdns.start({
          peerId: selfId,
          displayName,
          port: opts.port,
        });
      }

      // 3. Periodic ping reconciler. Discovered peers may go silent
      //    without a clean mDNS service-down; an HTTP probe confirms.
      peerClient = opts.peerClient ?? new PeerClient();
      const intervalMs = opts.pingIntervalMs === undefined ? 60_000 : opts.pingIntervalMs;
      if (intervalMs !== null) {
        pingTimer = setInterval(() => {
          void this.pingNow();
        }, intervalMs);
        if (typeof pingTimer.unref === 'function') pingTimer.unref();
      }
    },

    stop(): void {
      if (!started) return;
      started = false;
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
      try {
        mdns.stop();
      } catch (err) {
        log.warn('federation: mDNS stop errored', { error: (err as Error).message });
      }
    },

    async pingNow(): Promise<void> {
      if (!peerClient) return;
      const peers = registry.list();
      await Promise.all(
        peers.map(async (peer) => {
          // Only ping peers we have at least an address for; configured-but-
          // never-discovered peers can't be reached until mDNS resolves.
          if (peer.addresses.length === 0 && !peer.hostname) return;
          const result = await peerClient!.health(peer);
          registry.recordPingResult(peer.id, result.ok);
        }),
      );
    },

    reloadPeers(reloadOpts?: PeersLoadOptions): number {
      const { yaml } = loadPeersYaml(reloadOpts ?? {});
      if (yaml.self_id) selfId = yaml.self_id;
      registry.loadFromYaml(yaml);
      return yaml.peers.length;
    },
  };
}

export { PeerRegistry } from './peer-registry.js';
export { MdnsCoordinator } from './mdns.js';
export { PeerClient } from './peer-client.js';
export { loadPeersYaml, defaultPeersYamlPath, PeersYamlError } from './peers.js';
export { mountFederationRoutes } from './routes.js';
export type { FederationRoutesOptions } from './routes.js';
