// host_exec allowlist (BOM: proposed/host-exec-tool-bom.md).
//
// Why this file exists: stavR's whole shell-access story is "narrow, audited,
// gateable." The allowlist is the only thing standing between an AI tool and
// arbitrary code execution on the operator's host. The list below is COMPILED
// IN — the operator config (~/.stavr/host-exec.json) can RESTRICT (disable an
// entry) but cannot EXPAND. That asymmetry is deliberate: an attacker who can
// write the config file should not be able to add `rm` to the allowlist.
//
// See ADR-022 (no-go list) for the deny-override floor that runs ABOVE this
// allowlist. A command that passes here can still hit a no-go pattern.

export interface AllowlistEntry {
  /** Binary name (no path). spawn() handles PATH resolution. */
  command: string;
  /** When false, every call to this command is denied regardless of args. */
  enabled: boolean;
  /** Default timeout if the caller omits timeout_ms. */
  timeout_default_ms: number;
  /** Operator-facing rationale; surfaced in tool-list/docs/audit log. */
  description: string;
  /**
   * Per-call arg validator. Returns { ok: true } to allow; { ok: false, reason }
   * to deny. Omitted = any args allowed (for read-only commands like netstat).
   */
  validateArgs?: (args: string[]) => { ok: boolean; reason?: string };
  /** Restrict to a specific platform. Default = any platform. */
  platforms?: NodeJS.Platform[];
}

export interface AllowlistValidation {
  allowed: boolean;
  /** Populated only when allowed=false. Surfaced in the denial event. */
  reason?: string;
  /** Resolved entry (set when allowed=true) — runner needs timeout_default_ms. */
  entry?: AllowlistEntry;
}

const FIVE_MIN_MS = 5 * 60 * 1000;
const TEN_MIN_MS = 10 * 60 * 1000;

/**
 * Default allowlist. Each entry's banned-pattern list reflects the BOM's
 * explicit ban rules — not aspirational coverage. Add to this list ONLY with
 * an explicit BOM amendment + operator review.
 */
