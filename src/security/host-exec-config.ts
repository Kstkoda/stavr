// host_exec config loader.
//
// Operator can place ~/.stavr/host-exec.json to RESTRICT the built-in
// allowlist. The schema is intentionally minimal and CANNOT add new commands
// — the in-code DEFAULT_ALLOWLIST is the only source of new entries. The
// rationale lives in src/security/host-exec-allowlist.ts.
//
// Override semantics, per-entry:
//   { "git":  { "enabled": false } }   // disables git
//   { "node": { "enabled": true } }    // re-enables node (operator opt-in)
//   { "git":  { "timeout_default_ms": 30000 } }  // tighten timeout
//
// Unknown command keys are IGNORED with a one-line warning (we don't blow up
// on a stale config that mentions a removed binary).

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getLogger } from '../log.js';
import {
  DEFAULT_ALLOWLIST,
  type AllowlistEntry,
  type ResolvedAllowlist,
} from './host-exec-allowlist.js';

export interface HostExecOverride {
  enabled?: boolean;
  timeout_default_ms?: number;
}

export interface HostExecConfigFile {
  /** Per-command overrides keyed by binary name. */
  overrides?: Record<string, HostExecOverride>;
}

export interface LoadOpts {
  /** Override the resolved config path (tests). */
  configPath?: string;
  /** Inject defaults (tests). Defaults to DEFAULT_ALLOWLIST. */
  defaults?: AllowlistEntry[];
}

export function defaultConfigPath(): string {
  return join(homedir(), '.stavr', 'host-exec.json');
}

function readConfigFile(path: string): HostExecConfigFile | undefined {
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as HostExecConfigFile;
    }
    return undefined;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    getLogger().warn(`host-exec config at ${path} unreadable: ${(err as Error).message}`);
    return undefined;
  }
}

/**
 * Resolve the effective allowlist by merging operator overrides on top of
 * defaults. Operator can ONLY: disable an entry, re-enable a disabled one,
 * or tighten timeout_default_ms. Operator CANNOT add commands, broaden
 * validateArgs, or change the platform restriction.
 */
export function loadHostExecConfig(opts: LoadOpts = {}): ResolvedAllowlist {
  const defaults = opts.defaults ?? DEFAULT_ALLOWLIST;
  const path = opts.configPath ?? defaultConfigPath();
  const file = readConfigFile(path);
  if (!file || !file.overrides) {
    return defaults.map((e) => ({ ...e }));
  }
  const overrides = file.overrides;
  const knownCommands = new Set(defaults.map((e) => e.command));
  for (const cmd of Object.keys(overrides)) {
    if (!knownCommands.has(cmd)) {
      getLogger().warn(
        `host-exec config: override for unknown command '${cmd}' ignored (not in compiled allowlist)`,
      );
    }
  }
  return defaults.map((entry) => {
    const override = overrides[entry.command];
    if (!override) return { ...entry };
    const next: AllowlistEntry = { ...entry };
    if (typeof override.enabled === 'boolean') {
      next.enabled = override.enabled;
    }
    if (
      typeof override.timeout_default_ms === 'number' &&
      override.timeout_default_ms > 0 &&
      override.timeout_default_ms < entry.timeout_default_ms
    ) {
      // Operator can only TIGHTEN the timeout, never extend it.
      next.timeout_default_ms = override.timeout_default_ms;
    }
    return next;
  });
}
