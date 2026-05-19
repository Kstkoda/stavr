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
    // Default snapshot has no port → renderer falls back to 7777 (the
    // stavr CLI default in src/cli.ts:90).
    const html = renderTopologyPage(snapshot());
    expect(html).toContain('topo-daemon-disc');
    expect(html).toContain('this · 7777');
    expect(html).not.toContain('STAVR DAEMON');
    expect(html).not.toContain('this · 8421'); // the mockup's illustrative port
    expect(html).not.toContain('class="topo-bus"');
    expect(html).not.toContain('enterprise bus');
  });

  it('plumbs a live daemon port from TopologyData into the core label', () => {
    const html = renderTopologyPage(snapshot({ port: 9876 }));
    expect(html).toContain('this · 9876');
    expect(html).not.toContain('this · 7777');
  });

  it('renders the v2 filter strip + palette door + legend + drawer', () => {
    const html = renderTopologyPage(snapshot());
    expect(html).toContain('ns-tabs');
    expect(html).toContain('type-chips');
    expect(html).toContain('palette-door');
    // v0.6 Task 4 Phase C #4 — Add + Edit FAB buttons were parked with
    // a v0.7 badge but never delivered functionality; hidden until v0.7
    // actually ships those affordances. Reset stays as the operator-
    // facing primary action.
    expect(html).toContain('data-role="topo-reset"');
    expect(html).not.toContain('class="parked"');
    expect(html).toContain('topo-legend');
    expect(html).toContain('data-role="topo-drawer"');
    expect(html).not.toContain('topo-mode-chips');
    expect(html).not.toContain('data-mode="radial"');
  });

  // v0.6 Task 4 Phase C #7 — Ctrl+K collides with browser omnibox.
  // The label now renders `/` for non-Mac platforms (visible by default)
  // and ⌘K hidden behind `kbd-mac` (the page JS unhides it on macOS).
  it('renders platform-aware keyboard hints (/ visible on non-Mac, ⌘K behind kbd-mac)', () => {
    const html = renderTopologyPage(snapshot());
    expect(html).toContain('data-role="topo-search-shortcut"');
    expect(html).toContain('class="kbd kbd-other">/');
    expect(html).toContain('class="kbd kbd-mac" hidden>⌘K');
    // Legend row also reflects the same dual-rendering.
    expect(html).toContain('data-role="topo-keys-legend"');
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

  it('renders an inspector + heatmap timeline (BOM sidebar moved to /plans in v0.6.10 Task 2)', () => {
    const html = renderTopologyPage(snapshot({
      workers: [worker({ id: 'w1' })],
      inFlightBoms: [bom({ id: 'bom_1', goal: 'do it', scope_id: 'scope_a' })],
      scopes: [{ id: 'scope_a', title: 'release-cut' }],
    }));
    expect(html).toContain('id="inspector"');
    // v0.6.10 Task 3 — flat scrubber replaced by the heatmap timeline.
    expect(html).toContain('data-role="topo-timeline"');
    expect(html).toContain('data-role="topo-tl-slider"');
    // v0.6.10 Task 2 — In-flight BOMs sidebar lives on /dashboard/plans now.
    // Topology is pure-topology; the BOM list must NOT render here.
    expect(html).not.toContain('In-flight BOMs');
    expect(html).not.toContain('release-cut');
    expect(html).not.toContain('do it');
  });

  it('v0.6.10 Task 3 — heatmap timeline renders zoom chips + ribbon + tooltip surface', () => {
    const html = renderTopologyPage(snapshot({
      eventDensity: {
        bucketMs: 60_000,
        from: '2026-05-19T11:00:00.000Z',
        to:   '2026-05-19T12:00:00.000Z',
        peak: 3,
        buckets: [
          { at: '2026-05-19T11:00:00.000Z', count: 0, kinds: {} },
          { at: '2026-05-19T11:01:00.000Z', count: 3, kinds: { progress: 3 } },
          { at: '2026-05-19T11:02:00.000Z', count: 1, kinds: { worker_started: 1 } },
        ],
      },
    }));
    expect(html).toContain('data-role="topo-timeline"');
    expect(html).toContain('class="topo-tl-zoom"');
    expect(html).toContain('data-zoom="5"');
    expect(html).toContain('data-zoom="60"');
    expect(html).toContain('data-zoom="300"');
    expect(html).toContain('class="topo-tl-poly"');
    expect(html).toContain('class="topo-tl-heat"');
    // Hover hit-zones carry the bucket data the JS tooltip reads.
    expect(html).toContain('data-count="3"');
    expect(html).toContain('data-kinds="progress=3"');
  });

  it('wires SSE refresh on worker_/bom_step_/trust_scope_ events', () => {
    const html = renderTopologyPage(snapshot());
    expect(html).toContain('/dashboard/stream');
    expect(html).toContain('bom_step_');
    expect(html).toContain('worker_');
    expect(html).toContain('trust_scope_');
  });

  it('v0.6.10 Task 1 — renders MCP-category nodes from the registry', () => {
    const html = renderTopologyPage(snapshot({
      mcpCategoryNodes: [
        { id: 'mcp-cat-worker', category: 'worker', display_name: 'Workers', tool_count: 3, source: 'registry' },
        { id: 'mcp-cat-github', category: 'github', display_name: 'GitHub',  tool_count: 1, source: 'registry' },
      ],
    }));
    expect(html).toContain('data-id="mcp-cat-worker"');
    expect(html).toContain('data-id="mcp-cat-github"');
    expect(html).toContain('data-type="mcp-local"');
    expect(html).toContain('Workers');
    expect(html).toContain('GitHub');
  });

  it('v0.6.10 Task 4c — renders the particle click-inspector with placeholder + cross-link', () => {
    const html = renderTopologyPage(snapshot());
    expect(html).toContain('data-role="topo-particle-inspector"');
    expect(html).toContain('data-role="tpi-source-agent"');
    expect(html).toContain('data-role="tpi-signed-by"');
    expect(html).toContain('data-role="tpi-corr"');
    expect(html).toContain('data-role="tpi-payload"');
    expect(html).toContain('data-role="tpi-eventlog"');
    // v0.7 passkey placeholder is the canonical copy from the dispatch.
    expect(html).toContain('v0.7 will add operator passkey signature');
    expect(html).toContain('View in event log');
  });

  it('v0.6.10 Task 4b — emits a flow-particle surface for SSE-driven instruction animation', () => {
    const html = renderTopologyPage(snapshot());
    expect(html).toContain('data-role="topo-particles"');
    expect(html).toContain('.tp-dot');
    // Icon SVG strings for the five classes are inlined in the JS.
    expect(html).toContain('"operator":');
    expect(html).toContain('"cc":');
    expect(html).toContain('"cowork":');
    expect(html).toContain('"peer":');
  });

  it('v0.6.10 Task 4a — renders actor-nodes with data-actor-class for the color palette', () => {
    const html = renderTopologyPage(snapshot({
      actorNodes: [
        { id: 'actor-operator-op',  actorClass: 'operator', display_name: 'operator', status: 'ok',   source_agent: 'op' },
        { id: 'actor-cc-cc-feat-1', actorClass: 'cc',       display_name: 'cc-feat-1', status: 'ok',   source_agent: 'cc-feat-1' },
        { id: 'actor-cowork-cw',    actorClass: 'cowork',   display_name: 'cowork',   status: 'warn', source_agent: 'cw' },
      ],
    }));
    expect(html).toContain('data-id="actor-operator-op"');
    expect(html).toContain('data-id="actor-cc-cc-feat-1"');
    expect(html).toContain('data-id="actor-cowork-cw"');
    expect(html).toContain('data-actor-class="operator"');
    expect(html).toContain('data-actor-class="cc"');
    expect(html).toContain('data-actor-class="cowork"');
    expect(html).toContain('class="gnode actor-node"');
    // Actor filter chip is part of the legend strip.
    expect(html).toContain('data-type="actor"');
  });

  it('v0.6.10 Task 1 — renders peer nodes from peers.yaml feed', () => {
    const html = renderTopologyPage(snapshot({
      peers: [
        { id: 'twin-a', display_name: 'Twin A', status: 'ok', role: 'child' },
        { id: 'twin-b', display_name: 'twin-b', status: 'unknown' },
      ],
    }));
    expect(html).toContain('data-id="peer-twin-a"');
    expect(html).toContain('data-id="peer-twin-b"');
    expect(html).toContain('data-type="peer"');
    expect(html).toContain('Twin A');
  });

  it('v0.6.10 Task 2 — Worker roster table moved to /streams; topology is pure-topology', () => {
    const html = renderTopologyPage(snapshot({
      workers: [
        worker({ id: 'w1', name: 'alpha', status: 'running' }),
        worker({ id: 'w2', name: 'beta',  status: 'idle' }),
      ],
    }));
    // Workers still appear as constellation NODES (canvas), not as a roster table.
    expect(html).toContain('data-id="w1"');
    expect(html).toContain('data-id="w2"');
    // The roster table section must NOT render on Topology anymore.
    expect(html).not.toContain('Worker roster');
    expect(html).not.toContain('class="topo-roster');
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
