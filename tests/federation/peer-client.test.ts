/**
 * tests/federation/peer-client.test.ts
 *
 * Stubbed-fetcher coverage for the inter-peer HTTP client. Real cross-
 * peer integration lives in Phase 10a (the 2-daemon smoke test).
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

describe('PeerClient', () => {
  it('prefers an IPv4 address over hostname for baseUrlFor()', () => {
    const c = new PeerClient();
    expect(c.baseUrlFor(makePeer())).toBe('http://192.168.1.50:7777');
  });

  it('falls back to hostname when no addresses are known', () => {
    const c = new PeerClient();
    expect(c.baseUrlFor(makePeer({ addresses: [] }))).toBe('http://p1.local:7777');
  });

  it('uses the first listed address when no IPv4 is present', () => {
    const c = new PeerClient();
    expect(c.baseUrlFor(makePeer({ addresses: ['fe80::1'] }))).toBe('http://fe80::1:7777');
  });

  it('health() returns ok=true on a 200 + valid JSON', async () => {
    const c = new PeerClient({
      fetcher: async () => ({
        status: 200,
        text: async () =>
          JSON.stringify({ peer_id: 'remote-peer', protocol_version: '1', uptime_seconds: 42 }),
      }),
    });
    const result = await c.health(makePeer());
    expect(result.ok).toBe(true);
    expect(result.body?.peer_id).toBe('remote-peer');
    expect(result.body?.uptime_seconds).toBe(42);
  });

  it('health() returns ok=false on a 503', async () => {
    const c = new PeerClient({
      fetcher: async () => ({ status: 503, text: async () => 'down' }),
    });
    const result = await c.health(makePeer());
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
  });

  it('health() returns ok=false on non-JSON body', async () => {
    const c = new PeerClient({
      fetcher: async () => ({ status: 200, text: async () => 'not json' }),
    });
    const result = await c.health(makePeer());
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not JSON/);
  });

  it('health() returns ok=false on fetch rejection (network error)', async () => {
    const c = new PeerClient({
      fetcher: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    const result = await c.health(makePeer());
    expect(result.ok).toBe(false);
    expect(result.error).toBe('ECONNREFUSED');
    expect(result.status).toBe(0);
  });
});
