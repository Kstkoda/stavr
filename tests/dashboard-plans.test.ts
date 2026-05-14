// tests/dashboard-plans.test.ts
//
// HTTP surface tests for /dashboard/plans* routes.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { EventStore } from '../src/persistence.js';
import { Broker } from '../src/broker.js';
import { mountTransports, type MountedTransports } from '../src/transports.js';
import type { Bom, BomStep } from '../src/types/stavr-bom.js';

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

function makeBom(overrides: Partial<Bom> = {}): Bom {
  return {
    id: 'bom_test_' + Math.random().toString(36).slice(2, 8),
    goal: 'test goal',
    requester: 'corr',
    correlation_id: 'corr',
    status: 'proposed',
    active_version: 1,
    cost_estimate: 0.01,
    cost_max: 0.05,
    duration_sec: 60,
    cost_actual: 0,
    steps_done: 0,
    steps_total: 1,
    profile_mode: 'balanced',
    risk_envelope: ['read-only'],
    proposed_at: new Date().toISOString(),
    is_draft: false,
    ...overrides,
  };
}

function makeStep(stepNo: number, overrides: Partial<BomStep> = {}): BomStep {
  return {
    step_no: stepNo,
    title: `step ${stepNo}`,
    capability: 'reading',
    risk_class: 'read-only',
    brick_id: 'files',
    model: 'claude-haiku-4-5',
    cost_estimate: 0.001,
    duration_sec_est: 10,
    depends_on: [],
    ...overrides,
  };
}

describe('/dashboard/plans', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await boot();
  });

  afterEach(async () => {
    await h.transports.shutdown();
  });

  it('GET /dashboard/plans serves an HTML page', async () => {
    const res = await fetch(`${h.base}/dashboard/plans`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toMatch(/Stavr — Plans/);
  });

  it('GET /dashboard/plans/list returns persisted BOMs', async () => {
    const bom = makeBom({ goal: 'walk the dog' });
    h.store.saveBom(bom);

    const res = await fetch(`${h.base}/dashboard/plans/list`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { boms: Bom[] };
    expect(body.boms.find((b) => b.id === bom.id)?.goal).toBe('walk the dog');
  });

  it('GET /dashboard/plans/:bomId returns bom + steps', async () => {
    const bom = makeBom();
    h.store.saveBom(bom);
    h.store.saveBomVersion({
      bom_id: bom.id,
      version: 1,
      reason: 'initial',
      steps: [makeStep(1)],
      planner_model: 'claude-sonnet-4-6',
      planner_cost: 0.001,
      created_at: bom.proposed_at,
    });
    h.store.saveBomSteps(bom.id, 1, [makeStep(1)]);

    const res = await fetch(`${h.base}/dashboard/plans/${bom.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { bom: Bom; steps: Array<BomStep & { status: string }> };
    expect(body.bom.id).toBe(bom.id);
    expect(body.steps.length).toBe(1);
    expect(body.steps[0].status).toBe('pending');
  });

  it('POST /dashboard/plans/:bomId/respond approve emits bom_approved', async () => {
    const bom = makeBom();
    h.store.saveBom(bom);

    const seen: string[] = [];
    h.broker.onEvent((ev) => seen.push(ev.kind));

    const res = await fetch(`${h.base}/dashboard/plans/${bom.id}/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ verdict: 'approve' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; status: string };
    expect(body.status).toBe('approved');
    // Allow event fanout to flush.
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toContain('bom_approved');
    expect(h.store.getBom(bom.id)?.status).toBe('approved');
  });

  it('POST /dashboard/plans/:bomId/respond reject moves bom to rejected', async () => {
    const bom = makeBom();
    h.store.saveBom(bom);
    const res = await fetch(`${h.base}/dashboard/plans/${bom.id}/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ verdict: 'reject' }),
    });
    expect(res.status).toBe(200);
    expect(h.store.getBom(bom.id)?.status).toBe('rejected');
  });

  it('POST /dashboard/plans/:bomId/respond rejects bad verdict', async () => {
    const bom = makeBom();
    h.store.saveBom(bom);
    const res = await fetch(`${h.base}/dashboard/plans/${bom.id}/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ verdict: 'maybe' }),
    });
    expect(res.status).toBe(400);
  });
});
