/**
 * tests/federation/reporter.test.ts
 *
 * Verifies the bridge from PeerRegistry change events to broker
 * peer_joined / peer_left events.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Broker } from '../../src/broker.js';
import { EventStore } from '../../src/persistence.js';
import { PeerRegistry } from '../../src/federation/peer-registry.js';
import { attachFederationReporter } from '../../src/federation/reporter.js';

describe('attachFederationReporter', () => {
  let store: EventStore;
  let broker: Broker;
  let registry: PeerRegistry;
  let detach: (() => void) | null = null;

  beforeEach(() => {
    store = new EventStore();
    store.init(':memory:');
    broker = new Broker(store);
    registry = new PeerRegistry();
    detach = attachFederationReporter(registry, broker);
  });

  afterEach(() => {
    detach?.();
    store.close();
  });

  it('emits peer_joined the first time a peer is added', () => {
    const events: unknown[] = [];
    broker.onEvent((e) => events.push(e));
    registry.upsertConfigured({
      id: 'p1',
      display_name: 'P1',
      hostname: 'p1.local',
      port: 7777,
      trust: 'verified',
    });
    const joined = events.find((e) => (e as { kind: string }).kind === 'peer_joined');
    expect(joined).toBeDefined();
    expect((joined as { payload: { peer_id: string } }).payload.peer_id).toBe('p1');
  });

  it('does NOT re-emit peer_joined when the same peer changes again', () => {
    const events: Array<{ kind: string }> = [];
    broker.onEvent((e) => events.push(e as { kind: string }));
    registry.upsertConfigured({
      id: 'p1',
      display_name: 'P1',
      hostname: 'p1.local',
      port: 7777,
      trust: 'verified',
    });
    // Same id, different trust — still just one peer_joined.
    registry.upsertConfigured({
      id: 'p1',
      display_name: 'P1',
      hostname: 'p1.local',
      port: 7777,
      trust: 'local-equivalent',
    });
    const joinedCount = events.filter((e) => e.kind === 'peer_joined').length;
    expect(joinedCount).toBe(1);
  });

  it('emits peer_left when a known peer is removed', () => {
    const events: Array<{ kind: string; payload: unknown }> = [];
    broker.onEvent((e) => events.push(e as { kind: string; payload: unknown }));
    registry.upsertConfigured({
      id: 'p1',
      display_name: 'P1',
      hostname: 'p1.local',
      port: 7777,
      trust: 'verified',
    });
    // Now clear it via a yaml reload that omits p1.
    registry.loadFromYaml({ peers: [] });
    const left = events.find((e) => e.kind === 'peer_left');
    expect(left).toBeDefined();
    expect((left!.payload as { peer_id: string }).peer_id).toBe('p1');
  });

  it('detach() unsubscribes — further registry changes are silent', () => {
    const events: Array<{ kind: string }> = [];
    broker.onEvent((e) => events.push(e as { kind: string }));
    detach?.();
    detach = null;
    registry.upsertConfigured({
      id: 'p1',
      display_name: 'P1',
      hostname: 'p1.local',
      port: 7777,
      trust: 'verified',
    });
    expect(events.filter((e) => e.kind === 'peer_joined')).toEqual([]);
  });
});
