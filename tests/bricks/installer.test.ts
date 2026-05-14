// tests/bricks/installer.test.ts
//
// Local-source brick installer tests: happy install, daemon-restart
// persistence, invalid manifest, path traversal in entry.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EventStore } from '../../src/persistence.js';
import { InMemoryConnectorRegistry } from '../../src/connectors/index.js';
import { createBrickInstaller } from '../../src/bricks/installer.js';

let tmpRoot: string;
let bricksRoot: string;
let store: EventStore;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'stavr-bricks-'));
  bricksRoot = join(tmpRoot, 'bricks');
  store = new EventStore();
  store.init(':memory:');
});

afterEach(() => {
  store.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

function writeBrick(opts: {
  dir: string;
  manifest: Record<string, unknown>;
  entryContent?: string;
}): void {
  mkdirSync(opts.dir, { recursive: true });
  writeFileSync(join(opts.dir, 'stavr-brick.json'), JSON.stringify(opts.manifest, null, 2));
  const entry = (opts.manifest.entry as string) ?? 'index.js';
  writeFileSync(join(opts.dir, entry), opts.entryContent ?? defaultEntry());
}

function defaultEntry(): string {
  return `
export default function factory({ manifest }) {
  return {
    id: manifest.id,
    kind: manifest.kind,
    displayName: manifest.display_name,
    position: manifest.position,
    logoPath: null,
    configSchema: () => manifest.config_schema ?? [],
    applyConfig: async () => ({ kind: 'ok', detail: 'configured', lastChecked: new Date().toISOString() }),
    testConnection: async () => ({ kind: 'ok', detail: 'ok', lastChecked: new Date().toISOString() }),
    status: () => ({ kind: 'ok', detail: 'ok', lastChecked: new Date().toISOString() }),
    capabilities: () => manifest.capabilities.map((c) => ({
      id: c.id,
      description: c.description,
      capabilityTag: c.capability_tag,
      riskClass: c.risk_class,
      argsSchema: c.args_schema ?? [],
      enabled: c.enabled !== false,
    })),
    exec: async () => ({ ok: true, durationMs: 1 }),
  };
}
`;
}

describe('createBrickInstaller', () => {
  it('installs a local brick, persists it in DB, registers in registry', async () => {
    const sourceDir = join(tmpRoot, 'source-brick');
    writeBrick({
      dir: sourceDir,
      manifest: {
        id: 'echo',
        kind: 'echo',
        display_name: 'Echo',
        position: 'below',
        entry: 'index.js',
        capabilities: [
          {
            id: 'echo',
            description: 'echo args back',
            capability_tag: 'no-model',
            risk_class: 'read-only',
            args_schema: [],
          },
        ],
      },
    });

    const registry = new InMemoryConnectorRegistry();
    const installer = createBrickInstaller({ store, registry, bricksRoot });

    const record = await installer.installLocal(sourceDir);

    expect(record.id).toBe('echo');
    expect(record.install_path).toBe(join(bricksRoot, 'echo'));
    expect(registry.get('echo')).toBeDefined();
    const dbRows = store.listInstalledBricks();
    expect(dbRows.length).toBe(1);
    expect(dbRows[0].id).toBe('echo');
  });

  it('rehydrate() re-registers installed bricks across daemon restart', async () => {
    const sourceDir = join(tmpRoot, 'source-brick');
    writeBrick({
      dir: sourceDir,
      manifest: {
        id: 'persist',
        kind: 'echo',
        display_name: 'Persistor',
        position: 'below',
        entry: 'index.js',
        capabilities: [
          {
            id: 'noop',
            description: 'noop',
            capability_tag: 'no-model',
            risk_class: 'read-only',
            args_schema: [],
          },
        ],
      },
    });

    const registry1 = new InMemoryConnectorRegistry();
    const installer1 = createBrickInstaller({ store, registry: registry1, bricksRoot });
    await installer1.installLocal(sourceDir);

    // Simulate daemon restart: new registry, same store (same DB).
    const registry2 = new InMemoryConnectorRegistry();
    const installer2 = createBrickInstaller({ store, registry: registry2, bricksRoot });
    expect(registry2.get('persist')).toBeUndefined();

    const result = await installer2.rehydrate();

    expect(result.loaded).toBe(1);
    expect(result.failed).toEqual([]);
    expect(registry2.get('persist')).toBeDefined();
  });

  it('rejects an invalid manifest with a clear error', async () => {
    const sourceDir = join(tmpRoot, 'broken');
    writeBrick({
      dir: sourceDir,
      manifest: {
        // missing id and kind, invalid entry extension
        display_name: 'Broken',
        position: 'below',
        entry: 'index.exe',
        capabilities: [],
      },
    });

    const registry = new InMemoryConnectorRegistry();
    const installer = createBrickInstaller({ store, registry, bricksRoot });

    await expect(installer.installLocal(sourceDir)).rejects.toThrow(/manifest validation failed/);
    expect(store.listInstalledBricks().length).toBe(0);
  });

  it('rejects an entry path that tries to escape the brick directory', async () => {
    const sourceDir = join(tmpRoot, 'evil');
    // Manifest only — entry file deliberately absent and path traversal in the
    // manifest itself. Validation must fail before any file is touched.
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(
      join(sourceDir, 'stavr-brick.json'),
      JSON.stringify({
        id: 'evil',
        kind: 'evil',
        display_name: 'Evil',
        position: 'below',
        entry: '../../etc/passwd.js',
        capabilities: [
          {
            id: 'x',
            description: 'x',
            capability_tag: 'no-model',
            risk_class: 'read-only',
            args_schema: [],
          },
        ],
      }),
    );

    const registry = new InMemoryConnectorRegistry();
    const installer = createBrickInstaller({ store, registry, bricksRoot });

    await expect(installer.installLocal(sourceDir)).rejects.toThrow(/relative path inside the brick/);
    expect(store.listInstalledBricks().length).toBe(0);
  });
});
