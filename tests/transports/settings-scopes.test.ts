/**
 * Storm F2 — POST /dashboard/settings/scopes/:id/grant.
 *
 * Mirrors the /revoke test harness in tests/dashboard/settings.test.ts but
 * targets the new grant endpoint that backs the Pending Scopes UI panel.
 * The MCP `trust_scope_grant` tool keeps its gatedAction loop; this endpoint
 * IS the human-approval surface, so it flips proposed→active directly.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { EventStore } from '../../src/persistence.js';
import { Broker } from '../../src/broker.js';
import { mountTransports, type MountedTransports } from '../../src/transports.js';
import { TrustStore } from '../../src/trust/store.js';

interface Harness {
  store: EventStore;
  broker: Broker;
  trust: TrustStore;
  transports: MountedTransports;
  base: string;
}

async function boot(): Promise<Harness> {
  const store = new EventStore();
  store.init(':memory:');
  const broker = new Broker(store);
  const trust = new TrustStore(store);
  const transports = await mountTransports(broker, { mode: 'daemon', port: 0, silent: true });
  const addr = transports.httpServer!.address() as AddressInfo;
  return { store, broker, trust, transports, base: `http://127.0.0.1:${addr.port}` };
}

describe('Settings · trust scopes — POST /grant (Storm F2)', () => {
  let h: Harness;
  beforeEach(async () => { h = await boot(); });
  afterEach(async () => { await h.transports.shutdown(); });

  it('flips a proposed scope to active and emits trust_scope_granted', async () => {
    const scope = h.trust.createProposal({
      title: 'host-ops',
      description: 'allow host_exec for 15min',
      allowed_actions: [{ tool: 'host_exec' }],
      expires_after_actions: 20,
    });
    expect(scope.status).toBe('proposed');

    const r = await fetch(`${h.base}/dashboard/settings/scopes/${scope.id}/grant`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.scope.status).toBe('active');
    expect(body.scope.granted_by).toBe('dashboard-user');

    const after = h.trust.get(scope.id);
    expect(after?.status).toBe('active');

    const events = h.store.getEvents({ kinds: ['trust_scope_granted'] }).events;
    expect(events.length).toBe(1);
    const payload = events[0].payload as { scope_id: string; title: string; granted_by: string };
    expect(payload.scope_id).toBe(scope.id);
    expect(payload.title).toBe('host-ops');
    expect(payload.granted_by).toBe('dashboard-user');
  });

  it('returns 409 if the scope is already active', async () => {
    const scope = h.trust.createProposal({
      title: 't',
      description: 'd',
      allowed_actions: [{ tool: 'host_exec' }],
    });
    h.trust.grant(scope.id, 'someone-else');

    const r = await fetch(`${h.base}/dashboard/settings/scopes/${scope.id}/grant`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(r.status).toBe(409);
    const body = await r.json();
    expect(String(body.error)).toMatch(/not 'proposed'/);
    // No second granted event should have been emitted by our endpoint.
    const events = h.store.getEvents({ kinds: ['trust_scope_granted'] }).events;
    expect(events.length).toBe(0);
  });

  it('returns 404 for an unknown scope id', async () => {
    const r = await fetch(`${h.base}/dashboard/settings/scopes/ts-does-not-exist/grant`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(r.status).toBe(404);
  });
});
