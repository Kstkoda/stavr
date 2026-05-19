/**
 * tests/security/tier3-gate.test.ts
 *
 * Coverage for requireRecentTier3Assertion. The helper is the canonical
 * "is the operator fresh enough to do a Tier 3 action right now?" check
 * that any gate path can call.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { EventStore } from '../../src/persistence.js';
import { IdentityStore } from '../../src/security/identity-store.js';
import { requireRecentTier3Assertion } from '../../src/security/tier3-gate.js';

describe('requireRecentTier3Assertion', () => {
  let eventStore: EventStore;
  let identity: IdentityStore;

  beforeEach(() => {
    eventStore = new EventStore();
    eventStore.init(':memory:');
    identity = new IdentityStore(eventStore.rawDb);
    identity.register({
      credentialId: 'cred-a',
      operatorId: 'operator',
      publicKey: Buffer.from('pk', 'utf8'),
      counter: 0,
      transports: ['internal'],
    });
  });

  afterEach(() => {
    eventStore.close();
  });

  it('returns ok=false with no_recent_assertion when no assertions exist', () => {
    const r = requireRecentTier3Assertion(identity);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no_recent_assertion');
  });

  it('returns ok=true when an assertion within the window exists', () => {
    const now = Date.now();
    identity.recordAssertion({
      id: 'a1',
      operatorId: 'operator',
      credentialId: 'cred-a',
      createdAt: now - 1000,
      expiresAt: now + 60_000,
    });
    const r = requireRecentTier3Assertion(identity, { now });
    expect(r.ok).toBe(true);
  });

  it('returns ok=false past withinMs even if the assertion has not expired in DB', () => {
    const now = Date.now();
    // Recorded long ago but with a generous expiry — the gate's tighter
    // freshness rule still trips.
    identity.recordAssertion({
      id: 'a1',
      operatorId: 'operator',
      credentialId: 'cred-a',
      createdAt: now - 120_000,
      expiresAt: now + 60_000,
    });
    const r = requireRecentTier3Assertion(identity, { withinMs: 60_000, now });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no_recent_assertion');
  });

  it('correlationId match returns ok=true', () => {
    const now = Date.now();
    identity.recordAssertion({
      id: 'a1',
      operatorId: 'operator',
      credentialId: 'cred-a',
      correlationId: 'cid-X',
      createdAt: now,
      expiresAt: now + 60_000,
    });
    const r = requireRecentTier3Assertion(identity, { correlationId: 'cid-X', now });
    expect(r.ok).toBe(true);
  });

  it('correlationId mismatch returns ok=false with correlation_mismatch reason', () => {
    const now = Date.now();
    identity.recordAssertion({
      id: 'a1',
      operatorId: 'operator',
      credentialId: 'cred-a',
      correlationId: 'cid-X',
      createdAt: now,
      expiresAt: now + 60_000,
    });
    const r = requireRecentTier3Assertion(identity, { correlationId: 'cid-Y', now });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('correlation_mismatch');
  });

  it('uses the default operator id when not specified', () => {
    const now = Date.now();
    identity.recordAssertion({
      id: 'a1',
      operatorId: 'operator',
      credentialId: 'cred-a',
      createdAt: now,
      expiresAt: now + 60_000,
    });
    const r = requireRecentTier3Assertion(identity, { now });
    expect(r.ok).toBe(true);
  });

  it('honors a custom operator id', () => {
    const now = Date.now();
    identity.register({
      credentialId: 'son-cred',
      operatorId: 'son1',
      publicKey: Buffer.from('pk2', 'utf8'),
      counter: 0,
      transports: ['internal'],
    });
    identity.recordAssertion({
      id: 'son-a',
      operatorId: 'son1',
      credentialId: 'son-cred',
      createdAt: now,
      expiresAt: now + 60_000,
    });
    const r = requireRecentTier3Assertion(identity, { operatorId: 'son1', now });
    expect(r.ok).toBe(true);
    const r2 = requireRecentTier3Assertion(identity, { operatorId: 'operator', now });
    expect(r2.ok).toBe(false);
  });
});
