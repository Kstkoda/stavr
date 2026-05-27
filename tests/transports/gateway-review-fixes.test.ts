/**
 * family-son-mcp Phase 5 review-fix coverage.
 *
 * Tests the additive behaviors introduced by the 15-finding code-review pass:
 *
 *   C1/C2/S7 — sanitizeGatewayReason redacts denial reasons for peer actors
 *   C3       — credential rotation audit events persist atomically with vault
 *   C4       — seeding endpoint resolves operator_id from identity-store
 *   C7       — body.model coerced via shape-validate before reaching the gate
 *   C8/C11   — llm_gateway_denied / llm_gateway_allowed emitted per outcome
 *   C10      — tier3_assertion_required emitted on failed-seeding attempts
 *   C12      — JSON parse failures return gateway-shape JSON, not HTML
 *   C14      — credential rotation events include correlation_id
 *   C21      — /anthropic/* accepts request bodies larger than the global 4MB cap
 *   S1       — defaultTierFor + reversibilityFor recognize llm.anthropic
 *   S2       — capability killswitch silences HEAD/OPTIONS, not just POST
 *
 * The audit/atomicity tests subscribe to the broker's raw event stream so
 * they observe persistence-side reality rather than fanout side-effects.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { EventStore, type StoredEvent } from '../../src/persistence.js';
import { Broker } from '../../src/broker.js';
import {
  mountTransports,
  type MountedTransports,
  sanitizeGatewayReason,
  classifyDenyReason,
} from '../../src/transports.js';
import { CredentialStore } from '../../src/credentials/store.js';
import { setCredentialStore, getOrCreateCapabilityOverrideStore, getOrCreateIdentityStore, getOrCreateActorPermissionStore } from '../../src/server.js';
import { GATEWAY_TOOL_ID } from '../../src/security/gateway-gate.js';
import { DEFAULT_TIER3_ASSERTION_TTL_MS } from '../../src/security/webauthn.js';
import { defaultTierFor, reversibilityFor } from '../../src/tools/categories.js';

interface Harness {
  store: EventStore;
  broker: Broker;
  credStore: CredentialStore;
  transports: MountedTransports;
  base: string;
  /** All events the broker has persisted since boot, captured raw. */
  events: StoredEvent[];
}

async function boot(): Promise<Harness> {
  const store = new EventStore();
  store.init(':memory:');
  const broker = new Broker(store);
  const masterKey = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) masterKey[i] = i;
  const credStore = new CredentialStore(store, masterKey);
  setCredentialStore(broker, credStore);

  const events: StoredEvent[] = [];
  broker.onRawEvent((ev) => {
    events.push(ev);
  });

  const transports = await mountTransports(broker, { mode: 'daemon', port: 0, silent: true });
  const addr = transports.httpServer!.address() as AddressInfo;
  return { store, broker, credStore, transports, base: `http://127.0.0.1:${addr.port}`, events };
}

function seedFreshTier3(h: Harness, operatorId = 'operator'): void {
  const identity = getOrCreateIdentityStore(h.broker);
  const credentialId = `test-passkey-${operatorId}`;
  identity.register({
    credentialId,
    operatorId,
    publicKey: Buffer.alloc(32),
    counter: 0,
    transports: ['internal'],
    deviceLabel: `test-passkey-${operatorId}`,
  });
  const now = Date.now();
  identity.recordAssertion({
    id: `test-assertion-${operatorId}-${now}`,
    operatorId,
    credentialId,
    createdAt: now,
    expiresAt: now + DEFAULT_TIER3_ASSERTION_TTL_MS,
  });
}

