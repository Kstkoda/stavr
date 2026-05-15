// src/bricks/installer.ts
//
// Local-source brick installer. Reads a folder of code that includes
// `stavr-brick.json`, validates the manifest, copies the brick into
// ~/.stavr/bricks/<id>/, persists the row in installed_bricks, dynamically
// imports the entry point, and registers the returned Connector instance
// with the ConnectorRegistry.
//
// On daemon boot, listInstalled() returns the rows; the caller re-imports
// each entry to re-register concrete connectors.

import { promises as fsp, existsSync, realpathSync } from 'node:fs';
import { join, resolve, basename, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { EventStore } from '../persistence.js';
import type { Connector, ConnectorRegistry } from '../connectors/index.js';
import { BrickManifestSchema, parseBrickManifest, type BrickManifest } from './manifest.js';
import { getLogger } from '../log.js';

export interface InstalledBrickRecord {
  id: string;
  kind: string;
  display_name: string;
  source_type: 'local' | 'github' | 'npm';
  source_path: string;
  install_path: string;
  manifest: BrickManifest;
  entry_point: string;
  installed_at: string;
  enabled: boolean;
}

export interface BrickInstaller {
  installLocal(sourceDir: string): Promise<InstalledBrickRecord>;
  uninstall(id: string): Promise<boolean>;
  listInstalled(): InstalledBrickRecord[];
  /** Re-import every installed brick's entry point. Called at daemon boot. */
  rehydrate(): Promise<{ loaded: number; failed: Array<{ id: string; error: string }> }>;
}

export interface InstallerOpts {
  store: EventStore;
  registry: ConnectorRegistry;
  /** Root where bricks get copied to. Defaults to ~/.stavr/bricks. */
  bricksRoot: string;
}

/**
 * Type of the default export the installer expects from a brick's entry
 * point: an init function that returns a Connector instance.
 */
export type BrickFactory = (deps: { manifest: BrickManifest; brickDir: string }) => Connector | Promise<Connector>;

export function createBrickInstaller(opts: InstallerOpts): BrickInstaller {
  const { store, registry, bricksRoot } = opts;

  async function installLocal(sourceDir: string): Promise<InstalledBrickRecord> {
    const sourceAbs = resolve(sourceDir);
    if (!existsSync(sourceAbs)) {
      throw new Error(`source path does not exist: ${sourceAbs}`);
    }
    const manifestPath = join(sourceAbs, 'stavr-brick.json');
    if (!existsSync(manifestPath)) {
      throw new Error(`manifest not found: ${manifestPath} (looked for stavr-brick.json in the brick dir)`);
    }
    const rawJson = await fsp.readFile(manifestPath, 'utf8');
    const parsed = parseBrickManifest(rawJson);
    if (!parsed.ok) throw new Error(parsed.error);
    const manifest = parsed.manifest;

    // Reject anything that has already been installed under the same id.
    const existing = store.listInstalledBricks().find((b) => b.id === manifest.id);
    if (existing) {
      throw new Error(`brick id '${manifest.id}' is already installed (at ${existing.install_path}); uninstall first`);
    }

    const installDir = join(bricksRoot, manifest.id);
    await copyDirRecursive(sourceAbs, installDir);

    // Re-validate manifest path traversal — the schema rejects '..' / absolute
    // entries but we belt-and-braces against any contrived edge case.
    const entryAbs = resolve(installDir, manifest.entry);
    if (!entryAbs.startsWith(resolve(installDir) + (isAbsolute(installDir) ? '' : ''))) {
      // Roll back the copy before throwing.
      await fsp.rm(installDir, { recursive: true, force: true }).catch(() => undefined);
      throw new Error(`entry path escapes the brick directory: ${manifest.entry}`);
    }
    if (!existsSync(entryAbs)) {
      await fsp.rm(installDir, { recursive: true, force: true }).catch(() => undefined);
      throw new Error(`entry file does not exist after copy: ${entryAbs}`);
    }

    const installedAt = new Date().toISOString();
    store.saveInstalledBrick({
      id: manifest.id,
      kind: manifest.kind,
      display_name: manifest.display_name,
      source_type: 'local',
      source_path: sourceAbs,
      install_path: installDir,
      manifest_json: rawJson,
      entry_point: manifest.entry,
      enabled: true,
    });

    // Import and register.
    try {
      const connector = await importAndBuild(installDir, manifest);
      registry.register(connector);
    } catch (err) {
      // Best-effort cleanup if the dynamic import fails — but keep the row so
      // operators see what was attempted; we only remove from registry.
      throw new Error(`brick installed to disk but import failed: ${(err as Error).message}`);
    }

    return {
      id: manifest.id,
      kind: manifest.kind,
      display_name: manifest.display_name,
      source_type: 'local',
      source_path: sourceAbs,
      install_path: installDir,
      manifest,
      entry_point: manifest.entry,
      installed_at: installedAt,
      enabled: true,
    };
  }

  async function uninstall(id: string): Promise<boolean> {
    const row = store.listInstalledBricks().find((b) => b.id === id);
    if (!row) return false;
    registry.unregister(id);
    try {
      await fsp.rm(row.install_path, { recursive: true, force: true });
    } catch (err) {
      getLogger().warn('failed to remove brick install dir', {
        id,
        install_path: row.install_path,
        error: (err as Error).message,
      });
    }
    store.deleteInstalledBrick(id);
    return true;
  }

  function listInstalled(): InstalledBrickRecord[] {
    return store.listInstalledBricks().map((r) => {
      const manifest = BrickManifestSchema.parse(JSON.parse(r.manifest_json));
      return {
        id: r.id,
        kind: r.kind,
        display_name: r.display_name,
        source_type: r.source_type,
        source_path: r.source_path,
        install_path: r.install_path,
        manifest,
        entry_point: r.entry_point,
        installed_at: r.installed_at,
        enabled: r.enabled,
      };
    });
  }

  async function rehydrate(): Promise<{ loaded: number; failed: Array<{ id: string; error: string }> }> {
    const failed: Array<{ id: string; error: string }> = [];
    let loaded = 0;
    for (const row of store.listInstalledBricks()) {
      if (!row.enabled) continue;
      try {
        const manifest = BrickManifestSchema.parse(JSON.parse(row.manifest_json));
        const connector = await importAndBuild(row.install_path, manifest);
        registry.register(connector);
        loaded += 1;
      } catch (err) {
        failed.push({ id: row.id, error: (err as Error).message });
      }
    }
    return { loaded, failed };
  }

  return { installLocal, uninstall, listInstalled, rehydrate };
}

// ============================================================
// INTERNALS
// ============================================================

async function importAndBuild(brickDir: string, manifest: BrickManifest): Promise<Connector> {
  // Resolve through realpath.native (which calls Win32 GetFullPathName) to
  // expand Windows 8.3 short paths like `RUNNER~1`. Plain fs.realpathSync
  // follows symlinks but does NOT normalize 8.3 short names — only the
  // .native variant does. pathToFileURL percent-encodes `~` as `%7E`, after
  // which Node's loader can't find the file because the actual filesystem
  // entry uses the long form. This bites GitHub Actions Windows runners
  // and any Windows install path with short-form components.
  const realBrickDir = realpathSync.native(brickDir);
  const entryAbs = resolve(realBrickDir, manifest.entry);
  // pathToFileURL handles Windows backslashes / drive letters correctly.
  const url = pathToFileURL(entryAbs).href;
  const mod = (await import(url)) as { default?: BrickFactory; factory?: BrickFactory };
  const factory = mod.default ?? mod.factory;
  if (typeof factory !== 'function') {
    throw new Error(`brick entry ${manifest.entry} does not export a default factory function`);
  }
  const connector = await factory({ manifest, brickDir });
  if (!connector || typeof connector.exec !== 'function') {
    throw new Error(`brick ${manifest.id} factory did not return a Connector`);
  }
  if (connector.id !== manifest.id) {
    throw new Error(`brick ${manifest.id} factory returned connector with mismatched id '${connector.id}'`);
  }
  return connector;
}

async function copyDirRecursive(src: string, dst: string): Promise<void> {
  await fsp.mkdir(dst, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const dstPath = join(dst, entry.name);
    if (entry.isDirectory()) {
      // Skip node_modules and dot dirs to keep copies fast and safe.
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      await copyDirRecursive(srcPath, dstPath);
    } else if (entry.isFile()) {
      await fsp.copyFile(srcPath, dstPath);
    }
    // Symlinks and special files are intentionally skipped.
  }
}

/** Build a unique brick scratch dir relative to a given root. Mostly tests. */
export function defaultBricksRoot(stavrHome: string): string {
  return join(stavrHome, 'bricks');
}

/** Utility used by tests to safely treat the directory's basename as the id. */
export function brickIdFromDir(dir: string): string {
  return basename(dir);
}
