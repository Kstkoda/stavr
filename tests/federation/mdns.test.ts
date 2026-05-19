/**
 * tests/federation/mdns.test.ts
 *
 * Coordinator-level coverage for the mDNS wrapper using an injected stub
 * driver. We do NOT bind real multicast sockets in unit tests — that
 * lives in Phase 10a's smoke test.
 */
import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { MdnsCoordinator, serviceToDiscovered, STAVR_PROTOCOL_VERSION } from '../../src/federation/mdns.js';

interface FakeService extends EventEmitter {
  name: string;
  host: string;
  port: number;
  type: string;
  addresses: string[];
  txt: Record<string, string>;
}

function makeFakeService(overrides: Partial<FakeService> = {}): FakeService {
  const svc = Object.assign(new EventEmitter(), {
    name: 'remote-peer',
    host: 'remote.local',
    port: 7777,
    type: 'stavr',
    addresses: ['192.168.1.99'],
    txt: {
      peer_id: 'remote-peer',
      display_name: 'Remote Peer',
      protocol_version: STAVR_PROTOCOL_VERSION,
    },
    ...overrides,
  }) as FakeService;
  return svc;
}

interface StubDriver {
  publish: ReturnType<typeof vi.fn>;
  find: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  unpublishAll: ReturnType<typeof vi.fn>;
}

function makeStubDriver(): { driver: StubDriver; browser: EventEmitter; onup: (s: FakeService) => void } {
  const browser = new EventEmitter();
  let onup: (s: FakeService) => void = () => {};
  const driver: StubDriver = {
    publish: vi.fn(() => ({ name: 'self', published: true }) as unknown),
    find: vi.fn((_opts: unknown, cb: (s: FakeService) => void) => {
      onup = cb;
      return browser;
    }),
    destroy: vi.fn(),
    unpublishAll: vi.fn(),
  };
  return { driver, browser, onup: (s) => onup(s) };
}

describe('serviceToDiscovered', () => {
  it('maps a complete service into a DiscoveredPeer', () => {
    const svc = makeFakeService();
    const peer = serviceToDiscovered(svc as never);
    expect(peer).toMatchObject({
      id: 'remote-peer',
      display_name: 'Remote Peer',
      hostname: 'remote.local',
      port: 7777,
      protocol_version: STAVR_PROTOCOL_VERSION,
    });
  });

  it('falls back to service.name when TXT.peer_id is absent', () => {
    const svc = makeFakeService({ txt: {} });
    const peer = serviceToDiscovered(svc as never);
    expect(peer?.id).toBe('remote-peer');
    expect(peer?.protocol_version).toBe('?');
  });

  it('returns undefined when host or port is missing', () => {
    const svc = makeFakeService({ host: '', port: 0 });
    expect(serviceToDiscovered(svc as never)).toBeUndefined();
  });
});

describe('MdnsCoordinator', () => {
  it('start() publishes self and emits discovered for other peers', () => {
    const coord = new MdnsCoordinator();
    const { driver, onup } = makeStubDriver();
    coord.useDriver(driver as never);

    const discovered: unknown[] = [];
    coord.on('discovered', (p) => {
      discovered.push(p);
    });

    coord.start({ peerId: 'self', displayName: 'Self', port: 7777 });
    expect(driver.publish).toHaveBeenCalledTimes(1);
    expect(driver.find).toHaveBeenCalledTimes(1);

    // Simulate finding another peer on the wire.
    onup(makeFakeService({ name: 'kenneth-laptop', txt: { peer_id: 'kenneth-laptop', display_name: 'Kenneth Laptop', protocol_version: '1' } }));
    expect(discovered).toHaveLength(1);
    expect((discovered[0] as { id: string }).id).toBe('kenneth-laptop');

    coord.stop();
  });

  it('start() filters out our own peer_id', () => {
    const coord = new MdnsCoordinator();
    const { driver, onup } = makeStubDriver();
    coord.useDriver(driver as never);

    const discovered: unknown[] = [];
    coord.on('discovered', (p) => {
      discovered.push(p);
    });

    coord.start({ peerId: 'self', displayName: 'Self', port: 7777 });
    onup(makeFakeService({ txt: { peer_id: 'self', display_name: 'Self', protocol_version: '1' } }));
    expect(discovered).toHaveLength(0);
    coord.stop();
  });

  it('lost event fires when the browser emits down for a service', () => {
    const coord = new MdnsCoordinator();
    const { driver, browser } = makeStubDriver();
    coord.useDriver(driver as never);

    const lost: string[] = [];
    coord.on('lost', (id) => lost.push(id));

    coord.start({ peerId: 'self', displayName: 'Self', port: 7777 });
    browser.emit('down', makeFakeService({ name: 'remote', txt: { peer_id: 'remote' } }));
    expect(lost).toEqual(['remote']);
    coord.stop();
  });

  it('start() is a no-op when called twice without stop()', () => {
    const coord = new MdnsCoordinator();
    const { driver } = makeStubDriver();
    coord.useDriver(driver as never);
    coord.start({ peerId: 'self', displayName: 'Self', port: 7777 });
    coord.start({ peerId: 'self', displayName: 'Self', port: 7777 });
    expect(driver.publish).toHaveBeenCalledTimes(1);
    coord.stop();
  });

  it('stop() refuses subsequent start() (use a fresh instance)', () => {
    const coord = new MdnsCoordinator();
    const { driver } = makeStubDriver();
    coord.useDriver(driver as never);
    coord.start({ peerId: 'self', displayName: 'Self', port: 7777 });
    coord.stop();
    expect(() => coord.start({ peerId: 'self', displayName: 'Self', port: 7777 })).toThrow();
  });
});
