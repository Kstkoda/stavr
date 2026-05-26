/**
 * tests/federation/peer-client.test.ts
 *
 * Stubbed-fetcher coverage for the inter-peer HTTP client. Asserts the
 * walk-candidates + last-working-cache contract added in the chaos-debug
 * BOM Phase 4 fix (multi-homed peers must reach a routable address even
 * when an unreachable one shows up first in mDNS-discovered list).
 *
 * Real cross-peer integration lives in the bombardment compose rig.
 */
import { describe, expect, it } from 'vitest';
import { PeerClient } from '../../src/federation/peer-client.js';
import type { PeerRecord } from '../../src/types/federation.js';

function makePeer(overrides: Partial<PeerRecord> = {}): PeerRecord {
  return {
    id: 'p1',
    display_name: 'P1',
    hostname: 'p1.local',
    port: 7777,
    addresses: ['192.168.1.50'],
    trust: 'verified',
    state: 'online',
    configured: true,
    discovered: true,
    last_seen_at: Date.now(),
    ...overrides,
  };
}

const HEALTH_BODY = JSON.stringify({ peer_id: 'remote-peer', protocol_version: '1', uptime_seconds: 42 });

describe('PeerClient.candidates', () => {
  it('lists IPv4 addresses before non-IPv4 and hostname last', () => {
    const c = new PeerClient();
    const candidates = c.candidates(
      makePeer({ addresses: ['fe80::1', '192.168.1.50'], hostname: 'p1.local' }),
    );
    expect(candidates).toEqual([
      'http://192.168.1.50:7777',
      'http://[fe80::1]:7777',
      'http://p1.local:7777',
    ]);
  });

  it('includes hostname when no addresses are known', () => {
    const c = new PeerClient();
    expect(c.candidates(makePeer({ addresses: [] }))).toEqual(['http://p1.local:7777']);
  });

  it('returns no candidates when neither addresses nor hostname are present', () => {
    const c = new PeerClient();
    expect(c.candidates(makePeer({ addresses: [], hostname: '' }))).toEqual([]);
  });

  it('deduplicates when hostname matches an address', () => {
    const c = new PeerClient();
    const candidates = c.candidates(
      makePeer({ addresses: ['192.168.1.50'], hostname: '192.168.1.50' }),
    );
    expect(candidates).toEqual(['http://192.168.1.50:7777']);
  });
});

