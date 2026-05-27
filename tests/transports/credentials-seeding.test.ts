/**
 * family-son-mcp Phase 5 P3a — Anthropic-key seeding endpoint.
 *
 * BOM proposed/family-son-mcp-phase-5-llm-gateway-bom.md, Phase 3 entry,
 * F5 decision (Finalist A + Tier-3 gate, operator-locked 2026-05-27).
 *
 * Tests cover the three smokes the operator named:
 *
 *   1. POST without recent Tier-3 → refused with clear pointer to
 *      re-authenticate.
 *   2. POST with recent Tier-3 → seeded, vault contains the key (verified
 *      via credStore.decryptForUse() against the returned credential_id,
 *      NOT via inspecting disk).
 *   3. The seeding-success response body grep'd for the key bytes →
 *      zero matches.
 *
 * Plus rotation and the negative-path returns for bad bodies / no vault.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { EventStore } from '../../src/persistence.js';
import { Broker } from '../../src/broker.js';
import { mountTransports, type MountedTransports } from '../../src/transports.js';
import { CredentialStore } from '../../src/credentials/store.js';
import { setCredentialStore, getOrCreateIdentityStore } from '../../src/server.js';
import { DEFAULT_TIER3_ASSERTION_TTL_MS } from '../../src/security/webauthn.js';

interface Harness {
  store: EventStore;
  broker: Broker;
  credStore?: CredentialStore;
  masterKey: Buffer;
  transports: MountedTransports;
  base: string;
}

async function boot(opts: { withVault?: boolean } = { withVault: true }): Promise<Harness> {
  const store = new EventStore();
  store.init(':memory:');
  const broker = new Broker(store);

  // Deterministic 32-byte master key for AES-256-GCM. Tests should NEVER
  // touch the real OS keychain — see tests/credentials/vault.test.ts for
  // the canonical pattern.
  const masterKey = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) masterKey[i] = i;

  let credStore: CredentialStore | undefined;
  if (opts.withVault !== false) {
    credStore = new CredentialStore(store, masterKey);
    setCredentialStore(broker, credStore);
  }

  const transports = await mountTransports(broker, { mode: 'daemon', port: 0, silent: true });
  const addr = transports.httpServer!.address() as AddressInfo;
  return { store, broker, credStore, masterKey, transports, base: `http://127.0.0.1:${addr.port}` };
}

/** Inject a fresh Tier-3 assertion into the identity store. Equivalent
 *  to the operator having just completed a WebAuthn ceremony.
 *  tier3_assertions.credential_id has a FK to operator_credentials, so we
 *  register a stub passkey first. */
function seedFreshTier3(h: Harness): void {
  const identity = getOrCreateIdentityStore(h.broker);
  const credentialId = 'test-passkey-credential-id';
  identity.register({
    credentialId,
    operatorId: 'operator',
    publicKey: Buffer.alloc(32),
    counter: 0,
    transports: ['internal'],
    deviceLabel: 'test-passkey',
  });
  const now = Date.now();
  identity.recordAssertion({
    id: `test-assertion-${now}`,
    operatorId: 'operator',
    credentialId,
    createdAt: now,
    expiresAt: now + DEFAULT_TIER3_ASSERTION_TTL_MS,
  });
}

