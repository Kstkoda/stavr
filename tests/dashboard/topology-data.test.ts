/**
 * v0.6.10 Task 1 — Topology data fetcher (MCP-category nodes + peers
 * from peers.yaml + heatmap density buckets).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  bucketEventDensity,
  fetchMcpCategoryNodes,
  fetchPeers,
  fetchTopologyExtras,
} from '../../src/dashboard/data/topology-data.js';
import { ToolRegistry, buildMetadata } from '../../src/tools/registry.js';
import { EventStore } from '../../src/persistence.js';

function makeRegistry(ids: string[]): ToolRegistry {
  const r = new ToolRegistry();
  for (const id of ids) {
    r.record(buildMetadata(id, { description: '' }, 'test'));
  }
  return r;
}

describe('fetchMcpCategoryNodes', () => {
  it('emits one node per category present in the registry, with counts', () => {
    const registry = makeRegistry([
      'job_dispatch',
      'job_terminate',
      'github_create_pr',
      'host_exec',
    ]);
    const nodes = fetchMcpCategoryNodes(registry);
    const byCategory = new Map(nodes.map((n) => [n.category, n]));
    expect(byCategory.get('worker')?.tool_count).toBe(2);
    expect(byCategory.get('github')?.tool_count).toBe(1);
    expect(byCategory.get('shell')?.tool_count).toBe(1);
    expect(byCategory.has('credentials')).toBe(false);
  });

  it('omits categories with zero registrations', () => {
    const registry = makeRegistry([]);
    expect(fetchMcpCategoryNodes(registry)).toEqual([]);
  });

  it('uses stable alphabetical order by category id', () => {
    const registry = makeRegistry([
      'github_create_pr',
      'job_dispatch',
      'host_exec',
    ]);
    const order = fetchMcpCategoryNodes(registry).map((n) => n.category);
    expect(order).toEqual(['github', 'shell', 'worker']);
  });

  it('node ids are prefixed mcp-cat- for unambiguous routing', () => {
    const registry = makeRegistry(['job_dispatch']);
    expect(fetchMcpCategoryNodes(registry)[0].id).toBe('mcp-cat-worker');
  });
});

describe('fetchPeers', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stavr-topo-peers-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns [] when the file is missing', () => {
    expect(fetchPeers(join(dir, 'peers.yaml'))).toEqual([]);
  });

  it('parses a minimal peers.yaml into PeerEntryLite[]', () => {
    const path = join(dir, 'peers.yaml');
    writeFileSync(
      path,
      [
        'peers:',
        '  - id: twin-a',
        '    display_name: Twin A',
        '    endpoint: https://twin-a.local:7777',
        '    status: ok',
        '    role: child',
        '  - id: twin-b',
      ].join('\n'),
      'utf8',
    );
    const peers = fetchPeers(path);
    expect(peers).toHaveLength(2);
    expect(peers[0]).toMatchObject({
      id: 'twin-a',
      display_name: 'Twin A',
      endpoint: 'https://twin-a.local:7777',
      status: 'ok',
      role: 'child',
    });
    // Missing display_name falls back to id; missing status defaults to
    // 'unknown' so the halo reads neutral.
    expect(peers[1]).toMatchObject({
      id: 'twin-b',
      display_name: 'twin-b',
      status: 'unknown',
    });
  });

  it('returns [] on malformed YAML rather than crashing the daemon', () => {
    const path = join(dir, 'peers.yaml');
    writeFileSync(path, '::: not yaml :::', 'utf8');
    expect(fetchPeers(path)).toEqual([]);
  });

  it('returns [] on schema mismatch (e.g., peers is not an array)', () => {
    const path = join(dir, 'peers.yaml');
    writeFileSync(path, 'peers: not-an-array\n', 'utf8');
    expect(fetchPeers(path)).toEqual([]);
  });
});

describe('bucketEventDensity', () => {
  const NOW = Date.parse('2026-05-19T12:00:00.000Z');

  function ev(at: string, kind = 'event_test'): import('../../src/persistence.js').StoredEvent {
    return {
      id: 'e_' + at,
      persisted_at: at,
      at,
      kind: kind as never,
      source_agent: 'test',
      payload: {},
    } as never;
  }

  it('places events into the right bucket and surfaces peak', () => {
    const events = [
      ev('2026-05-19T11:30:00.000Z'),
      ev('2026-05-19T11:30:30.000Z'),
      ev('2026-05-19T11:30:45.000Z'),
      ev('2026-05-19T11:45:00.000Z'),
    ];
    const snap = bucketEventDensity(events, {
      now: NOW,
      bucketMs: 60_000,
      bucketCount: 60,
    });
    expect(snap.buckets).toHaveLength(60);
    expect(snap.peak).toBe(3);
    // The 11:30 bucket should contain 3 events.
    const heavy = snap.buckets.find((b) => b.at === '2026-05-19T11:30:00.000Z');
    expect(heavy?.count).toBe(3);
  });

  it('aggregates kinds and rolls excess into other', () => {
    const events = [
      ev('2026-05-19T11:30:00.000Z', 'k1'),
      ev('2026-05-19T11:30:01.000Z', 'k2'),
      ev('2026-05-19T11:30:02.000Z', 'k3'),
      ev('2026-05-19T11:30:03.000Z', 'k4'),
      ev('2026-05-19T11:30:04.000Z', 'k5'),
      ev('2026-05-19T11:30:05.000Z', 'k6'),
      ev('2026-05-19T11:30:06.000Z', 'k7'),
      ev('2026-05-19T11:30:07.000Z', 'k8'),
    ];
    const snap = bucketEventDensity(events, { now: NOW, bucketCount: 60 });
    const bucket = snap.buckets.find((b) => b.at === '2026-05-19T11:30:00.000Z');
    expect(bucket).toBeDefined();
    // Top 6 explicit + 2 rolled into 'other'.
    expect(Object.keys(bucket!.kinds).length).toBeLessThanOrEqual(7);
    expect(bucket!.kinds.other).toBeGreaterThanOrEqual(2);
  });

  it('excludes events outside the snapshot window', () => {
    const events = [ev('2025-01-01T00:00:00.000Z')];
    const snap = bucketEventDensity(events, { now: NOW, bucketCount: 60 });
    expect(snap.peak).toBe(0);
    expect(snap.buckets.every((b) => b.count === 0)).toBe(true);
  });
});

describe('fetchTopologyExtras', () => {
  it('bundles MCP nodes + peers + density into a single snapshot', () => {
    const store = new EventStore();
    store.init(':memory:');
    const registry = makeRegistry(['job_dispatch', 'github_create_pr']);
    const extras = fetchTopologyExtras({
      registry,
      store,
      peersYamlPath: '/nonexistent/peers.yaml',
    });
    expect(extras.mcpCategoryNodes.length).toBe(2);
    expect(extras.peers).toEqual([]);
    expect(extras.eventDensity.buckets.length).toBeGreaterThan(0);
  });
});
