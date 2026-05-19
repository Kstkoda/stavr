/**
 * tests/federation/peer-registry.test.ts
 *
 * Registry merge semantics. peers.yaml (operator trust) + mDNS (discovery)
 * + ping results all converge here; the family-mode UI reads this view.
 */
import { describe, expect, it } from 'vitest';
import { PeerRegistry } from '../../src/federation/peer-registry.js';
import type { PeerRecord } from '../../src/types/federation.js';

describe('PeerRegistry', () => {
  it('upsertConfigured() inserts an offline record at first', () => {
    const reg = new PeerRegistry();
    reg.upsertConfigured({
      id: 'p1',
      display_name: 'P1',
      hostname: 'p1.local',
      port: 7777,
      trust: 'verified',
    });
    const rec = reg.get('p1')!;
    expect(rec.configured).toBe(true);
    expect(rec.discovered).toBe(false);
    expect(rec.state).toBe('offline');
    expect(rec.trust).toBe('verified');
  });

  it('upsertDiscovered() inserts a discovered-only record', () => {
    const reg = new PeerRegistry();
    reg.upsertDiscovered({
      id: 'p2',
      display_name: 'P2 (mDNS)',
      hostname: 'p2.local',
      addresses: ['192.168.1.42'],
      port: 7777,
      protocol_version: '1',
    });
    const rec = reg.get('p2')!;
    expect(rec.discovered).toBe(true);
    expect(rec.configured).toBe(false);
    expect(rec.state).toBe('online');
    expect(rec.trust).toBe('untrusted');
  });

  it('upsertConfigured() + upsertDiscovered() merge to configured+discovered', () => {
    const reg = new PeerRegistry();
    reg.upsertConfigured({
      id: 'p3',
      display_name: 'P3',
      hostname: 'p3.local',
      port: 7777,
      trust: 'verified',
    });
    reg.upsertDiscovered({
      id: 'p3',
      display_name: 'discovered name',
      hostname: 'p3.local',
      addresses: ['192.168.1.10'],
      port: 7777,
      protocol_version: '1',
    });
    const rec = reg.get('p3')!;
    expect(rec.configured).toBe(true);
    expect(rec.discovered).toBe(true);
    expect(rec.trust).toBe('verified');
    expect(rec.addresses).toEqual(['192.168.1.10']);
  });

  it('loadFromYaml() preserves discovered-only peers but demotes lost-config', () => {
    const reg = new PeerRegistry();
    reg.upsertConfigured({
      id: 'p4',
      display_name: 'P4',
      hostname: 'p4.local',
      port: 7777,
      trust: 'verified',
    });
    reg.upsertDiscovered({
      id: 'p4',
      display_name: 'P4',
      hostname: 'p4.local',
      addresses: ['192.168.1.5'],
      port: 7777,
      protocol_version: '1',
    });
    reg.upsertDiscovered({
      id: 'p5',
      display_name: 'P5 stranger',
      hostname: 'p5.local',
      addresses: ['192.168.1.6'],
      port: 7777,
      protocol_version: '1',
    });
    reg.loadFromYaml({ peers: [] });

    // P5 was discovered-only — stays as untrusted discovery.
    expect(reg.get('p5')?.trust).toBe('untrusted');
    expect(reg.get('p5')?.discovered).toBe(true);

    // P4 lost its configured flag and trust drops to untrusted.
    const p4 = reg.get('p4')!;
    expect(p4.configured).toBe(false);
    expect(p4.trust).toBe('untrusted');
    expect(p4.discovered).toBe(true);
  });

  it('loadFromYaml() drops records that were configured-only', () => {
    const reg = new PeerRegistry();
    reg.upsertConfigured({
      id: 'p6',
      display_name: 'P6',
      hostname: 'p6.local',
      port: 7777,
      trust: 'verified',
    });
    let removed: string | undefined;
    reg.on('removed', (id) => {
      removed = id;
    });
    reg.loadFromYaml({ peers: [] });
    expect(reg.get('p6')).toBeUndefined();
    expect(removed).toBe('p6');
  });

  it('markLost() drops discovered-only but keeps configured offline', () => {
    const reg = new PeerRegistry();
    reg.upsertDiscovered({
      id: 'transient',
      display_name: 'Transient',
      hostname: 't.local',
      addresses: [],
      port: 7777,
      protocol_version: '1',
    });
    reg.markLost('transient');
    expect(reg.get('transient')).toBeUndefined();

    reg.upsertConfigured({
      id: 'pinned',
      display_name: 'Pinned',
      hostname: 'pinned.local',
      port: 7777,
      trust: 'verified',
    });
    reg.upsertDiscovered({
      id: 'pinned',
      display_name: 'Pinned',
      hostname: 'pinned.local',
      addresses: ['192.168.1.1'],
      port: 7777,
      protocol_version: '1',
    });
    reg.markLost('pinned');
    const rec = reg.get('pinned')!;
    expect(rec.state).toBe('offline');
    expect(rec.configured).toBe(true);
  });

  it('recordPingResult() degrades online to degraded on first failure', () => {
    const reg = new PeerRegistry();
    reg.upsertDiscovered({
      id: 'p7',
      display_name: 'P7',
      hostname: 'p7.local',
      addresses: ['192.168.1.7'],
      port: 7777,
      protocol_version: '1',
    });
    reg.recordPingResult('p7', false);
    expect(reg.get('p7')?.state).toBe('degraded');
    reg.recordPingResult('p7', true);
    expect(reg.get('p7')?.state).toBe('online');
  });

  it('list() returns records sorted by display_name', () => {
    const reg = new PeerRegistry();
    reg.upsertConfigured({
      id: 'b',
      display_name: 'Banana',
      hostname: 'b.local',
      port: 7777,
      trust: 'verified',
    });
    reg.upsertConfigured({
      id: 'a',
      display_name: 'Apple',
      hostname: 'a.local',
      port: 7777,
      trust: 'verified',
    });
    const names = reg.list().map((r: PeerRecord) => r.display_name);
    expect(names).toEqual(['Apple', 'Banana']);
  });
});
