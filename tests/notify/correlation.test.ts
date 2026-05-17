import { describe, expect, it } from 'vitest';
import { mintCorrelationId, verifyCorrelationId } from '../../src/notify/correlation.js';

describe('v0.6 correlation_id mint + verify', () => {
  const secret = 'unit-test-secret-do-not-use-in-prod';

  it('round-trips a freshly minted correlation_id', () => {
    const minted = mintCorrelationId({ secret, ttlMs: 60_000 });
    const result = verifyCorrelationId(minted.signedCid, secret);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.id).toBe(minted.id);
      expect(result.expiresAt).toBe(minted.expiresAt);
    }
  });

  it('rejects a tampered payload (different secret)', () => {
    const minted = mintCorrelationId({ secret, ttlMs: 60_000 });
    const result = verifyCorrelationId(minted.signedCid, 'wrong-secret');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad_signature');
  });

  it('rejects a tampered payload (modified body)', () => {
    const minted = mintCorrelationId({ secret, ttlMs: 60_000 });
    const [payload, sig] = minted.signedCid.split('.');
    const tampered = `${payload.slice(0, -2)}AB.${sig}`;
    const result = verifyCorrelationId(tampered, secret);
    expect(result.ok).toBe(false);
  });

  it('rejects malformed tokens', () => {
    expect(verifyCorrelationId('not-a-token', secret).ok).toBe(false);
    expect(verifyCorrelationId('', secret).ok).toBe(false);
    expect(verifyCorrelationId('a.b.c', secret).ok).toBe(false);
  });

  it('rejects expired tokens', () => {
    const minted = mintCorrelationId({ secret, ttlMs: -1000 });
    const result = verifyCorrelationId(minted.signedCid, secret);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('expired');
  });

  it('produces unique ids across mints', () => {
    const a = mintCorrelationId({ secret });
    const b = mintCorrelationId({ secret });
    expect(a.id).not.toBe(b.id);
    expect(a.signedCid).not.toBe(b.signedCid);
  });
});
