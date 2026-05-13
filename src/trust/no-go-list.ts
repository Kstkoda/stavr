// Spec 48 Layer 3 — the no-go list (deny-override floor).
//
// Every action that passes tier/scope/decision still has to pass this gate.
// A match opens a fresh decision_request that cannot be auto-approved by any
// trust scope. Removing or weakening built-in entries requires editing this
// file and rebuilding cowire — the User can ADD entries via
// ~/.cowire/no-go-additions.ts but cannot disable the built-ins.

export type NoGoSeverity = 'high' | 'critical';
export type NoGoAuditLevel = 'standard' | 'mandatory_post_action_summary';

export interface NoGoMatcher {
  tool: string | string[];
  /** Structural match on tool args. Each value is either a literal or a RegExp. */
  arg_pattern?: Record<string, string | RegExp>;
  /** Free-text regex applied to known stringy arg fields (command, file_path, body…). */
  free_text_pattern?: RegExp;
  /** Optional runtime check. Returns true to confirm the match, false to skip. */
  runtime?: (args: Record<string, unknown>) => boolean;
}

export interface NoGoEntry {
  id: string;
  description: string;
  reason: string;
  matcher: NoGoMatcher;
  severity: NoGoSeverity;
  auditLevel?: NoGoAuditLevel;
}

export const STARTER_NO_GO_LIST: NoGoEntry[] = [
  {
    id: 'fs.rm_recursive_root',
    description: 'Recursive delete of system or home root',
    reason: 'rm -rf outside the worktree could destroy data the User did not intend to lose',
    matcher: {
      tool: ['Bash', 'PowerShell', 'shell'],
      free_text_pattern:
        /\b(rm\s+-rf|Remove-Item\s+-Recurse\s+-Force)\s+\/?(?!.*\.cowire-worktrees)/i,
    },
    severity: 'critical',
    auditLevel: 'mandatory_post_action_summary',
  },
  {
    id: 'git.force_push_default_branch',
    description: 'Force-push to main / master / default',
    reason: 'Force-push rewrites history on the canonical branch; recovery is hard',
    matcher: {
      tool: ['Bash', 'PowerShell', 'shell'],
      free_text_pattern:
        /git\s+push\s+(?:--force|--force-with-lease|-f)\s+\S+\s+(main|master|trunk|HEAD:(main|master|trunk))/i,
    },
    severity: 'critical',
  },
  {
    id: 'github.delete_repo',
    description: 'Delete a GitHub repository',
    reason: 'Repository deletion is effectively irreversible',
    matcher: { tool: 'github_delete_repo' },
    severity: 'critical',
  },
  {
    id: 'github.merge_to_default_under_seconds_old_pr',
    description: 'Merging a PR opened less than N seconds ago',
    reason: 'Too-fast merges suggest the Steward may not have reviewed properly',
    matcher: {
      tool: ['github_merge_pr', 'github.merge_pr'],
      // The pr-age runtime check (createdAt < 60s) lives at the call site —
      // the adapter must fetch the PR's createdAt, compute pr_age_seconds,
      // and attach it to args before invoking gatedAction. Without that
      // signal we don't fire (the merge would otherwise be unmatchable in
      // mocked-gh test environments). 60s is the spec default; configurable
      // via env COWIRE_NO_GO_FAST_MERGE_SECONDS for User installs.
      runtime: (args) => {
        const age = (args as { pr_age_seconds?: number }).pr_age_seconds;
        if (typeof age !== 'number') return false;
        const thresholdEnv = process.env.COWIRE_NO_GO_FAST_MERGE_SECONDS;
        const threshold = thresholdEnv ? Number(thresholdEnv) : 60;
        return age < threshold;
      },
    },
    severity: 'high',
  },
  {
    id: 'sql.drop_table_or_database',
    description: 'DROP TABLE or DROP DATABASE',
    reason: 'Schema destruction. The User should approve each such call individually.',
    matcher: {
      tool: ['Bash', 'PowerShell', 'shell'],
      free_text_pattern: /\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i,
    },
    severity: 'critical',
  },
  {
    id: 'net.curl_pipe_shell',
    description: 'curl | sh or wget | bash patterns',
    reason: 'Executing remote scripts blind is a common supply-chain attack vector',
    matcher: {
      tool: ['Bash', 'PowerShell', 'shell'],
      free_text_pattern:
        /\b(curl|wget|iwr|Invoke-WebRequest)\s+[^|]+\|\s*(sh|bash|zsh|pwsh|powershell)\b/i,
    },
    severity: 'critical',
  },
  {
    id: 'creds.read_ssh_or_aws',
    description: 'Read SSH or AWS credentials',
    reason: 'These files contain secrets that should never be in the Steward context window',
    matcher: {
      tool: ['Read', 'Bash', 'PowerShell', 'shell'],
      free_text_pattern: /(~\/\.ssh\/|\.aws\/credentials|\.aws\/config|id_rsa\b|id_ed25519\b)/i,
    },
    severity: 'critical',
  },
  {
    id: 'creds.read_env_outside_project',
    description: 'Read a .env file (project envs are scoped; system envs may carry unrelated secrets)',
    reason: 'Project envs are scoped; system envs may carry unrelated secrets',
    matcher: {
      tool: ['Read', 'Bash', 'PowerShell', 'shell'],
      free_text_pattern: /\.env(?:\.[a-z]+)?\b/i,
    },
    severity: 'high',
  },
  {
    id: 'self.modify_no_go_list',
    description: 'Editing the no-go list itself',
    reason: 'The Steward should not be able to weaken its own safety floor',
    matcher: {
      tool: ['Edit', 'Write'],
      arg_pattern: { file_path: /no-go-list\.ts$/ },
    },
    severity: 'critical',
  },
  {
    id: 'self.modify_trust_store',
    description: 'Editing trust scope storage directly',
    reason: 'Trust scopes should be granted through the proper API, not by patching the DB',
    matcher: {
      tool: ['Edit', 'Write'],
      arg_pattern: { file_path: /trust\/store\.ts$|trust_scopes\.db|trust-scopes-state/i },
    },
    severity: 'critical',
  },
  {
    id: 'comm.external_send',
    description: 'Sending email, Slack, or social posts to recipients other than the User',
    reason: "External communications carry the User's identity and reputation",
    matcher: {
      tool: ['send_email', 'slack_post_message', 'twitter_post'],
    },
    severity: 'critical',
  },
];