describe('family-son-mcp Phase 5 P3a · POST /dashboard/credentials/anthropic', () => {
  let h: Harness;
  afterEach(async () => {
    if (h) await h.transports.shutdown();
  });

  it('REFUSAL — POST without a recent Tier-3 assertion → 401 tier3_required with re-auth pointer', async () => {
    h = await boot();
    const r = await fetch(`${h.base}/dashboard/credentials/anthropic`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'sk-ant-test-key-NEVER-LOGGED' }),
    });
    expect(r.status).toBe(401);
    const body = await r.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe('tier3_required');
    expect(typeof body.reason).toBe('string');
    expect(typeof body.hint).toBe('string');
    // The hint points the operator at /dashboard/settings#identity per
    // tier3-gate.ts; assert it contains a clear re-authentication action.
    expect(body.hint).toMatch(/passkey|assertion|re-auth|authenticat/i);
    expect(body.operator_id).toBe('operator');
  });

  it('SEEDED — POST with fresh Tier-3 → 200 + vault contains the key (verified via decryptForUse)', async () => {
    h = await boot();
    seedFreshTier3(h);
    const SECRET = 'sk-ant-test-PHASE3A-VERIFY-VIA-VAULT-9b8c7a';
    const r = await fetch(`${h.base}/dashboard/credentials/anthropic`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: SECRET }),
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(typeof body.credential_id).toBe('string');
    expect(body.credential_id.length).toBeGreaterThan(0);
    expect(typeof body.seeded_at).toBe('string');
    expect(body.rotated).toBe(false);

    // Vault read — NOT disk inspection. decryptForUse returns the plaintext
    // we wrote, proving it round-tripped through the encrypted blob.
    const decrypted = h.credStore!.decryptForUse(body.credential_id);
    expect(decrypted.plaintext).toBe(SECRET);
  });

  it('NO KEY BYTES IN RESPONSE — the success response body must not contain the key value', async () => {
    h = await boot();
    seedFreshTier3(h);
    const SECRET = 'sk-ant-test-PHASE3A-NO-ECHO-deadbeef0123456789';
    const r = await fetch(`${h.base}/dashboard/credentials/anthropic`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: SECRET }),
    });
    expect(r.status).toBe(200);
    // Read the response as the raw byte stream + as text. Grep both for
    // the key bytes — zero matches is the acceptance.
    const text = await r.text();
    expect(text.includes(SECRET)).toBe(false);
    // Defensive: also reject any 8-byte prefix appearing on its own.
    expect(text.includes(SECRET.slice(0, 8))).toBe(false);
  });

  it('ROTATION — a second seed revokes the first; only the new credential is active', async () => {
    h = await boot();
    seedFreshTier3(h);
    const FIRST = 'sk-ant-first-key-aaaa1111';
    const r1 = await fetch(`${h.base}/dashboard/credentials/anthropic`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: FIRST }),
    });
    const body1 = await r1.json();
    expect(r1.status).toBe(200);
    expect(body1.rotated).toBe(false);
    const firstId = body1.credential_id;

    // Tier-3 assertion is consumed-once? No — hasRecentAssertion just
    // queries the freshness window; re-using the same assertion within
    // the 60s window is fine. Real operator UX would also stay within
    // the window for a one-step rotation.
    const SECOND = 'sk-ant-second-key-bbbb2222';
    const r2 = await fetch(`${h.base}/dashboard/credentials/anthropic`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: SECOND }),
    });
    const body2 = await r2.json();
    expect(r2.status).toBe(200);
    expect(body2.rotated).toBe(true);
    expect(body2.credential_id).not.toBe(firstId);

    // First row revoked, second active.
    const activeRows = h.credStore!.list({ service: 'anthropic' });
    expect(activeRows).toHaveLength(1);
    expect(activeRows[0].id).toBe(body2.credential_id);
    // Including revoked, both rows exist.
    const allRows = h.credStore!.list({ service: 'anthropic', includeRevoked: true });
    expect(allRows).toHaveLength(2);
    expect(allRows.some((r) => r.id === firstId && r.revoked_at)).toBe(true);
    // And the new vault decrypt returns the second key.
    expect(h.credStore!.decryptForUse(body2.credential_id).plaintext).toBe(SECOND);
  });

  it('BAD BODY — missing/empty body.key → 400 bad_request', async () => {
    h = await boot();
    seedFreshTier3(h);

    const r1 = await fetch(`${h.base}/dashboard/credentials/anthropic`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(r1.status).toBe(400);
    expect((await r1.json()).error).toBe('bad_request');

    const r2 = await fetch(`${h.base}/dashboard/credentials/anthropic`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: '   ' }),
    });
    expect(r2.status).toBe(400);
    expect((await r2.json()).error).toBe('bad_request');
  });

  it('VAULT UNAVAILABLE — credential store not initialised → 500 vault_unavailable', async () => {
    h = await boot({ withVault: false });
    seedFreshTier3(h);
    const r = await fetch(`${h.base}/dashboard/credentials/anthropic`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'sk-ant-test' }),
    });
    expect(r.status).toBe(500);
    const body = await r.json();
    expect(body.error).toBe('vault_unavailable');
  });
});