export const DEFAULT_ALLOWLIST: AllowlistEntry[] = [
  {
    command: 'git',
    enabled: true,
    timeout_default_ms: FIVE_MIN_MS,
    description:
      'Routine git ops (status/log/diff/restore/checkout/pull/push/etc). ' +
      'Banned: rebase -i (interactive), config --global (identity), filter-repo (history rewrite).',
    validateArgs: (args) => {
      const sub = args[0];
      if (sub === 'rebase' && args.includes('-i')) {
        return { ok: false, reason: 'git rebase -i is interactive — not supported' };
      }
      if (sub === 'config' && args.includes('--global')) {
        return { ok: false, reason: 'git config --global is operator-wide; refuse' };
      }
      if (sub === 'filter-repo' || sub === 'filter-branch') {
        return { ok: false, reason: 'git history rewrite tools are banned' };
      }
      return { ok: true };
    },
  },
  {
    command: 'npm',
    enabled: true,
    timeout_default_ms: TEN_MIN_MS,
    description:
      'Package + script execution (install/ci/run/test/build/version/audit/outdated/ls/view). ' +
      'Banned: publish (no publishing), config set //*:_authToken (no token writes).',
    validateArgs: (args) => {
      const sub = args[0];
      if (sub === 'publish') {
        return { ok: false, reason: 'npm publish is banned' };
      }
      if (sub === 'config' && args.includes('set')) {
        const setIdx = args.indexOf('set');
        const key = args[setIdx + 1];
        if (typeof key === 'string' && /_authToken/i.test(key)) {
          return { ok: false, reason: 'npm config set <token> is banned' };
        }
      }
      return { ok: true };
    },
  },
  {
    command: 'pm2',
    enabled: true,
    timeout_default_ms: FIVE_MIN_MS,
    description:
      'PM2 process management (restart/status/logs/list/start/stop/delete/kill/save/reload/env/describe/jlist). ' +
      'Banned: pm2 set (no global PM2 config writes).',
    validateArgs: (args) => {
      const sub = args[0];
      if (sub === 'set') {
        return { ok: false, reason: 'pm2 set is banned (global config write)' };
      }
      return { ok: true };
    },
  },
  {
    command: 'taskkill',
    enabled: true,
    timeout_default_ms: 30_000,
    platforms: ['win32'],
    description:
      'Windows-only process kill by PID. MUST include "/pid <numeric>". ' +
      'Banned: /im <name> (could match the AI runtime itself).',
    validateArgs: (args) => {
      if (args.some((a) => a.toLowerCase() === '/im')) {
        return { ok: false, reason: 'taskkill /im (by image name) is banned — use /pid' };
      }
      const pidIdx = args.findIndex((a) => a.toLowerCase() === '/pid');
      if (pidIdx < 0) {
        return { ok: false, reason: 'taskkill requires /pid <number>' };
      }
      const pid = args[pidIdx + 1];
      if (!pid || !/^\d+$/.test(pid)) {
        return { ok: false, reason: 'taskkill /pid argument must be numeric' };
      }
      return { ok: true };
    },
  },
  {
    command: 'kill',
    enabled: true,
    timeout_default_ms: 30_000,
    platforms: ['linux', 'darwin', 'freebsd', 'openbsd', 'sunos', 'aix'],
    description:
      'POSIX kill by PID. Must include a positive numeric PID. ' +
      'Banned: targets like -1 / 0 (kill everyone / process group leader).',
    validateArgs: (args) => {
      const positivePid = args.find((a) => /^\d+$/.test(a) && Number(a) > 0);
      if (!positivePid) {
        return { ok: false, reason: 'kill requires a positive numeric PID' };
      }
      if (args.some((a) => a === '-1' || a === '0' || a === '-0')) {
        return { ok: false, reason: 'kill -1 / 0 targets process groups — banned' };
      }
      return { ok: true };
    },
  },
  {
    command: 'netstat',
    enabled: true,
    timeout_default_ms: 30_000,
    description: 'Read-only network/port inspection.',
    // any args allowed — netstat is read-only.
  },
  {
    command: 'curl',
    enabled: true,
    timeout_default_ms: 30_000,
    description:
      'Read-only HTTP against loopback only (localhost / 127.0.0.1) for daemon introspection. ' +
      '/metrics, /healthz, /api/* without driving a browser. ' +
      'Banned: non-loopback URLs, write verbs (POST/PUT/PATCH/DELETE), uploads, basic-auth, --resolve smuggle.',
    validateArgs: (args) => {
      // Banned write/upload/auth flags
      const bannedFlags = new Set([
        '-T', '--upload-file',
        '-d', '--data', '--data-binary', '--data-raw', '--data-urlencode',
        '-F', '--form', '--form-string',
        '--cert', '--key',
        '-u', '--user',
      ]);
      for (const a of args) {
        if (bannedFlags.has(a)) {
          return { ok: false, reason: `curl ${a} is banned (write/upload/auth class)` };
        }
        if (a === '--resolve' || a === '--connect-to') {
          return { ok: false, reason: `curl ${a} is banned (loopback bypass vector)` };
        }
      }
      // Banned write verbs via -X / --request
      for (let i = 0; i < args.length; i++) {
        if ((args[i] === '-X' || args[i] === '--request') && i + 1 < args.length) {
          const verb = args[i + 1].toUpperCase();
          if (verb === 'POST' || verb === 'PUT' || verb === 'PATCH' || verb === 'DELETE') {
            return { ok: false, reason: `curl -X ${verb} is banned (read-only enforcement)` };
          }
        }
      }
      // URL enforcement: require explicit http:// or https:// loopback
      const url = args.find((a) => /^https?:\/\//i.test(a));
      if (url) {
        if (!/^https?:\/\/(localhost|127\.0\.0\.1)([:/]|$)/i.test(url)) {
          return { ok: false, reason: 'curl URL must be loopback (localhost or 127.0.0.1)' };
        }
      } else {
        // No explicit URL with protocol. Allow ONLY if all args are flags
        // (covers curl --version, curl --help, curl -V).
        const hasNonFlag = args.some((a) => !a.startsWith('-'));
        if (hasNonFlag) {
          return { ok: false, reason: 'curl URL must include explicit http:// or https:// loopback prefix' };
        }
      }
      return { ok: true };
    },
  },
  {
    command: 'node',
    enabled: false,
    timeout_default_ms: FIVE_MIN_MS,
    description:
      'Disabled by default. Arbitrary JS execution defeats the allowlist. ' +
      'Operator can flip via ~/.stavr/host-exec.json — only do so when you trust the caller.',
  },
];

/** Snapshot of the resolved allowlist (after applying operator restrictions). */
export type ResolvedAllowlist = AllowlistEntry[];

export function findEntry(
  list: ResolvedAllowlist,
  command: string,
): AllowlistEntry | undefined {
  return list.find((e) => e.command === command);
}

/**
 * The single chokepoint. Every host_exec call MUST flow through this — both
 * the live handler and the test corpus assert on the returned reason strings.
 */
export function validateAllowlistCall(
  list: ResolvedAllowlist,
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): AllowlistValidation {
  if (typeof command !== 'string' || command.length === 0) {
    return { allowed: false, reason: 'command must be a non-empty string' };
  }
  // Defense-in-depth — shell:false in the runner already prevents metachar
  // expansion, but rejecting these in the validator gives a clearer audit
  // entry than letting spawn() fail with ENOENT.
  if (/[;&|<>`$\n\r]/.test(command)) {
    return { allowed: false, reason: 'command contains shell metacharacters' };
  }
  if (command.includes('/') || command.includes('\\')) {
    return { allowed: false, reason: 'command must be a binary name, not a path' };
  }
  const entry = findEntry(list, command);
  if (!entry) {
    return { allowed: false, reason: 'command not in allowlist' };
  }
  if (!entry.enabled) {
    return { allowed: false, reason: `command '${command}' is disabled in allowlist` };
  }
  if (entry.platforms && !entry.platforms.includes(platform)) {
    return {
      allowed: false,
      reason: `command '${command}' is not available on platform '${platform}'`,
    };
  }
  if (entry.validateArgs) {
    const sub = entry.validateArgs(args);
    if (!sub.ok) {
      return { allowed: false, reason: sub.reason ?? 'arg pattern denied' };
    }
  }
  return { allowed: true, entry };
}
