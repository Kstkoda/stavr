/**
 * peers.yaml loader — ADR-042 §Decision 2 (trust root).
 *
 * Operator declares affirmatively-trusted peers in `~/.stavr/peers.yaml`.
 * Discovery without trust is just a list of strangers; this file is what
 * elevates a discovered mDNS hit to a federation peer the daemon will
 * actually exchange events with.
 *
 * The file is optional — its absence is fine (federation falls back to
 * "discovery only, no traffic"). Parse / validation errors are surfaced
 * operator-visibly rather than silently dropped.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { PeersYamlSchema, type PeersYaml } from '../types/federation.js';

export function defaultPeersYamlPath(): string {
  const home = process.env['STAVR_HOME'] ?? join(homedir(), '.stavr');
  return join(home, 'peers.yaml');
}

export interface LoadOptions {
  /** Override the file path. Tests pass a tmp fixture. */
  path?: string;
  /** Pre-parsed manifest. Tests inject. */
  yaml?: PeersYaml;
}

export interface LoadedPeers {
  path: string;
  yaml: PeersYaml;
}

export function loadPeersYaml(opts: LoadOptions = {}): LoadedPeers {
  const path = opts.path ?? defaultPeersYamlPath();
  if (opts.yaml) {
    return { path, yaml: opts.yaml };
  }
  if (!existsSync(path)) {
    return { path, yaml: { peers: [] } };
  }
  let raw: unknown;
  try {
    raw = YAML.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new PeersYamlError(`peers.yaml at ${path} is not valid YAML: ${(err as Error).message}`);
  }
  if (raw === null || raw === undefined) {
    return { path, yaml: { peers: [] } };
  }
  const parsed = PeersYamlSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PeersYamlError(
      `peers.yaml at ${path} failed validation: ${parsed.error.message}`,
    );
  }

  // Catch duplicate peer ids — yaml round-trips them silently otherwise.
  const seen = new Set<string>();
  for (const peer of parsed.data.peers) {
    if (seen.has(peer.id)) {
      throw new PeersYamlError(`peers.yaml duplicate peer id: "${peer.id}"`);
    }
    seen.add(peer.id);
  }

  return { path, yaml: parsed.data };
}

export class PeersYamlError extends Error {
  readonly code = 'peers_yaml_error' as const;
}