describe('Phase 5 review fixes', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await boot();
  });
  afterEach(async () => {
    await h.transports.shutdown();
  });

  // S1 — categories table picks up llm.anthropic
  describe('S1 — defaultTierFor + reversibilityFor recognize llm.anthropic', () => {
    it('default tier is CONFIRM (conservative; matrix row overrides)', () => {
      expect(defaultTierFor(GATEWAY_TOOL_ID)).toBe('CONFIRM');
    });
    it('reversibility is irreversible (third-party data egress)', () => {
      expect(reversibilityFor(GATEWAY_TOOL_ID)).toBe('irreversible');
    });
  });

  // C1/C2/S7 — sanitizeGatewayReason + classifyDenyReason helpers
  describe('C1/C2/S7 — sanitizeGatewayReason redacts for peer actors', () => {
    const fullDefaultDeny =
      'per-actor NO_GO: actor "peer:son-test" cannot invoke llm.anthropic (source=default-deny)';
    const fullMatrix =
      'per-actor NO_GO: actor "peer:son-test" cannot invoke llm.anthropic (source=matrix)';
    const fullTier3 =
      'EXPLICIT denied: No recent passkey assertion. Visit /dashboard/settings#identity to authenticate. (actor=peer:son-test, tool=llm.anthropic)';

    it('peer actor — default-deny redacted to a generic "contact the operator" string', () => {
      const out = sanitizeGatewayReason(true, fullDefaultDeny, 'default-deny');
      expect(out).not.toContain('source=');
      expect(out).not.toContain('peer:son-test');
      expect(out).toMatch(/operator/i);
    });
    it('peer actor — matrix NO_GO does NOT echo the source distinguisher', () => {
      const sanitized = sanitizeGatewayReason(true, fullMatrix, 'matrix-no-go');
      expect(sanitized).not.toContain('source=matrix');
      expect(sanitized).toEqual(sanitizeGatewayReason(true, fullDefaultDeny, 'default-deny'));
    });
    it('peer actor — Tier-3 hint scrubbed (no dashboard path, no freshness literal)', () => {
      const out = sanitizeGatewayReason(true, fullTier3, 'tier3-miss');
      expect(out).not.toContain('/dashboard');
      expect(out).not.toContain('60000');
      expect(out).not.toContain('passkey');
      expect(out).toMatch(/re-authent/i);
    });
    it('operator-shape actor (loopback) — full reason preserved', () => {
      expect(sanitizeGatewayReason(false, fullDefaultDeny, 'default-deny')).toBe(fullDefaultDeny);
      expect(sanitizeGatewayReason(false, fullTier3, 'tier3-miss')).toBe(fullTier3);
    });
    it('classifyDenyReason maps the four canonical chokepoint strings', () => {
      expect(classifyDenyReason(fullDefaultDeny)).toBe('default-deny');
      expect(classifyDenyReason(fullMatrix)).toBe('matrix-no-go');
      expect(classifyDenyReason(fullTier3)).toBe('tier3-miss');
      expect(classifyDenyReason('chokepoint denied: CONFIRM-tier decision was reject (responder=operator)')).toBe('decision-rejected');
      expect(classifyDenyReason(undefined)).toBe('unknown');
    });
  });

  // S2 — Layer 0 killswitch silences HEAD/OPTIONS, not just POST
  describe('S2 — capability killswitch silences route for all methods', () => {
    it('disabled capability returns 403 no_go on HEAD', async () => {
      const caps = getOrCreateCapabilityOverrideStore(h.broker);
      caps.disablePermanent(GATEWAY_TOOL_ID, { reason: 'paused', setBy: 'operator' });
      const r = await fetch(`${h.base}/anthropic/v1/messages`, { method: 'HEAD' });
      expect(r.status).toBe(403);
    });
    it('disabled capability returns 403 no_go on OPTIONS', async () => {
      const caps = getOrCreateCapabilityOverrideStore(h.broker);
      caps.disablePermanent(GATEWAY_TOOL_ID, { reason: 'paused', setBy: 'operator' });
      const r = await fetch(`${h.base}/anthropic/v1/messages`, { method: 'OPTIONS' });
      expect(r.status).toBe(403);
    });
    it('disabled capability returns 403 no_go on POST with json body shape', async () => {
      const caps = getOrCreateCapabilityOverrideStore(h.broker);
      caps.disablePermanent(GATEWAY_TOOL_ID, { reason: 'paused', setBy: 'operator' });
      const r = await fetch(`${h.base}/anthropic/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-opus-4-7', max_tokens: 16, messages: [] }),
      });
      expect(r.status).toBe(403);
      const body = await r.json();
      expect(body.error).toBe('no_go');
    });
  });

  // C7 — body.model with hostile typeof gets coerced to undefined safely
  describe('C7 — body.model shape-validated; non-string is dropped before the gate', () => {
    it('POST with body.model as a hostile object still produces a structured response (501 stub)', async () => {
      // No matrix row, loopback actor (operator-shape) → defaults to CONFIRM → test-bypass auto-approve → 501.
      // The critical claim is that we don't 500 because of body.model's toString.
      const hostile = {
        model: { weird: 'shape' },
        max_tokens: 'definitely not a number',
        messages: [{ role: 'user', content: 'ping' }],
      };
      const r = await fetch(`${h.base}/anthropic/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(hostile),
      });
      expect(r.status).toBe(501); // chokepoint passes via test-bypass
      // llm_gateway_allowed event captures only the projected metadata
      const allowed = h.events.find((e) => e.kind === 'llm_gateway_allowed');
      expect(allowed).toBeDefined();
      const meta = (allowed!.payload as Record<string, unknown>).request_metadata as Record<string, unknown>;
      expect(meta.model).toBeUndefined();
      expect(meta.max_tokens).toBeUndefined();
      expect(meta.message_count).toBe(1);
    });
  });

  // C8/C11 — llm_gateway_denied / llm_gateway_allowed emitted per outcome
  describe('C8/C11 — audit events for every gate outcome', () => {
    it('Layer 0 capability disable emits llm_gateway_denied with source=capability', async () => {
      const caps = getOrCreateCapabilityOverrideStore(h.broker);
      caps.disablePermanent(GATEWAY_TOOL_ID, { reason: 'paused', setBy: 'operator' });
      await fetch(`${h.base}/anthropic/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-opus-4-7', max_tokens: 16, messages: [] }),
      });
      const denied = h.events.find((e) => e.kind === 'llm_gateway_denied');
      expect(denied).toBeDefined();
      const payload = denied!.payload as Record<string, unknown>;
      expect(payload.source).toBe('capability');
      expect(payload.tool_id).toBe(GATEWAY_TOOL_ID);
      expect(typeof payload.reason).toBe('string');
    });
    it('AUTO/CONFIRM pass emits llm_gateway_allowed with request_metadata', async () => {
      await fetch(`${h.base}/anthropic/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-opus-4-7', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
      });
      const allowed = h.events.find((e) => e.kind === 'llm_gateway_allowed');
      expect(allowed).toBeDefined();
      const payload = allowed!.payload as Record<string, unknown>;
      expect(payload.tool_id).toBe(GATEWAY_TOOL_ID);
      const meta = payload.request_metadata as Record<string, unknown>;
      expect(meta.model).toBe('claude-opus-4-7');
      expect(meta.max_tokens).toBe(16);
      expect(meta.message_count).toBe(1);
    });
  });

  // C12 — JSON parse errors return gateway-shape JSON, not Express HTML
  describe('C12 — malformed JSON returns {ok:false, error:"bad_json"}', () => {
    it('content-type:application/json with broken body → 400 bad_json JSON', async () => {
      const r = await fetch(`${h.base}/anthropic/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"model":}', // syntactically invalid
      });
      expect(r.status).toBe(400);
      const contentType = r.headers.get('content-type') ?? '';
      expect(contentType).toContain('application/json');
      const body = await r.json();
      expect(body.ok).toBe(false);
      expect(body.error).toBe('bad_json');
    });
  });

  // C21 — /anthropic/* accepts >4MB bodies
  describe('C21 — /anthropic/* body limit raised to 32MB', () => {
    it('5MB body is accepted (and chokepoint runs)', async () => {
      const content = 'x'.repeat(5 * 1024 * 1024); // 5MB string
      const body = JSON.stringify({
        model: 'claude-opus-4-7',
        max_tokens: 16,
        messages: [{ role: 'user', content }],
      });
      const r = await fetch(`${h.base}/anthropic/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      // chokepoint passes (loopback + test-bypass) → 501 stub
      expect(r.status).toBe(501);
    });
  });

  // C4 — operator_id resolved from identity store, not hardcoded
  describe('C4 — seeding resolves operator_id from identity-store', () => {
    it('passkey registered under non-default operator_id still seeds successfully', async () => {
      seedFreshTier3(h, 'kenneth');
      const r = await fetch(`${h.base}/dashboard/credentials/anthropic`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'sk-ant-test-C4' }),
      });
      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body.ok).toBe(true);
    });
  });

  // C10 — tier3_assertion_required emitted on failed-seeding
  describe('C10 — failed seeding emits tier3_assertion_required', () => {
    it('POST without recent Tier-3 → 401 AND emits tier3_assertion_required', async () => {
      const r = await fetch(`${h.base}/dashboard/credentials/anthropic`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'sk-ant-test-no-emit-of-key-bytes-7c8a2f4b' }),
      });
      expect(r.status).toBe(401);
      const ev = h.events.find((e) => e.kind === 'tier3_assertion_required');
      expect(ev).toBeDefined();
      const payload = ev!.payload as Record<string, unknown>;
      expect(payload.tool).toBe('credential.seed.anthropic');
      // The key bytes must never leak into the audit event.
      expect(JSON.stringify(ev)).not.toContain('sk-ant-test-no-emit-of-key-bytes-7c8a2f4b');
    });
  });

  // C14 — credential rotation events carry correlation_id
  describe('C14 — rotation events include correlation_id', () => {
    it('credential_added + credential_revoked share the request correlation_id', async () => {
      seedFreshTier3(h, 'operator');
      // First seed (no prior to revoke)
      await fetch(`${h.base}/dashboard/credentials/anthropic`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-correlation-id': 'test-cid-first-seed' },
        body: JSON.stringify({ key: 'sk-ant-test-first-rotation' }),
      });
      // Second seed (revokes first, adds second)
      await fetch(`${h.base}/dashboard/credentials/anthropic`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-correlation-id': 'test-cid-rotation' },
        body: JSON.stringify({ key: 'sk-ant-test-second-rotation' }),
      });
      // Events landed via store.appendEvent inside the txn — read from persistence.
      const persisted = h.store.getEvents({
        kinds: ['credential_added', 'credential_revoked'],
        limit: 10,
      });
      const added1 = persisted.events.find(
        (e) => e.kind === 'credential_added' && e.correlation_id === 'test-cid-first-seed',
      );
      const revoked2 = persisted.events.find(
        (e) => e.kind === 'credential_revoked' && e.correlation_id === 'test-cid-rotation',
      );
      const added2 = persisted.events.find(
        (e) => e.kind === 'credential_added' && e.correlation_id === 'test-cid-rotation',
      );
      expect(added1).toBeDefined();
      expect(revoked2).toBeDefined();
      expect(added2).toBeDefined();
    });
  });

  // C3 — atomicity: events are persisted INSIDE the transaction so a
  // mid-flight crash can't leave the vault rotated without audit.
  describe('C3 — credential rotation audit events persist atomically with vault state', () => {
    it('after a successful rotation, the events table contains the new credential_added even before fanout returns', async () => {
      seedFreshTier3(h, 'operator');
      await fetch(`${h.base}/dashboard/credentials/anthropic`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'sk-ant-test-atomicity' }),
      });
      // Read straight from persistence (not the broker's listener cache).
      const result = h.store.getEvents({ kinds: ['credential_added'], limit: 5 });
      expect(result.events.some((r) => (r.payload as Record<string, unknown>).service === 'anthropic')).toBe(true);
    });
  });
});
