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
 * Address selection — walk-candidates with last-working cache.
 *
 * Each PeerRecord can carry multiple addresses (mDNS A records often
 * include one entry per interface; multi-homed peers expose one IP per
 * network). The bombardment rig's hub joins both site_a and site_b
 * networks and consequently announces two IPv4s in its mDNS service
 * record; the order in which they arrive at a viewer is non-
 * deterministic. The previous "pick the first IPv4" strategy stuck
 * peer-a on the cross-subnet IP whenever it happened to arrive first,
 * timing out every probe and silently flipping the peer to `degraded`
 * forever (chaos-debug BOM Phase 4 diagnosis).
 *
 * Strategy now: `health()` tries each candidate URL in order until one
 * succeeds, returns the first success, and caches the winning URL per
 * peer so subsequent probes go straight to it (no per-probe walking
 * cost on the healthy path). On all candidates failing, returns
 * ok=false with the combined per-attempt error so the caller can log
 * what was tried.
 *
 * Ordering: cached last-working URL (if any) → discovered IPv4s →
 * non-IPv4 discovered addresses → hostname. IPv4-before-hostname is
 * preserved from the original "Bonjour on Windows can't always
 * resolve" concern; the walking + hostname-as-last-resort just adds
 * a recovery path the single-address strategy lacked.
 */
import { request as httpRequest } from 'node:http';
import type { PeerRecord } from '../types/federation.js';

export interface PeerHealthResult {
  ok: boolean;
  status: number;
  body?: PeerHealthBody;
  error?: string;
  /** Base URL of the candidate that produced this result. Useful for
   *  logging which of a multi-address peer actually answered. */
  base_url?: string;
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
  /** Map of peer.id → last base URL that produced a 2xx response. Keyed
   *  by peer id (stable), not by base URL (which can change when mDNS
   *  re-discovers different interfaces). Unbounded in size but bounded
   *  in practice by the configured + discovered peer count (<100 in
   *  realistic deployments). Cleared on daemon restart. */
  private readonly lastWorkingByPeer = new Map<string, string>();

  constructor(opts: PeerClientOptions = {}) {
    this.fetcher = opts.fetcher ?? defaultFetcher;
    this.timeoutMs = opts.timeoutMs ?? 3000;
  }

  /** Build the ordered list of base URLs to try for a peer. Cached
   *  last-working URL (if any) is moved to the front; otherwise the
   *  canonical order is IPv4 addresses → non-IPv4 → hostname. */
  candidates(peer: PeerRecord): string[] {
    const canonical: string[] = [];
    for (const addr of peer.addresses) {
      if (isIPv4(addr)) canonical.push(baseUrl(addr, peer.port));
    }
    for (const addr of peer.addresses) {
      if (!isIPv4(addr)) canonical.push(baseUrl(addr, peer.port));
    }
    if (peer.hostname) canonical.push(baseUrl(peer.hostname, peer.port));

    const cached = this.lastWorkingByPeer.get(peer.id);
    if (cached === undefined) return dedupe(canonical);
    return dedupe([cached, ...canonical]);
  }

  /** Probe a peer's `/api/federation/health` endpoint by walking each
   *  candidate URL until one succeeds. Returns the first success; on
   *  total failure, returns ok=false with `error` summarising every
   *  attempt so the caller can log which addresses were tried. */
  async health(peer: PeerRecord): Promise<PeerHealthResult> {
    const candidates = this.candidates(peer);
    if (candidates.length === 0) {
      return { ok: false, status: 0, error: 'no candidate addresses for peer' };
    }
    const attempts: string[] = [];
    for (const base of candidates) {
      const result = await this.tryOne(base);
      if (result.ok === true) {
        this.lastWorkingByPeer.set(peer.id, base);
        return { ...result, base_url: base };
      }
      attempts.push(`${base}: ${result.error ?? `HTTP ${result.status}`}`);
    }
    // All candidates failed. Drop a stale cache so the next probe
    // re-walks from the canonical order instead of preferring an
    // address that no longer works.
    this.lastWorkingByPeer.delete(peer.id);
    return {
      ok: false,
      status: 0,
      error: `all ${candidates.length} candidate(s) failed: ${attempts.join('; ')}`,
    };
  }

  private async tryOne(base: string): Promise<PeerHealthResult> {
    const url = `${base}/api/federation/health`;
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

function isIPv4(addr: string): boolean {
  return /^(\d+\.){3}\d+$/.test(addr);
}

function isIPv6(addr: string): boolean {
  return addr.includes(':');
}

function baseUrl(host: string, port: number): string {
  return isIPv6(host) ? `http://[${host}]:${port}` : `http://${host}:${port}`;
}

function dedupe(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of arr) {
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
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
