/**
 * Worker MCP servers config loader.
 *
 * MCP-backed worker types are declared in `~/.stavr/worker-mcp-servers.yaml`
 * using the manifest schema defined in `spawner-protocol.ts`. This file
 * loads + validates the manifest at daemon boot and translates each entry
 * into a `WorkerSpawner` registered with the orchestrator alongside the
 * built-in in-process spawners.
 *
 * The manifest is optional — its absence simply means no MCP-backed worker
 * types are registered. Empty config / missing file is a silent success.
 * Validation failures are SURFACED — a malformed manifest fails boot rather
 * than silently dropping worker types the operator expects to be available.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { getLogger } from '../log.js';
import {
  WorkerMcpManifestSchema,
  type WorkerMcpManifest,
  type WorkerMcpManifestEntry,
} from './spawner-protocol.js';
import { createMcpSpawner, type McpSpawnerOptions } from './spawner-mcp.js';
import type { WorkerSpawner } from './types.js';

/** Default location operators put their manifest at. Overridable for tests. */
export function defaultWorkerMcpManifestPath(): string {
  const home = process.env['STAVR_HOME'] ?? join(homedir(), '.stavr');
  return join(home, 'worker-mcp-servers.yaml');
}

export interface LoadOptions {
  /** Override the path used to locate the manifest. Tests pass a fixture path. */
  manifestPath?: string;
  /** Pre-parsed manifest — when set, file IO is skipped. Tests inject. */
  manifest?: WorkerMcpManifest;
  /** Passed through to every spawner the loader constructs. */
  spawnerOptions?: McpSpawnerOptions;
}

export interface LoadResult {
  spawners: WorkerSpawner[];
  entries: WorkerMcpManifestEntry[];
  manifestPath: string;
}

/** Load the manifest (if any) and return one spawner per entry. */
export function loadMcpWorkerSpawners(opts: LoadOptions = {}): LoadResult {
  const manifestPath = opts.manifestPath ?? defaultWorkerMcpManifestPath();
  const manifest = opts.manifest ?? readManifestFromDisk(manifestPath);
  const log = getLogger();

  const spawners: WorkerSpawner[] = [];
  const seenTypes = new Set<string>();
  for (const entry of manifest.workers) {
    if (seenTypes.has(entry.type)) {
      throw new ManifestError(
        `duplicate worker type "${entry.type}" in ${manifestPath}`,
      );
    }
    seenTypes.add(entry.type);
    spawners.push(createMcpSpawner(entry, opts.spawnerOptions));
    log.info('registered MCP worker type', {
      type: entry.type,
      command: entry.command,
      tier: entry.tier,
    });
  }
  return { spawners, entries: manifest.workers, manifestPath };
}

function readManifestFromDisk(path: string): WorkerMcpManifest {
  if (!existsSync(path)) {
    return { workers: [] };
  }
  let raw: unknown;
  try {
    raw = YAML.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new ManifestError(
      `worker MCP manifest at ${path} is not valid YAML: ${(err as Error).message}`,
    );
  }
  // Allow an empty file to be equivalent to an empty manifest. YAML.parse on
  // an empty file returns null, not {}.
  if (raw === null || raw === undefined) {
    return { workers: [] };
  }
  const parsed = WorkerMcpManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ManifestError(
      `worker MCP manifest at ${path} failed validation: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

export class ManifestError extends Error {
  readonly code = 'manifest_error' as const;
}
