/**
 * Stavr configuration (spec 52 — Mode 1 federation).
 *
 * Local-first remains the default (ADR-006): `network.bind` is `localhost` and the
 * daemon binds to 127.0.0.1 unless the operator opts in. Non-loopback binds require
 * the auth gate (pairing tokens — spec 52 A2) to be configured, or an explicit
 * `require_auth_when_non_local: false` escape hatch for known-trusted networks.
 *
 * Config file location: `$STAVR_HOME/stavr.yaml` (default `~/.stavr/stavr.yaml`).
 * Missing file is fine — defaults apply.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { HostCeilingSchema, validateHostCeilingCoherence } from './types/host-ceiling.js';

const networkSchema = z
  .object({
    bind: z.string().default('localhost'),
    require_auth_when_non_local: z.boolean().default(true),
  })
  .default({ bind: 'localhost', require_auth_when_non_local: true });

/**
 * v0.2 — experimental feature flags. Default-off so adding a feature to
 * `experimental` doesn't change behaviour for existing deployments. Flags
 * graduate to top-level config once stable.
 *
 * `planner`: when true, the daemon instantiates the StewardPlanner and
 * registers the `propose_plan` MCP tool. The reactive Steward loop is
 * unaffected either way.
 */
const experimentalSchema = z
  .object({
    planner: z.boolean().default(false),
  })
  .default({ planner: false });

export const StavrConfigSchema = z
  .object({
    network: networkSchema,
    experimental: experimentalSchema,
    host_ceiling: HostCeilingSchema,
  })
  .default({
    network: { bind: 'localhost', require_auth_when_non_local: true },
    experimental: { planner: false },
    host_ceiling: {
      max_host_ram_pct: 0.75,
      min_free_ram_gb: 2.0,
      max_sustained_cpu_pct: 0.85,
      max_concurrent_workers: 4,
      headroom_window_ms: 10_000,
      shed_threshold_pct: 0.95,
      shed_min_free_ram_gb: 0.5,
      enabled: true,
    },
  });

export type StavrConfig = z.infer<typeof StavrConfigSchema>;

export const DEFAULT_CONFIG: StavrConfig = {
  network: { bind: 'localhost', require_auth_when_non_local: true },
  experimental: { planner: false },
  host_ceiling: {
    max_host_ram_pct: 0.75,
    min_free_ram_gb: 2.0,
    max_sustained_cpu_pct: 0.85,
    max_concurrent_workers: 4,
    headroom_window_ms: 10_000,
    shed_threshold_pct: 0.95,
    shed_min_free_ram_gb: 0.5,
    enabled: true,
  },
};

export function stavrHome(): string {
  return process.env.STAVR_HOME?.trim() || join(homedir(), '.stavr');
}

export function defaultConfigPath(): string {
  return join(stavrHome(), 'stavr.yaml');
}

export interface LoadConfigResult {
  config: StavrConfig;
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
    throw new Error(`stavr config: failed to read ${resolved}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw) ?? {};
  } catch (err) {
    throw new Error(`stavr config: YAML parse error in ${resolved}: ${(err as Error).message}`);
  }
  const result = StavrConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n');
    throw new Error(`stavr config: invalid config in ${resolved}\n${issues}`);
  }
  const coherenceErrs = validateHostCeilingCoherence(result.data.host_ceiling);
  if (coherenceErrs.length > 0) {
    throw new Error(
      `stavr config: invalid host_ceiling in ${resolved}\n${coherenceErrs.map((e) => `  - ${e}`).join('\n')}`,
    );
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
    'stavr daemon refusing to bind non-local without auth configured. ' +
    'Run `stavr pair --bootstrap` first or set `network.require_auth_when_non_local: false` ' +
    "if you know what you're doing."
  );
}
