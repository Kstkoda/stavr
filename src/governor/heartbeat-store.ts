// governor-polish Cluster C — in-memory heartbeat store.
//
// The Governor POSTs `/governor/heartbeat` every ~10 s while it is
// running. This module-level holder keeps the latest payload + the
// `received_at` timestamp; `current(stalenessMs)` returns the payload
// IFF it is fresh enough, otherwise `null` so the Diagnostics fetcher
// honestly renders the Governor as `not-running`.
//
// No DB, no persistence — this is live state, not init-cached config.
// A daemon restart clears the store; the next Governor heartbeat
// (≤ 10 s later) refills it.

import type { GovernorHeartbeat } from '../dashboard/data/build-versions.js';

/** Default staleness window. 3× the Governor's 10 s send interval plus a
 *  modest jitter buffer — the BOM acceptance is "quitting the Governor
 *  flips the tile to not-running within ~35 s". */
export const DEFAULT_STALENESS_MS = 35_000;

/** Conservative cap on the body the route will accept (also bound the
 *  in-memory string lengths defensively). */
export const MAX_VERSION_LEN = 64;
export const MAX_RUST_LEN = 64;

export const ALLOWED_SIGNING = ['cosign-signed', 'dev-signed', 'unsigned'] as const;
export type Signing = (typeof ALLOWED_SIGNING)[number];

interface HeldHeartbeat extends GovernorHeartbeat {
  /** ms since epoch when the daemon received the heartbeat. */
  received_at_ms: number;
}

export interface HeartbeatStore {
  /** Record a freshly-received heartbeat. */
  record(input: GovernorHeartbeat, nowMs?: number): void;
  /** Latest heartbeat IF within the staleness window, else `null`. */
  current(stalenessMs?: number, nowMs?: number): GovernorHeartbeat | null;
  /** Test helper — wipe the held heartbeat. */
  reset(): void;
}

class InMemoryHeartbeatStore implements HeartbeatStore {
  private latest: HeldHeartbeat | null = null;

  record(input: GovernorHeartbeat, nowMs: number = Date.now()): void {
    // The route validates before calling; this is belt-and-braces for
    // direct test invocations.
    const version = typeof input.version === 'string' ? input.version.slice(0, MAX_VERSION_LEN) : undefined;
    const rust_version =
      typeof input.rust_version === 'string' ? input.rust_version.slice(0, MAX_RUST_LEN) : undefined;
    const signing = input.signing && (ALLOWED_SIGNING as readonly string[]).includes(input.signing)
      ? input.signing
      : undefined;
    this.latest = { version, signing, rust_version, received_at_ms: nowMs };
  }

  current(stalenessMs: number = DEFAULT_STALENESS_MS, nowMs: number = Date.now()): GovernorHeartbeat | null {
    if (!this.latest) return null;
    if (nowMs - this.latest.received_at_ms > stalenessMs) return null;
    const { received_at_ms: _ignored, ...payload } = this.latest;
    return payload;
  }

  reset(): void {
    this.latest = null;
  }
}

/** Process-singleton — the daemon's HTTP route writes here, the
 *  diagnostics fetcher reads here. Tests can construct their own
 *  isolated store via {@link createHeartbeatStore} when they need to
 *  inject a clock. */
export const heartbeatStore: HeartbeatStore = new InMemoryHeartbeatStore();

/** Test seam — fresh isolated instance. */
export function createHeartbeatStore(): HeartbeatStore {
  return new InMemoryHeartbeatStore();
}

/** Pure validator — surfaces the same rejection reasons the route does.
 *  Splitting it out lets tests cover every reject branch without
 *  booting an HTTP server. Returns `null` on success, or a short error
 *  message describing the first failure. */
export function validateHeartbeatBody(raw: unknown): { ok: true; value: GovernorHeartbeat } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const obj = raw as Record<string, unknown>;
  const allowed = new Set(['version', 'signing', 'rust_version']);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) return { ok: false, error: `unknown field: ${key}` };
  }
  const version = obj.version;
  if (typeof version !== 'string' || version.length === 0) {
    return { ok: false, error: 'version required (non-empty string)' };
  }
  if (version.length > MAX_VERSION_LEN) {
    return { ok: false, error: `version too long (>${MAX_VERSION_LEN})` };
  }
  let signing: Signing | undefined;
  if (obj.signing !== undefined) {
    if (typeof obj.signing !== 'string' || !(ALLOWED_SIGNING as readonly string[]).includes(obj.signing)) {
      return { ok: false, error: 'signing must be one of: ' + ALLOWED_SIGNING.join(', ') };
    }
    signing = obj.signing as Signing;
  }
  let rust_version: string | undefined;
  if (obj.rust_version !== undefined) {
    if (typeof obj.rust_version !== 'string') {
      return { ok: false, error: 'rust_version must be a string' };
    }
    if (obj.rust_version.length > MAX_RUST_LEN) {
      return { ok: false, error: `rust_version too long (>${MAX_RUST_LEN})` };
    }
    rust_version = obj.rust_version;
  }
  return { ok: true, value: { version, signing, rust_version } };
}
