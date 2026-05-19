/**
 * Inter-peer plain-HTTP client. ADR-042 §Decision 2's WebRTC layer is
 * deferred to v1.0 (per operator decision in Phase 0 findings §D); v0.7
 * federation runs over the daemon's existing HTTP surface bound to the
 * LAN interface.
 *
 * Per-peer endpoints (mounted in Phase 2-trimmed):
 *   GET  /api/federation/health  — peer liveness + protocol version
 *   GET  /api/federation/peer    — peer self-description (id, display, version)
 *   POST /api/federation/event   — Phase 3: receive a mirrored event
 *
 * This module just builds clients pointed at PeerRecord endpoints. The
 * receiving side (HTTP routes) is wired in transports.ts via
 * `mountFederationRoutes`.
 */
import { request as httpRequest } from 'node:http';
import type { PeerRecord } from '../types/federation.js';

export interface PeerHealthResult {
  ok: boolean;
  status: number;
  body?: PeerHealthBody;
  error?: string;
}

export interface PeerHealthBody {
  peer_id: string;
  protocol_version: string;
  daemon_version?: string;
  uptime_seconds?: number;
}

export interface PeerClientOptions {
  /** Override fetch — tests inject a stub. Defaults to a node-http GET. */
  fetcher?: (url: string, init?: { timeoutMs?: number }) => Promise<{
    status: number;
    text: () => Promise<string>;
  }>;
  /** Per-request timeout in ms. Default 3000. Phase 2-trimmed is LAN-only
   *  so 3s is generous; tune up for v1.0 internet peers. */
  timeoutMs?: number;
}

export class PeerClient {
  private readonly fetcher: NonNullable<PeerClientOptions['fetcher']>;
  private readonly timeoutMs: number;

  constructor(opts: PeerClientOptions = {}) {
    this.fetcher = opts.fetcher ?? defaultFetcher;
    this.timeoutMs = opts.timeoutMs ?? 3000;
  }

  /** Build the base URL for a peer. Prefers the first IPv4 address
   *  observed via mDNS over hostname (mDNS hostnames sometimes need
   *  Bonjour resolver Windows can't always reach). */
  baseUrlFor(peer: PeerRecord): string {
    const host = preferredAddress(peer);
    return `http://${host}:${peer.port}`;
  }

  /** Probe a peer's `/api/federation/health` endpoint. Used by the
   *  peer-registry's ping reconciliation. */
  async health(peer: PeerRecord): Promise<PeerHealthResult> {
    const url = `${this.baseUrlFor(peer)}/api/federation/health`;
    try {
      const res = await this.fetcher(url, { timeoutMs: this.timeoutMs });
      const text = await res.text();
      if (res.status < 200 || res.status >= 300) {
        return { ok: false, status: res.status, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
      }
      let body: PeerHealthBody | undefined;
      try {
        body = JSON.parse(text) as PeerHealthBody;
      } catch {
        return { ok: false, status: res.status, error: 'response not JSON' };
      }
      return { ok: true, status: res.status, body };
    } catch (err) {
      return { ok: false, status: 0, error: (err as Error).message };
    }
  }
}

function preferredAddress(peer: PeerRecord): string {
  const ipv4 = peer.addresses.find((a) => /^(\d+\.){3}\d+$/.test(a));
  if (ipv4) return ipv4;
  if (peer.addresses[0]) return peer.addresses[0];
  return peer.hostname;
}

async function defaultFetcher(
  url: string,
  init?: { timeoutMs?: number },
): Promise<{ status: number; text: () => Promise<string> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: 'GET' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({
          status: res.statusCode ?? 0,
          text: async () => buf.toString('utf8'),
        });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (init?.timeoutMs) {
      req.setTimeout(init.timeoutMs, () => {
        req.destroy(new Error(`peer-client timeout after ${init.timeoutMs}ms`));
      });
    }
    req.end();
  });
}
