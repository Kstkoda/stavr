/**
 * Home page tests — C2 acceptance.
 *
 * Two surfaces:
 *  - Unit: renderHomePage with a fabricated snapshot — asserts the four
 *    cards render, the profile badge wears the right colour, and the
 *    BOM mini-cards link to /dashboard/plans.
 *  - Integration: boot a daemon, seed a BOM + a decision, GET both
 *    /dashboard/home and /dashboard/home/data, assert the aggregator
 *    shape and the page reflects it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { EventStore } from '../../src/persistence.js';
import { Broker } from '../../src/broker.js';
import { mountTransports, type MountedTransports } from '../../src/transports.js';
import { renderHomePage, type HomeData } from '../../src/dashboard/pages/home.js';
import type { Bom } from '../../src/types/stavr-bom.js';

function bom(overrides: Partial<Bom> = {}): Bom {
  return {
    id: 'bom_test_' + Math.random().toString(36).slice(2, 8),
    goal: 'sample goal',
    requester: 'test',
    correlation_id: 'corr',
    status: 'proposed',
    active_version: 1,
    cost_estimate: 0.05,
    cost_max: 0.50,
    duration_sec: 60,
    cost_actual: 0,
    steps_done: 0,
    steps_total: 3,
    profile_mode: 'balanced',
    risk_envelope: ['read-only'],
    proposed_at: new Date().toISOString(),
    is_draft: false,
    ...overrides,
  };
}

function snapshot(over: Partial<HomeData> = {}): HomeData {
  return {
    health: {
      ok: true,
      version: '0.3.0',
      port: 7777,
      started_at: new Date().toISOString(),
      uptime_sec: 3661,
      connected_clients: 1,
      event_count: 42,
      active_scopes: 2,
      profile_mode: 'balanced',
      ...(over.health ?? {}),
    },
    boms: { recent: [], total: 0, open: 0, ...(over.boms ?? {}) },
    decisions: { recent: [], open: 0, ...(over.decisions ?? {}) },
  };
}

describe('Home page — unit', () => {
  it('renders all four cards with the supplied health data', () => {
    const html = renderHomePage(snapshot());
    expect(html).toContain('data-slot="health"');
    expect(html).toContain('data-slot="boms"');
    expect(html).toContain('data-slot="decisions"');
    expect(html).toContain('data-slot="actions"');
    expect(html).toContain('data-role="uptime"');
    expect(html).toContain('1h 1m'); // 3661s = 1h 1m
    expect(html).toContain('data-role="port"');
    expect(html).toContain('7777');
    expect(html).toContain('0.3.0');
  });

  it('renders the profile badge with the active-mode colour', () => {
    const turbo = renderHomePage(snapshot({ health: { ...snapshot().health, profile_mode: 'turbo' } }));
    expect(turbo).toContain('pill-profile-turbo');
    expect(turbo).toContain('>Turbo<');
    const eco = renderHomePage(snapshot({ health: { ...snapshot().health, profile_mode: 'eco' } }));
    expect(eco).toContain('pill-profile-eco');
    expect(eco).toContain('>Eco<');
    const balanced = renderHomePage(snapshot());
    expect(balanced).toContain('pill-profile-balanced');
  });

  it('links the profile badge to Settings', () => {
    const html = renderHomePage(snapshot());
    expect(html).toMatch(/<a href="\/dashboard\/settings"[^>]*class="profile-badge-link"/);
  });

  it('renders a food-label mini-card per recent BOM linking to /dashboard/plans', () => {
    const html = renderHomePage(snapshot({
      boms: {
        recent: [bom({ id: 'bom_a', goal: 'walk the dog', risk_envelope: ['write-local'] })],
        total: 1,
        open: 1,
      },
    }));
    expect(html).toContain('walk the dog');
    expect(html).toContain('href="/dashboard/plans#bom_a"');
    expect(html).toContain('Sonnet · Opus');
  });

  it('shows an empty state for BOMs when there are none', () => {
    const html = renderHomePage(snapshot());
    expect(html).toContain('No BOMs yet');
    expect(html).toContain('href="/dashboard/plans"');
  });

  it('renders quick actions for Plans, Decide, Topology, Settings', () => {
    const html = renderHomePage(snapshot());
    for (const path of ['/dashboard/plans', '/dashboard/decide', '/dashboard/topology', '/dashboard/settings']) {
      expect(html).toContain(`href="${path}"`);
    }
  });

  it('includes the SSE refresh script so live updates wire up', () => {
    const html = renderHomePage(snapshot());
    expect(html).toContain('/dashboard/home/data');
    expect(html).toContain('/dashboard/stream');
    expect(html).toContain('EventSource');
  });
});

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

describe('Home page — integration', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await boot();
  });

  afterEach(async () => {
    await h.transports.shutdown();
  });

  it('GET /dashboard/home/data aggregates health, boms, decisions', async () => {
    h.store.saveBom(bom({ id: 'bom_x', goal: 'do the thing' }));
    h.store.createDecision('dec_x', 'merge?', [{ id: 'y', label: 'Yes' }, { id: 'n', label: 'No' }], 120, 'n');
    const r = await fetch(`${h.base}/dashboard/home/data`);
    expect(r.status).toBe(200);
    const j = await r.json() as HomeData;
    expect(j.health.profile_mode).toBe('balanced');
    expect(j.health.version).toBeTruthy();
    expect(j.boms.total).toBe(1);
    expect(j.boms.recent[0].id).toBe('bom_x');
    expect(j.decisions.open).toBe(1);
    expect(j.decisions.recent[0].correlation_id).toBe('dec_x');
  });

  it('GET /dashboard/home renders the page with live aggregator data', async () => {
    h.store.saveBom(bom({ id: 'bom_y', goal: 'rotate the key', risk_envelope: ['credential'] }));
    const r = await fetch(`${h.base}/dashboard/home`);
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).toContain('rotate the key');
    expect(body).toContain('href="/dashboard/plans#bom_y"');
    expect(body).toContain('pill-profile-balanced');
    // Active scope count is the real value from the daemon ctx.
    expect(body).toContain('data-role="active-scopes"');
  });

  it('reflects the active profile mode in the page badge', async () => {
    h.store.setActiveProfileMode('turbo', 'test');
    const r = await fetch(`${h.base}/dashboard/home`);
    const body = await r.text();
    expect(body).toContain('pill-profile-turbo');
    expect(body).toContain('>Turbo<');
  });
});
