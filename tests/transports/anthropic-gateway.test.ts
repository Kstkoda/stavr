/**
 * family-son-mcp Phase 5 Phase 1 — Anthropic-API-compatible gateway stub.
 *
 * BOM: proposed/family-son-mcp-phase-5-llm-gateway-bom.md, Phase 1
 * deliverable. Tests cover:
 *
 *   - POST /anthropic/v1/messages → 501 stub with the documented JSON body
 *     shape, and the actor stamp set by the upstream middleware.
 *   - GET / PUT / DELETE on the same path → 405 with `Allow: POST`.
 *   - Mismatched subpath under /anthropic/* → 404 (Express default).
 *
 * The 401-unauthed / 401-revoked branches are covered by the pure
 * checkBearerAuth tests in `tests/auth-middleware.test.ts` (the global
 * middleware applies to every non-public path, so /anthropic/v1/messages
 * inherits the same gate). This file exercises the route handler itself
 * under the loopback-bypass path so the 501 shape is captured directly.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { EventStore } from '../../src/persistence.js';
import { Broker } from '../../src/broker.js';
import { mountTransports, type MountedTransports } from '../../src/transports.js';

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

describe('family-son-mcp Phase 5 P1 · /anthropic/v1/messages stub', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await boot();
  });
  afterEach(async () => {
    await h.transports.shutdown();
  });

  it('POST returns 501 with the documented stub body', async () => {
    const r = await fetch(`${h.base}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-4-7', max_tokens: 16, messages: [] }),
    });
    expect(r.status).toBe(501);
    const body = await r.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe('not_implemented');
    expect(body.phase).toBe('phase-1-stub');
    expect(typeof body.reason).toBe('string');
    expect(body.reason.length).toBeGreaterThan(0);
    // actor is stamped by the upstream middleware; loopback gets a
    // loopback:<corr-id> shape (corr-id is set by the correlation-id
    // middleware earlier in the stack), production peers get `peer:<name>`.
    expect(typeof body.actor).toBe('string');
    expect(body.actor.startsWith('loopback:') || body.actor === 'unknown').toBe(true);
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
