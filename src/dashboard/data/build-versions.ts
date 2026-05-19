// v0.6.8 Section 0 — Build & Versions data fetcher for the Diagnostics
// engine room. Reads the version + identity surface of every long-lived
// component the operator might need to name in a bug report: daemon,
// Steward, Governor, Node runtime, MCP SDK. Cached once at init because
// none of these change without a `pm2 restart`.
//
// Per BOM v0.6.8 P6 Section 0 — when fields are unknown (e.g. running
// from a dev tree without GIT_SHA injected, or Governor isn't running),
// the fetcher returns `null` for that slot and the render reports
// "unknown" / "not-running". No best-effort guessing — operator must be
// able to trust what they read here for bug reports.

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BuildVersions {
  /** stavR daemon — `package.json#version`. */
  daemonVersion: string;
  /** Short git SHA — 7 chars. `null` when neither GIT_SHA env nor .git/HEAD readable. */
  daemonGitSha: string | null;
  /** Daemon uptime in seconds since process start. */
  daemonUptimeSeconds: number;
  /** Node.js runtime version (e.g. `v20.18.1`). */
  nodeVersion: string;
  /** MCP SDK version from `node_modules/@modelcontextprotocol/sdk/package.json`. */
  mcpSdkVersion: string | null;
  /** Governor version from `governor/Cargo.toml#package.version`. */
  governorVersion: string | null;
  /** Governor running + signing status. `not-running` when no heartbeat. */
  governorStatus: 'cosign-signed' | 'dev-signed' | 'unsigned' | 'not-running' | 'unknown';
  /** Steward subprocess status. */
  stewardStatus: 'up' | 'unhealthy' | 'down' | 'starting' | 'unwired';
  /** Anthropic | Ollama | claude-code | null. */
  stewardModelRuntime: string | null;
  /** Build timestamp from CI (`BUILD_TIMESTAMP` env). `null` for dev builds. */
  buildTimestamp: string | null;
  /** GitHub Actions run number from `GITHUB_RUN_NUMBER` env. `null` for dev builds. */
  buildRunNumber: string | null;
  /** Canonical one-line bug-report string — the [Copy version string] button result. */
  copyString: string;
}

export interface BuildVersionsInput {
  /** Test override for the repo root (defaults to walking up from import.meta.url). */
  repoRoot?: string;
  /** Test override for process.uptime(). */
  uptime?: () => number;
  /** Test override for env. */
  env?: NodeJS.ProcessEnv;
  /** Optional pre-fetched governor heartbeat snapshot (when null, governor is treated as not-running). */
  governorHeartbeat?: GovernorHeartbeat | null;
  /** Optional pre-fetched steward health snapshot. */
  steward?: {
    status: 'starting' | 'up' | 'unhealthy' | 'down' | 'unwired';
    model_runtime?: string | null;
  };
}

export interface GovernorHeartbeat {
  version?: string;
  signing?: 'cosign-signed' | 'dev-signed' | 'unsigned';
  rust_version?: string;
}

