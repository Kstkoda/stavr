/**
 * C3 acceptance — Plans page food-label rebuild.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { EventStore } from '../../src/persistence.js';
import { Broker } from '../../src/broker.js';
import { mountTransports, type MountedTransports } from '../../src/transports.js';
import { renderPlansPage, type PlansData } from '../../src/dashboard/pages/plans.js';
import { splitEnvelope, WILL_ASK_RISKS } from '../../src/dashboard/adapters/bom.js';
import type { Bom } from '../../src/types/stavr-bom.js';

function bom(overrides: Partial<Bom> = {}): Bom {
  return {
    id: 'bom_' + Math.random().toString(36).slice(2, 10),
    goal: 'sample goal',
    requester: 'test',
    correlation_id: 'corr_' + Math.random().toString(36).slice(2, 8),
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

function snapshot(boms: Bom[]): PlansData {
  const totals = {
    proposed: 0, approved: 0, running: 0, done: 0,
    failed: 0, cancelled: 0, rejected: 0,
  };
  for (const b of boms) totals[b.status]++;
  return { boms, totals };
}

describe('Plans page — unit', () => {
  it('renders a food-label card per BOM', () => {
    const html = renderPlansPage(snapshot([
      bom({ id: 'bom_a', goal: 'walk the dog', risk_envelope: ['write-local'] }),
      bom({ id: 'bom_b', goal: 'rotate the key', risk_envelope: ['credential'] }),
    ]));
    expect(html).toContain('walk the dog');
    expect(html).toContain('rotate the key');
    expect(html).toContain('data-bom-id="bom_a"');
    expect(html).toContain('data-bom-id="bom_b"');
    // Status pill per row.
    expect(html.match(/pill-warning/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('shows the Allowed / Will-ask-first split per envelope', () => {
    const html = renderPlansPage(snapshot([
      bom({ id: 'bom_x', goal: 'mixed', risk_envelope: ['read-only', 'write-local', 'credential', 'destructive'] }),
    ]));
    expect(html).toContain('approved without re-prompt');
    expect(html).toContain('will ask before each');
    expect(html).toContain('>read-only<');
    expect(html).toContain('>write-local<');
    expect(html).toContain('>credential<');
    expect(html).toContain('>destructive<');
  });

  it('omits the will-ask line when the envelope has no high-risk classes', () => {
    const html = renderPlansPage(snapshot([
      bom({ id: 'safe', risk_envelope: ['read-only', 'write-local'] }),
    ]));
    expect(html).toContain('approved without re-prompt');
    expect(html).not.toContain('will ask before each');
  });

  it('omits the allowed line when every class is will-ask', () => {
    const html = renderPlansPage(snapshot([
      bom({ id: 'risky', risk_envelope: ['destructive', 'credential'] }),
    ]));
    expect(html).toContain('will ask before each');
    expect(html).not.toContain('approved without re-prompt');
  });

  it('renders an empty state when no BOMs are persisted', () => {
    const html = renderPlansPage(snapshot([]));
    expect(html).toContain('No BOMs yet');
  });

  it('exposes the live channel + plans/list URL for client refresh', () => {
    const html = renderPlansPage(snapshot([]));
    expect(html).toContain('/dashboard/stream');
    expect(html).toContain('/dashboard/plans/list');
    expect(html).toContain('EventSource');
  });

  it('emits filter chips for proposed/running by default plus any with hits', () => {
    const html = renderPlansPage(snapshot([
      bom({ status: 'running' }),
      bom({ status: 'done' }),
      bom({ status: 'failed' }),
    ]));
    expect(html).toContain('data-status="proposed"');
    expect(html).toContain('data-status="running"');
    expect(html).toContain('data-status="done"');
    expect(html).toContain('data-status="failed"');
  });
});

describe('splitEnvelope', () => {
  it('places destructive / financial / credential / external-comm in willAsk', () => {
    const split = splitEnvelope(['read-only', 'destructive', 'financial', 'write-local', 'credential', 'external-comm']);
    expect(split.allowed).toEqual(['read-only', 'write-local']);
    expect(split.willAsk).toEqual(['destructive', 'financial', 'credential', 'external-comm']);
  });

  it('WILL_ASK_RISKS exposes the four hot classes', () => {
    expect(WILL_ASK_RISKS.has('destructive')).toBe(true);
    expect(WILL_ASK_RISKS.has('credential')).toBe(true);
    expect(WILL_ASK_RISKS.has('financial')).toBe(true);
    expect(WILL_ASK_RISKS.has('external-comm')).toBe(true);
    expect(WILL_ASK_RISKS.has('read-only')).toBe(false);
    expect(WILL_ASK_RISKS.has('write-local')).toBe(false);
    expect(WILL_ASK_RISKS.has('execute')).toBe(false);
    expect(WILL_ASK_RISKS.has('write-remote')).toBe(false);
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

describe('Plans page — integration', () => {
  let h: Harness;

  beforeEach(async () => { h = await boot(); });
  afterEach(async () => { await h.transports.shutdown(); });

  it('GET /dashboard/plans renders persisted BOMs through the shell', async () => {
    h.store.saveBom(bom({ id: 'bom_int', goal: 'ship the feature', risk_envelope: ['write-local'] }));
    const r = await fetch(`${h.base}/dashboard/plans`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/text\/html/);
    const body = await r.text();
    expect(body).toContain('ship the feature');
    expect(body).toContain('data-bom-id="bom_int"');
    expect(body).toContain('data-page="plans"');
  });

  it('GET /dashboard/plans/list still returns the JSON shape (unchanged)', async () => {
    h.store.saveBom(bom({ id: 'bom_z' }));
    const r = await fetch(`${h.base}/dashboard/plans/list`);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(Array.isArray(j.boms)).toBe(true);
    expect(j.boms.find((b: Bom) => b.id === 'bom_z')).toBeTruthy();
  });

  it('POST /dashboard/plans/:id/respond still approves a BOM (unchanged)', async () => {
    h.store.saveBom(bom({ id: 'bom_appr', status: 'proposed' }));
    const r = await fetch(`${h.base}/dashboard/plans/bom_appr/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ verdict: 'approve' }),
    });
    expect(r.status).toBe(200);
    expect(h.store.getBom('bom_appr')?.status).toBe('approved');
  });
});
