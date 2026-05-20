/**
 * tests/workers/mcp-workers-config.test.ts
 *
 * Coverage for the YAML manifest loader. We exercise both the on-disk read
 * path (tmpdir fixtures) and the in-memory pre-parsed path the tests can
 * use to wire fake spawners.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMcpWorkerSpawners, ManifestError } from '../../src/workers/mcp-workers-config.js';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'stavr-mcp-cfg-'));
});

afterEach(() => {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* tmp cleanup best-effort on win32 */
  }
});

function fakeClientFactory() {
  return async (): Promise<Client> => {
    return {
      async callTool() {
        return { structuredContent: {}, content: [] };
      },
      async close() {},
    } as unknown as Client;
  };
}

describe('loadMcpWorkerSpawners', () => {
  it('returns an empty spawners list when the manifest file is missing', () => {
    const result = loadMcpWorkerSpawners({
      manifestPath: join(workDir, 'does-not-exist.yaml'),
    });
    expect(result.spawners).toEqual([]);
    expect(result.entries).toEqual([]);
  });

  it('returns an empty spawners list when the manifest file is empty', () => {
    const path = join(workDir, 'workers.yaml');
    writeFileSync(path, '', 'utf8');
    const result = loadMcpWorkerSpawners({ manifestPath: path });
    expect(result.spawners).toEqual([]);
  });

  it('loads one spawner per manifest entry and registers it with kebab type', () => {
    const path = join(workDir, 'workers.yaml');
    writeFileSync(
      path,
      [
        'workers:',
        '  - type: python',
        '    display_name: Python runner',
        '    description: Run Python scripts.',
        '    command: /usr/bin/python3',
        '    args: ["-m", "stavr_python_worker"]',
        '    tier: confirm',
      ].join('\n'),
      'utf8',
    );
    const result = loadMcpWorkerSpawners({
      manifestPath: path,
      spawnerOptions: { clientFactory: fakeClientFactory() },
    });
    expect(result.spawners).toHaveLength(1);
    expect(result.spawners[0]!.type).toBe('python');
    expect(result.spawners[0]!.tier).toBe('confirm');
    expect(result.entries[0]!.command).toBe('/usr/bin/python3');
  });

  it('loads two spawners with distinct types', () => {
    const path = join(workDir, 'workers.yaml');
    writeFileSync(
      path,
      [
        'workers:',
        '  - type: python',
        '    display_name: Python',
        '    description: Python.',
        '    command: python',
        '  - type: ollama-codegen',
        '    display_name: Ollama Codegen',
        '    description: Local LLM.',
        '    command: node',
        '    args: [./worker.js]',
      ].join('\n'),
      'utf8',
    );
    const result = loadMcpWorkerSpawners({
      manifestPath: path,
      spawnerOptions: { clientFactory: fakeClientFactory() },
    });
    expect(result.spawners.map((s) => s.type)).toEqual(['python', 'ollama-codegen']);
  });

  it('throws ManifestError on invalid YAML', () => {
    const path = join(workDir, 'workers.yaml');
    writeFileSync(path, 'workers: [unterminated', 'utf8');
    expect(() => loadMcpWorkerSpawners({ manifestPath: path })).toThrow(ManifestError);
  });

  it('throws ManifestError when a manifest entry fails schema validation', () => {
    const path = join(workDir, 'workers.yaml');
    writeFileSync(
      path,
      [
        'workers:',
        '  - type: NotKebab',
        '    display_name: bad',
        '    description: bad',
        '    command: x',
      ].join('\n'),
      'utf8',
    );
    expect(() => loadMcpWorkerSpawners({ manifestPath: path })).toThrow(ManifestError);
  });

  it('throws ManifestError on duplicate types', () => {
    const path = join(workDir, 'workers.yaml');
    writeFileSync(
      path,
      [
        'workers:',
        '  - type: python',
        '    display_name: A',
        '    description: A.',
        '    command: python',
        '  - type: python',
        '    display_name: B',
        '    description: B.',
        '    command: python3',
      ].join('\n'),
      'utf8',
    );
    expect(() =>
      loadMcpWorkerSpawners({
        manifestPath: path,
        spawnerOptions: { clientFactory: fakeClientFactory() },
      }),
    ).toThrow(/duplicate worker type "python"/);
  });

  it('accepts a pre-parsed manifest (bypasses file IO)', () => {
    const result = loadMcpWorkerSpawners({
      manifest: {
        workers: [
          {
            type: 'inline-test',
            display_name: 'Inline',
            description: 'Inline test.',
            command: 'node',
            args: [],
            tier: 'auto',
          },
        ],
      },
      spawnerOptions: { clientFactory: fakeClientFactory() },
    });
    expect(result.spawners).toHaveLength(1);
    expect(result.spawners[0]!.type).toBe('inline-test');
  });
});
