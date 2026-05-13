/**
 * Cowire configuration (spec 52 — Mode 1 federation).
 *
 * Local-first remains the default (ADR-006): `network.bind` is `localhost` and the
 * daemon binds to 127.0.0.1 unless the operator opts in. Non-loopback binds require
 * the auth gate (pairing tokens — spec 52 A2) to be configured, or an explicit
 * `require_auth_when_non_local: false` escape hatch for known-trusted networks.
 *
 * Config file location: `$COWIRE_HOME/cowire.yaml` (default `~/.cowire/cowire.yaml`).
 * Missing file is fine — defaults apply.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

const networkSchema = z
  .object({
    bind: z.string().default('localhost'),
    require_auth_when_non_local: z.boolean().default(true),
  })
  .default({ bind: 'localhost', require_auth_when_non_local: true });

export const CowireConfigSchema = z
  .object({
    network: networkSchema,
  })
  .default({ network: { bind: 'localhost', require_auth_when_non_local: true } });

export type CowireConfig = z.infer<typeof CowireConfigSchema>;

export const DEFAULT_CONFIG: CowireConfig = {
  network: { bind: 'localhost', require_auth_when_non_local: true },
};

export function cowireHome(): string {
  return process.env.COWIRE_HOME?.trim() || join(homedir(), '.cowire');
}

export function defaultConfigPath(): string {
  return join(cowireHome(), 'cowire.yaml');
}

export interface LoadConfigResult {
  config: CowireConfig;
  source: 'file' | 'defaults';
  path: string;
}

export function loadConfig(path?: string): LoadConfigResult {
  const resolved = path ?? defaultConfigPath();
  if (!existsSync(resolved)) {
    return { config: structuredClone(DEFAULT_CONFIG), source: 'defaults', path: resolved };
  }
  let raw: string;
  try {
    raw = readFileSync(resolved, 'utf8');
  } catch (err) {
    throw new Error(`cowire config: failed to read ${resolved}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw) ?? {};
  } catch (err) {
    throw new Error(`cowire config: YAML parse error in ${resolved}: ${(err as Error).message}`);
  }
  const result = CowireConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n');
    throw new Error(`cowire config: invalid config in ${resolved}\n${issues}`);
  }
  return { config: result.data, source: 'file', path: resolved };
}

/**
 * Resolution of `network.bind` into a concrete listen target.
 *  - `localhost` / `127.0.0.1` / `::1` → loopback (default; ADR-006 safe path).
 *  - `lan` → first non-loopback IPv4 interface (machine-dependent).
 *  - `tailscale` → reserved for A3 (raises a clear error until A3 lands).
 *  - explicit `host` or `host:port` → used as-is.
 */
export interface ResolvedBind {
  host: string;
  port?: number;
  is_loopback: boolean;
  mode: 'localhost' | 'lan' | 'tailscale' | 'explicit';
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export function resolveBind(spec: string): ResolvedBind {
  const s = spec.trim();
  if (s === '' || s === 'localhost' || s === '127.0.0.1' || s === '::1') {
    return { host: '127.0.0.1', is_loopback: true, mode: 'localhost' };
  }
  if (s === 'lan') {
    const lan = discoverLanIp();
    if (!lan) {
      throw new Error(
        "network.bind: 'lan' is set but no non-loopback IPv4 interface was found. " +
          'Check `ipconfig`/`ifconfig`, or set `network.bind` to an explicit address.',
      );
    }
    return { host: lan, is_loopback: false, mode: 'lan' };
  }
  if (s === 'tailscale') {
    return { host: '__tailscale__', is_loopback: false, mode: 'tailscale' };
  }
  // host[:port] — bracketed IPv6 supported.
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(s);
  if (!m) throw new Error(`network.bind: cannot parse '${s}'`);
  const host = m[1].replace(/^\[|\]$/g, '');
  const port = m[2] ? Number(m[2]) : undefined;
  return {
    host,
    port,
    is_loopback: LOOPBACK_HOSTS.has(host),
    mode: 'explicit',
  };
}

function discoverLanIp(): string | undefined {
  const ifaces = networkInterfaces();
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const info of list) {
      if (info.family === 'IPv4' && !info.internal) {
        return info.address;
      }
    }
  }
  return undefined;
}

/**
 * Auth gate (spec 52). Returns `null` when the bind is allowed; otherwise returns
 * the error message the daemon should surface and refuse to start with.
 *
 * `authConfigured` is wired by the caller — for A1 it is always `false` since the
 * devices table arrives in A2. The shape is fixed now so A2 only needs to flip a
 * single argument at the call site.
 */
export function checkBindAuthGate(args: {
  resolved: ResolvedBind;
  requireAuthWhenNonLocal: boolean;
  authConfigured: boolean;
}): string | null {
  if (args.resolved.is_loopback) return null;
  if (!args.requireAuthWhenNonLocal) return null;
  if (args.authConfigured) return null;
  return (
    'cowire daemon refusing to bind non-local without auth configured. ' +
    'Run `cowire pair --bootstrap` first or set `network.require_auth_when_non_local: false` ' +
    "if you know what you're doing."
  );
}
