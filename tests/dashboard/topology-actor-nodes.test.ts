/**
 * v0.6.10 Task 4a — Actor-nodes derivation (Decision 4 layer 1).
 */
import { describe, expect, it } from 'vitest';
import {
  classifyActor,
  deriveActorNodes,
} from '../../src/dashboard/widgets/topology-actor-nodes.js';
import type { StoredEvent } from '../../src/persistence.js';
import type { PeerEntryLite } from '../../src/dashboard/data/topology-data.js';

const NOW = Date.parse('2026-05-19T12:00:00.000Z');

function ev(over: Partial<StoredEvent> & { source_agent: string; at: string }): StoredEvent {
  return {
    id: 'e_' + over.at,
    persisted_at: over.at,
    at: over.at,
    kind: 'progress' as never,
    source_agent: over.source_agent,
    payload: {},
  } as StoredEvent;
}

describe('classifyActor', () => {
  it('maps operator-prefixed agents → operator', () => {
    expect(classifyActor('operator')).toBe('operator');
    expect(classifyActor('operator:cowork')).toBe('operator');
  });
  it('cowork beats cc because cowork-claude contains "claude"', () => {
    expect(classifyActor('cowork-claude')).toBe('cowork');
    expect(classifyActor('cowork')).toBe('cowork');
  });
  it('maps CC variants → cc', () => {
    expect(classifyActor('cc')).toBe('cc');
    expect(classifyActor('cc-feat-1')).toBe('cc');
    expect(classifyActor('claude-code')).toBe('cc');
  });
  it('maps peer-prefixed + federated agents → peer', () => {
    expect(classifyActor('peer-twin-a')).toBe('peer');
    expect(classifyActor('federated-stavr')).toBe('peer');
    expect(classifyActor('stavr-peer')).toBe('peer');
  });
  it('falls through to default for unknown shapes', () => {
    expect(classifyActor('mystery-process')).toBe('default');
  });
  it('returns null for empty / null / undefined', () => {
    expect(classifyActor(null)).toBeNull();
    expect(classifyActor(undefined)).toBeNull();
    expect(classifyActor('')).toBeNull();
  });
});

describe('deriveActorNodes', () => {
  it('emits one node per unique source_agent and orders by class', () => {
    const events = [
      ev({ source_agent: 'operator',       at: '2026-05-19T11:59:59.000Z' }),
      ev({ source_agent: 'cc-feat-1',      at: '2026-05-19T11:59:50.000Z' }),
      ev({ source_agent: 'cowork-claude',  at: '2026-05-19T11:55:00.000Z' }),
    ];
    const nodes = deriveActorNodes({ events, peers: [], now: NOW });
    expect(nodes.map((n) => n.actorClass)).toEqual(['operator', 'cc', 'cowork']);
    expect(nodes[0].source_agent).toBe('operator');
    expect(nodes[1].source_agent).toBe('cc-feat-1');
  });

  it('derives halo status from event recency (ok / warn / crit)', () => {
    const events = [
      ev({ source_agent: 'op-fresh', at: '2026-05-19T11:59:30.000Z' }), // 30s ago → ok
      ev({ source_agent: 'op-warm',  at: '2026-05-19T11:57:00.000Z' }), // 3min ago → warn
      ev({ source_agent: 'op-cold',  at: '2026-05-19T11:00:00.000Z' }), // 1h ago → crit
    ];
    const nodes = deriveActorNodes({ events, peers: [], now: NOW });
    const byId = new Map(nodes.map((n) => [n.source_agent, n]));
    expect(byId.get('op-fresh')?.status).toBe('ok');
    expect(byId.get('op-warm')?.status).toBe('warn');
    expect(byId.get('op-cold')?.status).toBe('crit');
  });

  it('peers.yaml overlays event-derived peer with display name + role', () => {
    const events = [
      ev({ source_agent: 'peer-twin-a', at: '2026-05-19T11:59:50.000Z' }),
    ];
    const peers: PeerEntryLite[] = [
      { id: 'twin-a', display_name: 'Twin A · Bedroom', status: 'ok', role: 'child' },
    ];
    // Match the synthetic peer id we use to find the existing node.
    // deriveActorNodes uses `actor-peer-${source_agent}` for event-derived
    // and `actor-peer-${peer.id}` for peers.yaml — different ids, so two
    // separate nodes is the correct behavior unless peer.id matches the
    // wire source_agent verbatim.
    const nodes = deriveActorNodes({ events, peers, now: NOW });
    const peerNodes = nodes.filter((n) => n.actorClass === 'peer');
    expect(peerNodes.length).toBe(2);
    const declared = peerNodes.find((n) => n.peer_id === 'twin-a');
    expect(declared?.display_name).toBe('Twin A · Bedroom');
    expect(declared?.role).toBe('child');
  });

  it('peers.yaml entry without events still appears with declared status', () => {
    const peers: PeerEntryLite[] = [
      { id: 'twin-b', display_name: 'Twin B', status: 'warn' },
    ];
    const nodes = deriveActorNodes({ events: [], peers, now: NOW });
    expect(nodes).toHaveLength(1);
    expect(nodes[0].actorClass).toBe('peer');
    expect(nodes[0].status).toBe('warn');
    expect(nodes[0].peer_id).toBe('twin-b');
  });

  it('events outside the window are ignored', () => {
    const events = [
      ev({ source_agent: 'old', at: '2024-01-01T00:00:00.000Z' }),
    ];
    const nodes = deriveActorNodes({ events, peers: [], now: NOW, windowMs: 24 * 60 * 60 * 1000 });
    expect(nodes).toEqual([]);
  });
});
