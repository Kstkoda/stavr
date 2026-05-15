/**
 * C10 e2e — visit every dashboard page through a real daemon and
 * assert the shell + active-page contract holds end-to-end.
 *
 * Each page is exercised via fetch against the http server: 200 status,
 * text/html content-type, expected nav state, expected page-specific
 * marker. This is the canary that catches regressions when one page's
 * refactor breaks the shell or another page's render.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { EventStore } from '../../src/persistence.js';
import { Broker } from '../../src/broker.js';
import { mountTransports, type MountedTransports } from '../../src/transports.js';
import { NAV_ENTRIES } from '../../src/dashboard/shell.js';

let store: EventStore;
let broker: Broker;
let transports: MountedTransports;
let base: string;

beforeAll(async () => {
  store = new EventStore();
  store.init(':memory:');
  broker = new Broker(store);
  // Seed some state so every page has something to render.
  store.upsertWorker({
    id: 'w-e2e',
    name: 'cc-e2e',
    type: 'cc',
    cwd: '/tmp',
    status: 'running',
    started_at: new Date().toISOString(),
    metadata: {},
    spawn_params_hash: 'h',
  });
  store.saveBom({
    id: 'bom_e2e',
    goal: 'e2e seed',
    requester: 'test',
    correlation_id: 'c1',
    status: 'proposed',
    active_version: 1,
    cost_estimate: 0.05,
    cost_max: 0.50,
    duration_sec: 60,
    cost_actual: 0,
    steps_done: 0,
    steps_total: 1,
    profile_mode: 'balanced',
    risk_envelope: ['write-local'],
    proposed_at: new Date().toISOString(),
    is_draft: false,
  });
  store.createDecision('dec_e2e', 'merge?', [
    { id: 'yes', label: 'Yes' },
    { id: 'no',  label: 'No' },
  ], 300, 'no');
  transports = await mountTransports(broker, { mode: 'daemon', port: 0, silent: true });
  const addr = transports.httpServer!.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await transports.shutdown();
});

describe('Dashboard e2e — every page reachable + shell intact', () => {
  it('GET /dashboard redirects to /dashboard/home', async () => {
    const r = await fetch(`${base}/dashboard`, { redirect: 'manual' });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/dashboard/home');
  });

  for (const entry of NAV_ENTRIES) {
    it(`GET ${entry.href} renders the shared shell with ${entry.id} active`, async () => {
      const r = await fetch(`${base}${entry.href}`);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toMatch(/text\/html/);
      const body = await r.text();
      // Shell tokens present.
      expect(body).toContain('--bg-base:        #0a0a0f;');
      // Inspector skeleton from the shell.
      expect(body).toContain('id="inspector"');
      // Active page highlighted.
      expect(body).toMatch(new RegExp(`data-page="${entry.id}"\\s+aria-current="page"`));
      // Every other nav entry present but not active.
      for (const other of NAV_ENTRIES) {
        if (other.id === entry.id) continue;
        expect(body).toContain(`href="${other.href}"`);
        expect(body).not.toMatch(new RegExp(`data-page="${other.id}"\\s+aria-current="page"`));
      }
    });
  }

  it('seeded data surfaces on the pages that look for it', async () => {
    const home = await (await fetch(`${base}/dashboard/home`)).text();
    expect(home).toContain('e2e seed');
    const plans = await (await fetch(`${base}/dashboard/plans`)).text();
    expect(plans).toContain('e2e seed');
    const decide = await (await fetch(`${base}/dashboard/decide`)).text();
    expect(decide).toContain('merge?');
    const topology = await (await fetch(`${base}/dashboard/topology`)).text();
    expect(topology).toContain('cc-e2e');
    const streams = await (await fetch(`${base}/dashboard/streams`)).text();
    expect(streams).toContain('cc-e2e');
  });

  it('shell carries ARIA landmarks on every page', async () => {
    const r = await fetch(`${base}/dashboard/home`);
    const body = await r.text();
    expect(body).toContain('role="navigation"');
    expect(body).toContain('role="main"');
    expect(body).toContain('aria-label="Primary"');
  });
});
