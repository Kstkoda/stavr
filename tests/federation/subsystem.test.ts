/**
 * tests/federation/subsystem.test.ts
 *
 * Bootstrap-level coverage for the federation subsystem assembled in
 * src/federation/index.ts. mDNS is skipped via the skipMdns flag; the
 * ping loop runs against an injected PeerClient stub.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFederation, PeerClient } from '../../src/federation/index.js';

function makeStubClient(healthOk: boolean) {
  return new PeerClient({
    fetcher: async () => ({
      status: healthOk ? 200 : 503,
      text: async () =>
        healthOk
          ? JSON.stringify({ peer_id: 'stub', protocol_version: '1' })
          : 'down',
    }),
  });
}

describe('createFederation', () => {
  it('start() loads peers.yaml and seeds the registry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stavr-fed-'));
    const path = join(dir, 'peers.yaml');
    writeFileSync(
      path,
      [
        'self_id: this-rig',
        'peers:',
        '  - id: son1',
        '    display_name: Son 1',
        '    hostname: son1.local',
        '    trust: verified',
      ].join('\n'),
      'utf8',
    );

    const fed = createFederation();
    try {
      await fed.start({
        port: 7777,
        startedAt: new Date(),
        peersYamlPath: path,
        skipMdns: true,
        pingIntervalMs: null,
      });
      expect(fed.selfId()).toBe('this-rig');
      const rec = fed.registry.get('son1');
      expect(rec?.trust).toBe('verified');
      expect(rec?.configured).toBe(true);
    } finally {
      fed.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reloadPeers() refreshes registry from a new yaml fixture', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stavr-fed-'));
    const path = join(dir, 'peers.yaml');
    writeFileSync(path, 'peers: []', 'utf8');

    const fed = createFederation();
    try {
      await fed.start({
        port: 7777,
        startedAt: new Date(),
        peersYamlPath: path,
        skipMdns: true,
        pingIntervalMs: null,
      });
      expect(fed.registry.size()).toBe(0);

      writeFileSync(
        path,
        ['peers:', '  - id: a', '    display_name: A', '    hostname: a.local', '    trust: verified'].join('\n'),
        'utf8',
      );
      const count = fed.reloadPeers({ path });
      expect(count).toBe(1);
      expect(fed.registry.get('a')?.trust).toBe('verified');
    } finally {
      fed.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pingNow() updates registry state based on PeerClient health results', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stavr-fed-'));
    const path = join(dir, 'peers.yaml');
    writeFileSync(path, 'peers: []', 'utf8');

    const fed = createFederation();
    try {
      await fed.start({
        port: 7777,
        startedAt: new Date(),
        peersYamlPath: path,
        skipMdns: true,
        pingIntervalMs: null,
        peerClient: makeStubClient(true),
      });

      // Seed a discovered peer.
      fed.registry.upsertDiscovered({
        id: 'son1',
        display_name: 'Son 1',
        hostname: 'son1.local',
        addresses: ['192.168.1.10'],
        port: 7777,
        protocol_version: '1',
      });

      await fed.pingNow();
      expect(fed.registry.get('son1')?.state).toBe('online');
    } finally {
      fed.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('start() is idempotent — second call is a no-op', async () => {
    const fed = createFederation();
    try {
      await fed.start({
        port: 7777,
        startedAt: new Date(),
        peersYamlPath: '/nonexistent.yaml',
        skipMdns: true,
        pingIntervalMs: null,
      });
      await fed.start({
        port: 7777,
        startedAt: new Date(),
        peersYamlPath: '/nonexistent.yaml',
        skipMdns: true,
        pingIntervalMs: null,
      });
      expect(fed.selfId()).toBe('stavr-self');
    } finally {
      fed.stop();
    }
  });
});