describe('PeerClient.health — walk-candidates', () => {
  it('returns ok=true on first candidate success and records the base_url', async () => {
    const calls: string[] = [];
    const c = new PeerClient({
      fetcher: async (url) => {
        calls.push(url);
        return { status: 200, text: async () => HEALTH_BODY };
      },
    });
    const result = await c.health(makePeer());
    expect(result.ok).toBe(true);
    expect(result.base_url).toBe('http://192.168.1.50:7777');
    expect(calls).toEqual(['http://192.168.1.50:7777/api/federation/health']);
  });

  it('walks past a dead first candidate to a working second one (multi-homed bug regression)', async () => {
    // The exact rig shape: hub announces two IPv4s; the cross-subnet
    // one lands first and times out, the routable one lands second.
    const calls: string[] = [];
    const c = new PeerClient({
      fetcher: async (url) => {
        calls.push(url);
        if (url.startsWith('http://172.30.20.3:')) {
          throw new Error('peer-client timeout after 3000ms');
        }
        return { status: 200, text: async () => HEALTH_BODY };
      },
    });
    const peer = makePeer({
      id: 'hub',
      addresses: ['172.30.20.3', '172.30.10.3'],
      hostname: 'hub',
    });
    const result = await c.health(peer);
    expect(result.ok).toBe(true);
    expect(result.base_url).toBe('http://172.30.10.3:7777');
    expect(calls).toEqual([
      'http://172.30.20.3:7777/api/federation/health',
      'http://172.30.10.3:7777/api/federation/health',
    ]);
  });

  it('caches the last-working URL so a second probe skips dead candidates entirely', async () => {
    const calls: string[] = [];
    const c = new PeerClient({
      fetcher: async (url) => {
        calls.push(url);
        if (url.startsWith('http://172.30.20.3:')) {
          throw new Error('peer-client timeout after 3000ms');
        }
        return { status: 200, text: async () => HEALTH_BODY };
      },
    });
    const peer = makePeer({
      id: 'hub',
      addresses: ['172.30.20.3', '172.30.10.3'],
      hostname: 'hub',
    });
    await c.health(peer); // primes cache with 172.30.10.3
    calls.length = 0;
    const result = await c.health(peer);
    expect(result.ok).toBe(true);
    expect(result.base_url).toBe('http://172.30.10.3:7777');
    expect(calls).toEqual(['http://172.30.10.3:7777/api/federation/health']);
  });

  it('invalidates the cache when the previously-working URL starts failing and re-walks', async () => {
    let goodHost = '172.30.10.3';
    const calls: string[] = [];
    const c = new PeerClient({
      fetcher: async (url) => {
        calls.push(url);
        if (url.startsWith(`http://${goodHost}:`)) {
          return { status: 200, text: async () => HEALTH_BODY };
        }
        throw new Error('peer-client timeout after 3000ms');
      },
    });
    const peer = makePeer({
      id: 'hub',
      addresses: ['172.30.20.3', '172.30.10.3'],
      hostname: 'hub',
    });
    const first = await c.health(peer);
    expect(first.base_url).toBe('http://172.30.10.3:7777');
    // The previously-good address now fails; the other was the only
    // alternative. Total failure → cache must clear so the next probe
    // doesn't keep trying the broken address first.
    goodHost = 'never-matches';
    const second = await c.health(peer);
    expect(second.ok).toBe(false);
    // Restore the original good host. Next probe should re-walk from
    // the canonical IPv4-first order (not a cache-hit), proving
    // lastWorkingByPeer.delete() fired on total failure.
    goodHost = '172.30.10.3';
    calls.length = 0;
    const third = await c.health(peer);
    expect(third.ok).toBe(true);
    expect(third.base_url).toBe('http://172.30.10.3:7777');
    expect(calls).toEqual([
      'http://172.30.20.3:7777/api/federation/health',
      'http://172.30.10.3:7777/api/federation/health',
    ]);
  });

  it('returns ok=false with combined per-attempt errors when every candidate fails', async () => {
    const c = new PeerClient({
      fetcher: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    const peer = makePeer({
      id: 'hub',
      addresses: ['172.30.20.3', '172.30.10.3'],
      hostname: 'hub',
    });
    const result = await c.health(peer);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(result.error).toMatch(/all 3 candidate\(s\) failed/);
    expect(result.error).toContain('http://172.30.20.3:7777');
    expect(result.error).toContain('http://172.30.10.3:7777');
    expect(result.error).toContain('http://hub:7777');
    expect(result.error).toContain('ECONNREFUSED');
  });

  it('returns ok=false when no candidates exist at all', async () => {
    const c = new PeerClient({
      fetcher: async () => {
        throw new Error('should not be called');
      },
    });
    const result = await c.health(makePeer({ addresses: [], hostname: '' }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no candidate addresses/);
  });

  it('returns ok=false on a 503 from the first (only) candidate', async () => {
    const c = new PeerClient({
      fetcher: async () => ({ status: 503, text: async () => 'down' }),
    });
    const result = await c.health(makePeer({ addresses: ['192.168.1.50'], hostname: '' }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('HTTP 503');
  });

  it('returns ok=false on non-JSON body from the only candidate', async () => {
    const c = new PeerClient({
      fetcher: async () => ({ status: 200, text: async () => 'not json' }),
    });
    const result = await c.health(makePeer({ addresses: ['192.168.1.50'], hostname: '' }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not JSON/);
  });
});
