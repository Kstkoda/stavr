/**
 * tests/security/identity-store.test.ts
 *
 * v0.7 Phase 1 — coverage for the operator_credentials + tier3_assertions
 * tables. Schema lives in src/persistence.ts; this exercises the read /
 * write surface that security/webauthn.ts and the HTTP routes consume.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { EventStore } from '../../src/persistence.js';
import { IdentityStore } from '../../src/security/identity-store.js';

describe('IdentityStore', () => {
  let eventStore: EventStore;
  let identity: IdentityStore;

  beforeEach(() => {
    eventStore = new EventStore();
    eventStore.init(':memory:');
    identity = new IdentityStore(eventStore.rawDb);
  });

  afterEach(() => {
    eventStore.close();
  });

  function makeRegisterInput(overrides: Partial<Parameters<IdentityStore['register']>[0]> = {}) {
    return {
      credentialId: 'cred-abc',
      operatorId: 'operator',
      publicKey: Buffer.from('cose-public-key-bytes', 'utf8'),
      counter: 0,
      transports: ['internal', 'hybrid'],
      ...overrides,
    } as Parameters<IdentityStore['register']>[0];
  }

  it('register() persists the credential with all fields round-tripped', () => {
    const cred = identity.register(makeRegisterInput({ deviceLabel: 'Windows Hello' }));
    expect(cred.credential_id).toBe('cred-abc');
    expect(cred.operator_id).toBe('operator');
    expect(cred.public_key.toString('utf8')).toBe('cose-public-key-bytes');
    expect(cred.counter).toBe(0);
    expect(cred.transports).toEqual(['internal', 'hybrid']);
    expect(cred.device_label).toBe('Windows Hello');
    expect(cred.revoked_at).toBeNull();
    expect(cred.registered_at).toBeGreaterThan(0);
  });

  it('getById() returns undefined for unknown credential', () => {
    expect(identity.getById('never-registered')).toBeUndefined();
  });

  it('listForOperator() returns active credentials newest-first', async () => {
    identity.register(makeRegisterInput({ credentialId: 'cred-1' }));
    await new Promise((r) => setTimeout(r, 2));
    identity.register(makeRegisterInput({ credentialId: 'cred-2' }));
    const list = identity.listForOperator('operator');
    expect(list.map((c) => c.credential_id)).toEqual(['cred-2', 'cred-1']);
  });

  it('listForOperator() omits revoked by default', () => {
    identity.register(makeRegisterInput({ credentialId: 'cred-1' }));
    identity.register(makeRegisterInput({ credentialId: 'cred-2' }));
    identity.revoke('cred-1');
    const active = identity.listForOperator('operator');
    expect(active.map((c) => c.credential_id)).toEqual(['cred-2']);
    const all = identity.listForOperator('operator', { includeRevoked: true });
    expect(all.map((c) => c.credential_id).sort()).toEqual(['cred-1', 'cred-2']);
  });

  it('updateCounter() advances counter + sets last_used_at', async () => {
    identity.register(makeRegisterInput({ counter: 5 }));
    const before = identity.getById('cred-abc')!;
    expect(before.counter).toBe(5);
    expect(before.last_used_at).toBeNull();
    await new Promise((r) => setTimeout(r, 2));
    identity.updateCounter('cred-abc', 7);
    const after = identity.getById('cred-abc')!;
    expect(after.counter).toBe(7);
    expect(after.last_used_at).toBeGreaterThan(0);
  });

  it('revoke() marks credential and excludes it from active listings', () => {
    identity.register(makeRegisterInput());
    identity.revoke('cred-abc');
    const direct = identity.getById('cred-abc');
    expect(direct?.revoked_at).not.toBeNull();
    expect(identity.listForOperator('operator')).toEqual([]);
  });

  it('recordAssertion() + hasRecentAssertion() returns the latest within window', () => {
    identity.register(makeRegisterInput());
    const now = Date.now();
    identity.recordAssertion({
      id: 'a1',
      operatorId: 'operator',
      credentialId: 'cred-abc',
      createdAt: now,
      expiresAt: now + 60_000,
    });
    const found = identity.hasRecentAssertion({ operatorId: 'operator', now: now + 10_000 });
    expect(found?.id).toBe('a1');
  });

  it('hasRecentAssertion() returns undefined past expiry', () => {
    identity.register(makeRegisterInput());
    const now = Date.now();
    identity.recordAssertion({
      id: 'a1',
      operatorId: 'operator',
      credentialId: 'cred-abc',
      createdAt: now,
      expiresAt: now + 60_000,
    });
    const found = identity.hasRecentAssertion({ operatorId: 'operator', now: now + 70_000 });
    expect(found).toBeUndefined();
  });

  it('hasRecentAssertion() with correlation_id filters by cid', () => {
    identity.register(makeRegisterInput());
    const now = Date.now();
    identity.recordAssertion({
      id: 'a1',
      operatorId: 'operator',
      credentialId: 'cred-abc',
      correlationId: 'cid-X',
      createdAt: now,
      expiresAt: now + 60_000,
    });
    expect(
      identity.hasRecentAssertion({
        operatorId: 'operator',
        correlationId: 'cid-X',
        now: now + 1000,
      })?.id,
    ).toBe('a1');
    expect(
      identity.hasRecentAssertion({
        operatorId: 'operator',
        correlationId: 'cid-Y',
        now: now + 1000,
      }),
    ).toBeUndefined();
  });

  it('sweepExpiredAssertions() drops only expired rows', () => {
    identity.register(makeRegisterInput());
    const now = Date.now();
    identity.recordAssertion({
      id: 'fresh',
      operatorId: 'operator',
      credentialId: 'cred-abc',
      createdAt: now,
      expiresAt: now + 60_000,
    });
    identity.recordAssertion({
      id: 'stale',
      operatorId: 'operator',
      credentialId: 'cred-abc',
      createdAt: now - 200_000,
      expiresAt: now - 100_000,
    });
    expect(identity.sweepExpiredAssertions(now)).toBe(1);
    // Fresh row still visible
    expect(identity.hasRecentAssertion({ operatorId: 'operator', now })?.id).toBe('fresh');
  });

  it('knownOperators() returns distinct active operator ids', () => {
    identity.register(makeRegisterInput({ credentialId: 'c1', operatorId: 'kenneth' }));
    identity.register(makeRegisterInput({ credentialId: 'c2', operatorId: 'kenneth' }));
    identity.register(makeRegisterInput({ credentialId: 'c3', operatorId: 'son1' }));
    identity.revoke('c1');
    identity.revoke('c2');
    expect(identity.knownOperators().sort()).toEqual(['son1']);
    identity.register(makeRegisterInput({ credentialId: 'c4', operatorId: 'kenneth' }));
    expect(identity.knownOperators().sort()).toEqual(['kenneth', 'son1']);
  });
});