/**
 * Severity → decision timeout (seconds). The spec says critical gets 10 min,
 * high gets the default 5 min; both default to reject-on-timeout.
 */
export function noGoTimeoutSec(severity: NoGoSeverity): number {
  return severity === 'critical' ? 600 : 300;
}

function toolMatches(matcher: NoGoMatcher, tool: string): boolean {
  if (Array.isArray(matcher.tool)) return matcher.tool.includes(tool);
  return matcher.tool === tool;
}

/**
 * Extract every stringy value from the args object that could plausibly carry
 * a command/path/body for free-text matching. We intentionally keep this loose
 * so a `command`, `args`, `body`, `file_path` etc. all get scanned.
 */
function collectStringy(value: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      for (const inner of Object.values(v as Record<string, unknown>)) walk(inner);
    }
  };
  walk(value);
  return out;
}

function argPatternMatches(
  pattern: Record<string, string | RegExp>,
  args: Record<string, unknown>,
): boolean {
  for (const [key, expected] of Object.entries(pattern)) {
    const got = args[key];
    if (typeof got !== 'string') return false;
    if (expected instanceof RegExp) {
      if (!expected.test(got)) return false;
    } else if (got !== expected) {
      return false;
    }
  }
  return true;
}

/** Returns the first matching no-go entry, or undefined if the action is clean. */
export function findNoGoMatch(
  list: NoGoEntry[],
  tool: string,
  args: Record<string, unknown> | unknown,
): NoGoEntry | undefined {
  const argsObj =
    args && typeof args === 'object' && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {};
  for (const entry of list) {
    if (!toolMatches(entry.matcher, tool)) continue;
    if (entry.matcher.arg_pattern && !argPatternMatches(entry.matcher.arg_pattern, argsObj)) {
      continue;
    }
    if (entry.matcher.free_text_pattern) {
      const stringy = collectStringy(argsObj);
      const hit = stringy.some((s) => entry.matcher.free_text_pattern!.test(s));
      if (!hit) continue;
    }
    if (entry.matcher.runtime && !entry.matcher.runtime(argsObj)) continue;
    return entry;
  }
  return undefined;
}

// ---- live (mutable) list with optional user additions -----------------------

let LIVE_LIST: NoGoEntry[] = [...STARTER_NO_GO_LIST];

/** Replace the live list (used by the daemon-boot loader and by tests). */
export function setLiveNoGoList(entries: NoGoEntry[]): void {
  LIVE_LIST = [...entries];
}

export function getLiveNoGoList(): NoGoEntry[] {
  return LIVE_LIST;
}

/** Convenience: applies findNoGoMatch against the live list. */
export function checkNoGo(
  tool: string,
  args: Record<string, unknown> | unknown,
): NoGoEntry | undefined {
  return findNoGoMatch(LIVE_LIST, tool, args);
}

/**
 * Merge User additions from ~/.cowire/no-go-additions.ts (loaded by the
 * daemon at boot — see daemon.ts). User can ADD but never REMOVE built-ins,
 * so we always start from STARTER_NO_GO_LIST.
 */
export function mergeUserAdditions(extras: NoGoEntry[]): NoGoEntry[] {
  const seen = new Set(STARTER_NO_GO_LIST.map((e) => e.id));
  const merged = [...STARTER_NO_GO_LIST];
  for (const e of extras) {
    if (seen.has(e.id)) continue; // can't override built-ins
    merged.push(e);
    seen.add(e.id);
  }
  return merged;
}
