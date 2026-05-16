/**
 * C5 acceptance — Topology page.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { EventStore } from '../../src/persistence.js';
import { Broker } from '../../src/broker.js';
import { mountTransports, type MountedTransports } from '../../src/transports.js';
import { renderTopologyPage, type TopologyData } from '../../src/dashboard/pages/topology.js';
import { computeTopology } from '../../src/dashboard/adapters/topology.js';
import type { WorkerRecord } from '../../src/persistence.js';
import type { Bom } from '../../src/types/stavr-bom.js';

function worker(over: Partial<WorkerRecord> = {}): WorkerRecord {
  return {
    id: 'w_' + Math.random().toString(36).slice(2, 6),
    name: 'sample',
    type: 'cc',
    cwd: '/tmp/x',
    status: 'running',
    started_at: new Date().toISOString(),
    metadata: {},
    spawn_params_hash: 'hash',
    ...over,
  };
}

function bom(over: Partial<Bom> = {}): Bom {
  return {
    id: 'bom_' + Math.random().toString(36).slice(2, 6),
    goal: 'sample',
    requester: 'test',
    correlation_id: 'corr',
    status: 'running',
    active_version: 1,
    cost_estimate: 0.10,
    cost_max: 1.00,
    duration_sec: 60,
    cost_actual: 0,
    steps_done: 0,
    steps_total: 2,
    profile_mode: 'balanced',
    risk_envelope: ['write-local'],
    proposed_at: new Date().toISOString(),
    is_draft: false,
    ...over,
  };
}

function snapshot(over: Partial<TopologyData> = {}): TopologyData {
  return {
    workers: [],
    bricks: [],
    scopes: [],
    inFlightBoms: [],
    ...over,
  };
}

describe('computeTopology', () => {
  it('lays bricks above the bus and workers below, no overlap', () => {
    const layout = computeTopology({
      workers: [worker({ id: 'w1', name: 'cc-1' }), worker({ id: 'w2', name: 'cc-2' })],
      bricks: [
        { id: 'b1', kind: 'mcp', display_name: 'github', enabled: true },
        { id: 'b2', kind: 'http', display_name: 'webhook', enabled: true },
      ],
    });
    expect(layout.nodes.length).toBe(4);
    for (const n of layout.nodes) {
      if (n.position === 'above') expect(n.y).toBeLessThan(layout.steward.y);
      else expect(n.y).toBeGreaterThan(layout.steward.y);
    }
    // steward sits at exactly the bus row
    expect(layout.steward.y).toBe(250);
  });

  it('filters terminated workers older than a minute', () => {
    const old = worker({ id: 'old', status: 'terminated', ended_at: new Date(Date.now() - 120_000).toISOString() });
    const fresh = worker({ id: 'fresh', status: 'terminated', ended_at: new Date(Date.now() - 5_000).toISOString() });
    const live = worker({ id: 'live', status: 'running' });
    const layout = computeTopology({
      workers: [old, fresh, live],
      bricks: [],
    });
    const ids = new Set(layout.nodes.map((n) => n.id));
    expect(ids.has('old')).toBe(false);
    expect(ids.has('fresh')).toBe(true);
    expect(ids.has('live')).toBe(true);
  });

  it('skips disabled bricks', () => {
    const layout = computeTopology({
      workers: [],
      bricks: [
        { id: 'on',  kind: 'mcp', display_name: 'on',  enabled: true },
        { id: 'off', kind: 'mcp', display_name: 'off', enabled: false },
      ],
    });
    const ids = new Set(layout.nodes.map((n) => n.id));
    expect(ids.has('on')).toBe(true);
    expect(ids.has('off')).toBe(false);
  });
});

describe('Topology page — unit', () => {
  it('renders the daemon disc + this·port core label (v2)', () => {
    const html = renderTopologyPage(snapshot());
    // v2: core node carries the topo-daemon-disc marker and a
    // "this · 8421" subtitle. The v0.3/v8 "STAVR DAEMON" subtitle and
    // the structural topo-bus axis were removed per CLAUDE.md invariant #1.
    expect(html).toContain('topo-daemon-disc');
    expect(html).toContain('this · 8421');
    expect(html).not.toContain('STAVR DAEMON');
    expect(html).not.toContain('class="topo-bus"');
    expect(html).not.toContain('enterprise bus');
  });

  it('renders the v2 filter strip + palette door + legend + drawer', () => {
    const html = renderTopologyPage(snapshot());
    expect(html).toContain('ns-tabs');
    expect(html).toContain('type-chips');
    expect(html).toContain('palette-door');
    expect(html).toContain('class="parked"');
    expect(html).toContain('topo-legend');
    expect(html).toContain('data-role="topo-drawer"');
    expect(html).not.toContain('topo-mode-chips');
    expect(html).not.toContain('data-mode="radial"');
  });

  it('renders a node per worker tagged with started/ended-at for the scrubber', () => {
    const t0 = new Date('2030-01-01T00:00:00Z').toISOString();
    const html = renderTopologyPage(snapshot({
      workers: [worker({ id: 'w1', name: 'alpha', started_at: t0 })],
    }));
    expect(html).toContain('data-id="w1"');
    expect(html).toContain('data-layer="worker"');
    expect(html).toContain(`data-started-at="${Date.parse(t0)}"`);
  });

  it('renders an inspector + scrubber + bom sidebar', () => {
    const html = renderTopologyPage(snapshot({
      workers: [worker({ id: 'w1' })],
      inFlightBoms: [bom({ id: 'bom_1', goal: 'do it', scope_id: 'scope_a' })],
      scopes: [{ id: 'scope_a', title: 'release-cut' }],
    }));
    expect(html).toContain('id="inspector"');
    expect(html).toContain('class="scrubber-slider"');
    expect(html).toContain('In-flight BOMs');
    expect(html).toContain('release-cut');
    expect(html).toContain('do it');
  });

  it('shows an empty placeholder when no BOMs are in flight', () => {
    const html = renderTopologyPage(snapshot({
      workers: [worker({ id: 'w1' })],
    }));
    expect(html).toContain('Nothing running.');
  });

  it('wires SSE refresh on worker_/bom_step_/trust_scope_ events', () => {
    const html = renderTopologyPage(snapshot());
    expect(html).toContain('/dashboard/stream');
    expect(html).toContain('bom_step_');
    expect(html).toContain('worker_');
    expect(html).toContain('trust_scope_');
  });

  it('emits a roster row per worker with a status pill', () => {
    const html = renderTopologyPage(snapshot({
      workers: [
        worker({ id: 'w1', name: 'alpha', status: 'running' }),
        worker({ id: 'w2', name: 'beta',  status: 'idle' }),
      ],
    }));
    expect(html).toContain('Worker roster');
    expect(html).toContain('alpha');
    expect(html).toContain('beta');
    expect(html).toContain('pill-info');
    expect(html).toContain('pill-success');
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

describe('Topology page — integration', () => {
  let h: Harness;

  beforeEach(async () => { h = await boot(); });
  afterEach(async () => { await h.transports.shutdown(); });

  it('GET /dashboard/topology renders live workers through the shell', async () => {
    h.store.upsertWorker(worker({ id: 'w-live', name: 'cc-feat-1', status: 'running' }));
    const r = await fetch(`${h.base}/dashboard/topology`);
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).toContain('cc-feat-1');
    expect(body).toContain('data-id="w-live"');
    expect(body).toContain('data-page="topology"');
  });
});
