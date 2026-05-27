/**
 * family-son-mcp Phase 5 — HTTP integration for the Anthropic gateway.
 *
 * Phase 1: route shell + 501 stub behind auth (committed 022a02b).
 * Phase 2: chokepoint integration — NO_GO → HTTP 403; post-gate stub
 *          stays 501 because forwarding lands in Phase 3.
 *
 * BOM: proposed/family-son-mcp-phase-5-llm-gateway-bom.md, Phases 1+2.
 *
 * In-process tests run over loopback. The actor-stamping middleware
 * sets `actor_id='loopback:<corr>'`, which is operator-shape — so the
 * default-deny path for peer actors is exercised by the unit tests in
 * `tests/security/gateway-gate.test.ts`. The HTTP 403 mapping is
 * verified here via a Layer 0 capability override deny, which fires
 * before any per-actor resolution.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { EventStore } from '../../src/persistence.js';
import { Broker } from '../../src/broker.js';
import { mountTransports, type MountedTransports } from '../../src/transports.js';
import { getOrCreateCapabilityOverrideStore } from '../../src/server.js';
import { GATEWAY_TOOL_ID } from '../../src/security/gateway-gate.js';

interface Harness {
  store: EventStore;
  broker: Broker;
  transports: MountedTransports;
  base: string;
}

async function boot(): Promise<Harness> {
  const store = new EventStore();
  store.init(':memory:');
  const broker = new Broker(store);
  const transports = await mountTransports(broker, { mode: 'daemon', port: 0, silent: true });
  const addr = transports.httpServer!.address() as AddressInfo;
  return { store, broker, transports, base: `http://127.0.0.1:${addr.port}` };
}

describe('family-son-mcp Phase 5 · /anthropic/v1/messages stub', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await boot();
  });
  afterEach(async () => {
    await h.transports.shutdown();
  });

  it('POST without a wired credential vault → 500 vault_unavailable (Phase 3b)', async () => {
    // Phase 3b — the 501 phase-2-stub is gone; the route reaches the
    // forward path immediately after the chokepoint. This harness does
    // not wire a credential store at all (production: daemon.ts does it
    // after master-key load), so the handler trips the vault-availability
    // check first. The companion test in tests/transports/gateway-forward
    // .test.ts wires a store and exercises the no_active_credential path
    // separately.
    const r = await fetch(`${h.base}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-4-7', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(r.status).toBe(500);
    const body = await r.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe('vault_unavailable');
  });

  it('Layer 0 capability disable → POST returns 403 no_go', async () => {
    const caps = getOrCreateCapabilityOverrideStore(h.broker);
    caps.disablePermanent(GATEWAY_TOOL_ID, {
      reason: 'operator killswitch — Anthropic gateway paused',
      setBy: 'operator',
    });

    const r = await fetch(`${h.base}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-4-7', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(r.status).toBe(403);
    const body = await r.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe('no_go');
    expect(body.tool_id).toBe(GATEWAY_TOOL_ID);
    expect(typeof body.actor).toBe('string');
    expect(typeof body.reason).toBe('string');
    expect(body.reason).toMatch(/killswitch|paused|disabled permanently/);
  });

  it('GET returns 405 with Allow: POST', async () => {
    const r = await fetch(`${h.base}/anthropic/v1/messages`, { method: 'GET' });
    expect(r.status).toBe(405);
    expect(r.headers.get('allow')).toBe('POST');
    const body = await r.json();
    expect(body).toEqual({
      ok: false,
      error: 'method_not_allowed',
      allowed_methods: ['POST'],
    });
  });

  it('PUT returns 405 with Allow: POST', async () => {
    const r = await fetch(`${h.base}/anthropic/v1/messages`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(r.status).toBe(405);
    expect(r.headers.get('allow')).toBe('POST');
  });

  it('DELETE returns 405 with Allow: POST', async () => {
    const r = await fetch(`${h.base}/anthropic/v1/messages`, { method: 'DELETE' });
    expect(r.status).toBe(405);
    expect(r.headers.get('allow')).toBe('POST');
  });

  it('unknown sub-path under /anthropic/ falls through to Express 404', async () => {
    const r = await fetch(`${h.base}/anthropic/v1/wrongpath`, { method: 'POST' });
    expect(r.status).toBe(404);
  });
});
