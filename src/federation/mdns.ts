/**
 * mDNS advertising + discovery for stavR federation — ADR-042 §Decision 2
 * (LAN discovery layer).
 *
 * stavR daemons on the same LAN announce themselves as `_stavr._tcp.local`
 * with a TXT record carrying the peer id + protocol version. The
 * peer-registry merges these discoveries with the peers.yaml trust root.
 *
 * Phase 2-trimmed scope: LAN-only. WebRTC / internet discovery is a v1.0
 * follow-up — see `docs/family-mode.md` (Phase 7) for the documented
 * deferral.
 *
 * The advertiser + browser run during daemon foreground only; both are
 * cleanly torn down on shutdown so the OS doesn't leak mDNS records.
 */
import { EventEmitter } from 'node:events';
import { Bonjour, type Service } from 'bonjour-service';
import { getLogger } from '../log.js';

export const STAVR_SERVICE_TYPE = 'stavr';
export const STAVR_PROTOCOL_VERSION = '1';

export interface AdvertiseOptions {
  /** Peer id to broadcast. Family-mode UI labels discovered peers by id. */
  peerId: string;
  /** Display name for the TXT record. */
  displayName: string;
  /** Daemon HTTP port other peers will dial. */
  port: number;
  /** Optional override of the bonjour driver — tests inject a stub. */
  driver?: Pick<Bonjour, 'publish' | 'find' | 'destroy' | 'unpublishAll'>;
}

export interface DiscoveredPeer {
  /** Service name (advertised peer id). */
  id: string;
  /** Display name from TXT record. */
  display_name: string;
  /** Resolved hostname (.local suffix on most LANs). */
  hostname: string;
  /** IPv4 + IPv6 addresses the resolver returned. */
  addresses: string[];
  /** Daemon HTTP port. */
  port: number;
  /** Protocol version from TXT — peers may decline to mirror events
   *  if the major version differs. */
  protocol_version: string;
}

export interface McoordinatorEvents {
  /** A peer was found on the LAN. Fires once per service-up. */
  discovered: (peer: DiscoveredPeer) => void;
  /** A peer announced shutdown / went silent. */
  lost: (peerId: string) => void;
  /** Error from the underlying bonjour driver — surfaced rather than
   *  swallowed so the family-mode UI can show a degraded state. */
  error: (err: Error) => void;
}

export class MdnsCoordinator extends EventEmitter {
  private driver: Pick<Bonjour, 'publish' | 'find' | 'destroy' | 'unpublishAll'>;
  private advertised?: Service;
  private browser?: ReturnType<Bonjour['find']>;
  private stopped = false;

  constructor() {
    super();
    this.driver = new Bonjour();
  }

  /** Replace the underlying bonjour driver. Tests use this to inject a
   *  stub so they don't bind multicast sockets. */
  useDriver(driver: Pick<Bonjour, 'publish' | 'find' | 'destroy' | 'unpublishAll'>): void {
    this.driver = driver;
  }

  /** Start advertising + discovery. Call once at daemon boot. Idempotent
   *  — second call is a no-op unless stopped between. */
  start(opts: AdvertiseOptions): void {
    if (this.stopped) {
      throw new Error('MdnsCoordinator: cannot restart after stop()');
    }
    if (this.advertised || this.browser) return; // already running

    if (opts.driver) this.driver = opts.driver;

    try {
      this.advertised = this.driver.publish({
        name: opts.peerId,
        type: STAVR_SERVICE_TYPE,
        protocol: 'tcp',
        port: opts.port,
        txt: {
          peer_id: opts.peerId,
          display_name: opts.displayName,
          protocol_version: STAVR_PROTOCOL_VERSION,
        },
      });
    } catch (err) {
      this.emit('error', toError(err));
      return;
    }

    // bonjour-service signals "Service name is already in use" via an
    // async 'error' event AFTER publish() returns (RFC 6762 §8.2 probe
    // response). Without a listener that surfaces as uncaughtException
    // and crashes the daemon. Forward into our own 'error' event which
    // federation/index.ts already routes to log.warn.
    (this.advertised as unknown as EventEmitter).on('error', (err: unknown) => {
      this.emit('error', toError(err));
    });

    this.browser = this.driver.find(
      { type: STAVR_SERVICE_TYPE, protocol: 'tcp' },
      (service: Service) => {
        // Filter out our own broadcast — same peer_id on the wire means
        // we found ourselves.
        const txtId = readTxtString(service.txt, 'peer_id');
        if (txtId === opts.peerId) return;
        const peer = serviceToDiscovered(service);
        if (peer) this.emit('discovered', peer);
      },
    );

    this.browser.on('down', (service: Service) => {
      const id = readTxtString(service.txt, 'peer_id') ?? service.name;
      this.emit('lost', id);
    });

    (this.browser as unknown as EventEmitter).on('error', (err: unknown) => {
      this.emit('error', toError(err));
    });

    getLogger().info('mDNS coordinator started', { peer_id: opts.peerId, port: opts.port });
  }

  /** Tear everything down. Safe to call multiple times. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    try {
      this.driver.unpublishAll();
    } catch (err) {
      this.emit('error', toError(err));
    }
    try {
      this.driver.destroy();
    } catch {
      /* destroy on a torn-down bonjour driver is non-fatal */
    }
    this.advertised = undefined as Service | undefined;
    this.browser = undefined;
  }

  // EventEmitter typing — improves call-site DX.
  override on<K extends keyof McoordinatorEvents>(
    event: K,
    listener: McoordinatorEvents[K],
  ): this;
  override on(event: string, listener: (...args: never[]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  override emit<K extends keyof McoordinatorEvents>(
    event: K,
    ...args: Parameters<McoordinatorEvents[K]>
  ): boolean;
  override emit(event: string, ...args: unknown[]): boolean {
    return super.emit(event, ...args);
  }
}

/** Translate a `bonjour-service` Service into our public DiscoveredPeer
 *  shape. Returns undefined on incomplete records (missing port or
 *  hostname — the resolver hadn't finished). */
export function serviceToDiscovered(service: Service): DiscoveredPeer | undefined {
  const id = readTxtString(service.txt, 'peer_id') ?? service.name;
  const display_name = readTxtString(service.txt, 'display_name') ?? id;
  const protocol_version = readTxtString(service.txt, 'protocol_version') ?? '?';
  if (!service.host || !service.port) return undefined;
  return {
    id,
    display_name,
    hostname: service.host,
    addresses: service.addresses ?? [],
    port: service.port,
    protocol_version,
  };
}

function readTxtString(txt: unknown, key: string): string | undefined {
  if (!txt || typeof txt !== 'object') return undefined;
  const value = (txt as Record<string, unknown>)[key];
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return undefined;
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
