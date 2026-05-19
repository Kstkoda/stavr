/**
 * tests/federation/peers.test.ts
 *
 * peers.yaml loader coverage. Operator-facing config — parse + validation
 * errors must surface visibly rather than degrade silently.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPeersYaml, PeersYamlError } from '../../src/federation/peers.js';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'stavr-peers-'));
});

afterEach(() => {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* tmp cleanup best-effort */
  }
});

describe('loadPeersYaml', () => {
  it('returns an empty manifest when the file is missing', () => {
    const result = loadPeersYaml({ path: join(workDir, 'does-not-exist.yaml') });
    expect(result.yaml.peers).toEqual([]);
  });

  it('returns an empty manifest when the file is empty', () => {
    const path = join(workDir, 'peers.yaml');
    writeFileSync(path, '', 'utf8');
    const result = loadPeersYaml({ path });
    expect(result.yaml.peers).toEqual([]);
  });

  it('parses a single peer entry with defaults', () => {
    const path = join(workDir, 'peers.yaml');
    writeFileSync(
      path,
      ['peers:', '  - id: kenneth-laptop', '    display_name: Kenneth Laptop', '    hostname: kenneth.local'].join('\n'),
      'utf8',
    );
    const result = loadPeersYaml({ path });
    expect(result.yaml.peers).toHaveLength(1);
    expect(result.yaml.peers[0]).toMatchObject({
      id: 'kenneth-laptop',
      display_name: 'Kenneth Laptop',
      hostname: 'kenneth.local',
      port: 7777,
      trust: 'untrusted',
    });
  });

  it('parses self_id + self_display_name fields when present', () => {
    const path = join(workDir, 'peers.yaml');
    writeFileSync(
      path,
      ['self_id: my-rig', 'self_display_name: Kenneth Desktop', 'peers: []'].join('\n'),
      'utf8',
    );
    const result = loadPeersYaml({ path });
    expect(result.yaml.self_id).toBe('my-rig');
    expect(result.yaml.self_display_name).toBe('Kenneth Desktop');
  });

  it('parses multiple peers with explicit trust + port', () => {
    const path = join(workDir, 'peers.yaml');
    writeFileSync(
      path,
      [
        'peers:',
        '  - id: son1',
        '    display_name: Son 1 Rig',
        '    hostname: son1.local',
        '    port: 7778',
        '    trust: verified',
        '  - id: son2',
        '    display_name: Son 2 Rig',
        '    hostname: son2.local',
        '    trust: local-equivalent',
        '    public_key: "ed25519:abc123"',
      ].join('\n'),
      'utf8',
    );
    const result = loadPeersYaml({ path });
    expect(result.yaml.peers).toHaveLength(2);
    expect(result.yaml.peers[0]!.port).toBe(7778);
    expect(result.yaml.peers[1]!.trust).toBe('local-equivalent');
    expect(result.yaml.peers[1]!.public_key).toBe('ed25519:abc123');
  });

  it('throws PeersYamlError on invalid YAML', () => {
    const path = join(workDir, 'peers.yaml');
    writeFileSync(path, 'peers: [unterminated', 'utf8');
    expect(() => loadPeersYaml({ path })).toThrow(PeersYamlError);
  });

  it('throws PeersYamlError on unknown trust level', () => {
    const path = join(workDir, 'peers.yaml');
    writeFileSync(
      path,
      ['peers:', '  - id: p1', '    display_name: P1', '    hostname: p1.local', '    trust: super-trust'].join('\n'),
      'utf8',
    );
    expect(() => loadPeersYaml({ path })).toThrow(PeersYamlError);
  });

  it('throws PeersYamlError on duplicate peer ids', () => {
    const path = join(workDir, 'peers.yaml');
    writeFileSync(
      path,
      [
        'peers:',
        '  - id: p1',
        '    display_name: A',
        '    hostname: a.local',
        '  - id: p1',
        '    display_name: B',
        '    hostname: b.local',
      ].join('\n'),
      'utf8',
    );
    expect(() => loadPeersYaml({ path })).toThrow(/duplicate peer id/);
  });

  it('accepts a pre-parsed yaml (bypasses file IO)', () => {
    const result = loadPeersYaml({
      yaml: {
        self_id: 'inline',
        peers: [{ id: 'p', display_name: 'P', hostname: 'p.local', port: 7777, trust: 'verified' }],
      },
    });
    expect(result.yaml.self_id).toBe('inline');
    expect(result.yaml.peers[0]!.trust).toBe('verified');
  });
});
