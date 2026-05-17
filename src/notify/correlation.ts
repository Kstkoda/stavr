// v0.6 — correlation_id minting + HMAC verification.
//
// A correlation_id binds a notification to its inbound replies. The signed form
// is base64url(payload).base64url(sig) where payload = `${random}.${expires_ms}`
// and sig = HMAC-SHA256(secret, payload). Operator rotates the secret via env;
// old correlation_ids become unverifiable on next daemon start.
//
// Why GET-friendly: ntfy.sh and email reply links are clicked from a browser, so
// the cid lives in the query string. One-shot consumption + 5-min TTL bound the
// blast radius (see Footgun #4 in proposed/v0_6-notifications-bom.md).

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const DEFAULT_TTL_MS = 5 * 60 * 1000;

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromB64url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

export interface MintedCorrelation {
  /** Stable opaque id used as DB key (also the random portion of the signed cid). */
  id: string;
  /** Signed, URL-safe token to put in reply links / button callback_data. */
  signedCid: string;
  /** Absolute expiry timestamp in ms since epoch. */
  expiresAt: number;
}

export function mintCorrelationId(opts: { secret: string; ttlMs?: number }): MintedCorrelation {
  if (!opts.secret) throw new Error('correlation secret required');
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const id = randomBytes(16).toString('hex');
  const expiresAt = Date.now() + ttl;
  const payload = `${id}.${expiresAt}`;
  const sig = createHmac('sha256', opts.secret).update(payload).digest();
  const signedCid = `${b64url(Buffer.from(payload))}.${b64url(sig)}`;
  return { id, signedCid, expiresAt };
}

export type VerifyResult =
  | { ok: true; id: string; expiresAt: number }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired'; id?: string; expiresAt?: number };

export function verifyCorrelationId(signedCid: string, secret: string): VerifyResult {
  if (!signedCid || !secret) return { ok: false, reason: 'malformed' };
  const parts = signedCid.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };
  let payloadBuf: Buffer;
  let sigBuf: Buffer;
  try {
    payloadBuf = fromB64url(parts[0]);
    sigBuf = fromB64url(parts[1]);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const expectedSig = createHmac('sha256', secret).update(payloadBuf).digest();
  if (sigBuf.length !== expectedSig.length) return { ok: false, reason: 'bad_signature' };
  if (!timingSafeEqual(sigBuf, expectedSig)) return { ok: false, reason: 'bad_signature' };
  const payload = payloadBuf.toString('utf8');
  const sep = payload.indexOf('.');
  if (sep === -1) return { ok: false, reason: 'malformed' };
  const id = payload.slice(0, sep);
  const expiresAt = Number(payload.slice(sep + 1));
  if (!Number.isFinite(expiresAt)) return { ok: false, reason: 'malformed' };
  if (Date.now() > expiresAt) return { ok: false, reason: 'expired', id, expiresAt };
  return { ok: true, id, expiresAt };
}
