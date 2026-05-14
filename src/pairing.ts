/**
 * Spec 52 A2 — pairing flow (in-memory pending-pairing registry).
 *
 * The bootstrap operator (on the daemon machine) opens a pairing window by
 * generating a 6-digit code, valid for 5 minutes. The remote device exchanges
 * that code for a long-term token via `POST /pair/complete`.
 *
 * Pending codes live entirely in memory — they expire on restart, which is the
 * correct security posture (anyone with `stavr pair --bootstrap` access can
 * always re-open a window). Issued tokens are persisted in the `devices` table
 * (token_hash only — see persistence.ts).
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export const PAIRING_CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes
export const PAIRING_CODE_LEN = 6;

export interface PendingPairing {
  code: string;
  expires_at: number;
}

/**
 * Generates a 6-digit code (zero-padded). Uses crypto.randomInt for uniform
 * distribution rather than Math.random — small but non-trivial entropy distinction.
 */
export function generatePairingCode(): string {
  const n = randomInt(0, 1_000_000);
  return n.toString().padStart(PAIRING_CODE_LEN, '0');
}

/** Generates a fresh device auth token. UUID-shaped, 128 bits of entropy. */
export function generateDeviceToken(): string {
  return randomBytes(24).toString('hex');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Constant-time comparison of two strings via timingSafeEqual. Returns false
 * if the lengths differ (timingSafeEqual throws on length mismatch — we mask
 * that with an explicit early return so the timing channel stays tight).
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * In-memory pending-pairing registry. Single instance per daemon process. Codes
 * are unique while pending; once a code is consumed (matched against a complete
 * request) it is removed from the registry — single-use.
 */
export class PendingPairingRegistry {
  private pending = new Map<string, PendingPairing>();

  /** Opens a new pairing window. Returns the 6-digit code the operator types into the device. */
  open(now: number = Date.now()): PendingPairing {
    this.gc(now);
    // Loop until we land a unique code. With 1e6 possible codes and a 5min TTL,
    // collisions are vanishingly rare in practice but the loop is cheap.
    for (let i = 0; i < 10; i++) {
      const code = generatePairingCode();
      if (!this.pending.has(code)) {
        const record = { code, expires_at: now + PAIRING_CODE_TTL_MS };
        this.pending.set(code, record);
        return record;
      }
    }
    throw new Error('pairing: failed to allocate unique code after 10 attempts');
  }

  /**
   * Consumes a code if it matches a pending pairing within the TTL. Returns
   * the matched pairing record on success and removes it; returns undefined if
   * the code is unknown or expired (in which case the caller emits a generic
   * 'invalid code' response — never distinguish unknown from expired in the
   * client-facing message).
   */
  consume(code: string, now: number = Date.now()): PendingPairing | undefined {
    this.gc(now);
    // Iterate to find a constant-time match — protects against attackers
    // probing whether specific codes exist via Map.get() timing.
    let matched: PendingPairing | undefined;
    for (const p of this.pending.values()) {
      if (constantTimeEqual(p.code, code)) {
        matched = p;
        // do not break: keep the loop's iteration count constant.
      }
    }
    if (matched) {
      this.pending.delete(matched.code);
      return matched;
    }
    return undefined;
  }

  /** Test seam — drop everything (used by integration tests between cases). */
  clear(): void {
    this.pending.clear();
  }

  /** Test seam — current pending count. Optional `now` for deterministic sweep. */
  size(now: number = Date.now()): number {
    this.gc(now);
    return this.pending.size;
  }

  private gc(now: number = Date.now()): void {
    for (const [code, p] of this.pending) {
      if (p.expires_at <= now) this.pending.delete(code);
    }
  }
}