export function snapshotBuildVersions(input: BuildVersionsInput = {}): BuildVersions {
  const env = input.env ?? process.env;
  const repoRoot = input.repoRoot ?? findRepoRoot();
  const daemonVersion = readJsonField(resolve(repoRoot, 'package.json'), 'version') ?? '0.0.0';
  const daemonGitSha = readGitSha(repoRoot, env);
  const uptimeSec = Math.floor((input.uptime ? input.uptime() : process.uptime()) || 0);
  const mcpSdkVersion = readJsonField(
    resolve(repoRoot, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json'),
    'version',
  );
  const governorVersion = readCargoVersion(resolve(repoRoot, 'governor', 'Cargo.toml'));
  const hb = input.governorHeartbeat;
  const governorStatus: BuildVersions['governorStatus'] = hb
    ? (hb.signing ?? 'unknown')
    : 'not-running';
  const stewardStatus = input.steward?.status ?? 'unwired';
  const stewardModelRuntime = input.steward?.model_runtime ?? null;
  const buildTimestamp = env.BUILD_TIMESTAMP?.trim() || null;
  const buildRunNumber = env.GITHUB_RUN_NUMBER?.trim() || null;

  const copyString = buildCopyString({
    daemonVersion,
    daemonGitSha,
    stewardStatus,
    stewardModelRuntime,
    governorVersion,
    governorStatus,
    nodeVersion: process.version,
    buildTimestamp,
    buildRunNumber,
  });

  return {
    daemonVersion,
    daemonGitSha,
    daemonUptimeSeconds: uptimeSec,
    nodeVersion: process.version,
    mcpSdkVersion,
    governorVersion,
    governorStatus,
    stewardStatus,
    stewardModelRuntime,
    buildTimestamp,
    buildRunNumber,
    copyString,
  };
}

/**
 * Compose the canonical bug-report line. Format chosen to be `grep`-friendly:
 * pipe-separated tokens, fixed ordering, no quotes. Operators paste this into
 * issue trackers.
 */
export function buildCopyString(b: {
  daemonVersion: string;
  daemonGitSha: string | null;
  stewardStatus: string;
  stewardModelRuntime: string | null;
  governorVersion: string | null;
  governorStatus: string;
  nodeVersion: string;
  buildTimestamp: string | null;
  buildRunNumber: string | null;
}): string {
  const tokens: string[] = [];
  tokens.push(`stavR v${b.daemonVersion}${b.daemonGitSha ? `/${b.daemonGitSha}` : ''}`);
  tokens.push(`steward ${b.stewardStatus}${b.stewardModelRuntime ? `/${b.stewardModelRuntime}` : ''}`);
  if (b.governorVersion) {
    tokens.push(`governor v${b.governorVersion}/${b.governorStatus}`);
  } else {
    tokens.push('governor not-built');
  }
  tokens.push(`node ${b.nodeVersion}`);
  if (b.buildTimestamp) {
    const runSuffix = b.buildRunNumber ? ` (run #${b.buildRunNumber})` : '';
    tokens.push(`build ${b.buildTimestamp}${runSuffix}`);
  }
  return tokens.join(' · ');
}

function findRepoRoot(): string {
  // Walk up from this file's location until a package.json with name "stavr"
  // is found. Falls back to two levels up which is the historical layout.
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of ['../..', '../../..', '../../../..']) {
    const candidate = resolve(here, rel);
    const pkg = resolve(candidate, 'package.json');
    try {
      if (existsSync(pkg)) {
        const parsed = JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string };
        if (parsed.name === 'stavr') return candidate;
      }
    } catch {
      /* keep walking */
    }
  }
  return resolve(here, '../..');
}

function readJsonField(path: string, field: 'version'): string | null {
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const v = parsed[field];
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

function readCargoVersion(path: string): string | null {
  try {
    const raw = readFileSync(path, 'utf8');
    // Minimal TOML scan — we only need the [package].version line.
    const inPackage = /\[package\]([\s\S]*?)(?=\n\[|$)/.exec(raw);
    if (!inPackage) return null;
    const match = /\bversion\s*=\s*"([^"]+)"/.exec(inPackage[1]);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function readGitSha(repoRoot: string, env: NodeJS.ProcessEnv): string | null {
  const fromEnv = env.GIT_SHA?.trim();
  if (fromEnv) return fromEnv.slice(0, 7);
  try {
    const head = readFileSync(resolve(repoRoot, '.git', 'HEAD'), 'utf8').trim();
    if (head.startsWith('ref: ')) {
      const refPath = resolve(repoRoot, '.git', head.slice(5).trim());
      if (existsSync(refPath)) {
        return readFileSync(refPath, 'utf8').trim().slice(0, 7);
      }
      // Packed-refs fallback
      const packed = resolve(repoRoot, '.git', 'packed-refs');
      if (existsSync(packed)) {
        const ref = head.slice(5).trim();
        for (const line of readFileSync(packed, 'utf8').split('\n')) {
          const m = /^([0-9a-f]{40})\s+(.+)$/.exec(line.trim());
          if (m && m[2] === ref) return m[1].slice(0, 7);
        }
      }
    } else if (/^[0-9a-f]{40}$/.test(head)) {
      return head.slice(0, 7);
    }
  } catch {
    /* fall through */
  }
  // Last resort — only used when nothing on disk works; spawning git is
  // intentionally NOT done here to avoid forking on the hot path. The
  // operator sees "unknown" in the dashboard and can manually invoke `git
  // rev-parse --short HEAD` if needed.
  return null;
}

/** Test-friendly variant — same as readGitSha but exported. */
export function _readGitShaForTests(repoRoot: string, env: NodeJS.ProcessEnv): string | null {
  return readGitSha(repoRoot, env);
}

/** Format uptime in operator-friendly units (s / m / h / d). */
export function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '?';
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return m === 0 ? `${h}h` : `${h}h ${m}m`;
  }
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  return h === 0 ? `${d}d` : `${d}d ${h}h`;
}

// Silence unused-import warning for execSync — reserved for a future
// fallback that runs `git rev-parse --short HEAD` lazily on operator click.
void execSync;
void statSync;
