/**
 * Spec 49 / Stream C C1 — Steward orchestrates a privacy-tracker bug fix.
 *
 * This module is the orchestration glue: given a GitHub issue reference, it
 * (1) fetches the issue via `gh issue view`, (2) composes a bug-fix brief,
 * (3) proposes a narrowly-scoped trust scope (github.create_pr +
 * github.create_pr_comment for the issue's repo only), (4) optionally
 * auto-grants the scope when the operator has pre-consented via the
 * STAVR_AUTO_APPROVE_BUG_FIXES env var, and (5) sends the brief to the
 * daemon-hosted Steward via the existing /dashboard/steward/prompt route
 * (spec 49 Layer 2).
 *
 * What this module does NOT do:
 *  - Spawn a CC worker — that's the Steward subprocess's job (#22, not yet
 *    in this branch's base). Until #22 merges, the steward_prompt event is
 *    consumed by the operator via the dashboard chat panel.
 *  - Open the PR — the worker does that, once dispatched.
 *
 * The shape is fixed now so when #22 lands, the only thing that changes is
 * who handles the steward_prompt event.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const execFileP = promisify(execFile);

export interface IssueRef {
  owner: string;
  repo: string;
  number: number;
}

export interface ParsedIssueRef extends IssueRef {
  /** Convenience: "owner/repo". */
  repo_full: string;
}

const ISSUE_REF_PATTERNS: Array<{ re: RegExp; map: (m: RegExpExecArray) => IssueRef }> = [
  // owner/repo#42
  {
    re: /^([\w.-]+)\/([\w.-]+)#(\d+)$/,
    map: (m) => ({ owner: m[1], repo: m[2], number: Number(m[3]) }),
  },
  // owner/repo/issues/42
  {
    re: /^([\w.-]+)\/([\w.-]+)\/issues\/(\d+)$/,
    map: (m) => ({ owner: m[1], repo: m[2], number: Number(m[3]) }),
  },
  // https?://github.com/owner/repo/issues/42
  {
    re: /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)\/?$/,
    map: (m) => ({ owner: m[1], repo: m[2], number: Number(m[3]) }),
  },
];

/**
 * Parses any of the three accepted issue-ref forms: `owner/repo#42`,
 * `owner/repo/issues/42`, or the full github.com URL. Returns the canonical
 * shape with a `repo_full` convenience field. Throws on unparseable input
 * with a message that lists the accepted forms.
 */
export function parseIssueRef(input: string): ParsedIssueRef {
  const s = input.trim();
  for (const p of ISSUE_REF_PATTERNS) {
    const m = p.re.exec(s);
    if (m) {
      const ref = p.map(m);
      return { ...ref, repo_full: `${ref.owner}/${ref.repo}` };
    }
  }
  throw new Error(
    `steward bug-fix: cannot parse issue ref '${input}'. Accepted forms: ` +
      'owner/repo#42, owner/repo/issues/42, https://github.com/owner/repo/issues/42.',
  );
}

export interface IssueDetails {
  number: number;
  title: string;
  body: string;
  state: string;
  labels: Array<{ name: string }>;
  url?: string;
}

export type GhExec = (
  file: string,
  args: string[],
  options: { maxBuffer?: number; timeout?: number },
) => Promise<{ stdout: string; stderr: string }>;

/**
 * Production `gh` executor — wraps the real `execFile`. Tests pass a stub.
 *
 * `STAVR_GH_BIN` overrides the binary path — used by integration tests so they
 * can point at a fake shim by absolute path (PATH-prepending a shim doesn't
 * always win on Windows because execFile honours PATHEXT in subtly different
 * ways than `cmd /c`). Production users never need to set this.
 *
 * When the override ends in `.cmd` / `.bat` on Windows, we route through the
 * shell so execFile can dispatch the batch file — direct exec of `.cmd` from
 * Node yields `spawn EINVAL`.
 */
export const defaultGhExec: GhExec = (file, args, options) => {
  const bin = process.env.STAVR_GH_BIN || file;
  const needShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
  return execFileP(bin, args, { ...options, shell: needShell });
};

/**
 * Fetches an issue's details via `gh issue view`. Surfaces a clear error
 * when `gh` is missing or unauthenticated, distinguishing those cases from
 * a real fetch failure so operators know whether to install / re-login.
 */
export async function fetchIssue(
  ref: ParsedIssueRef,
  exec: GhExec = defaultGhExec,
): Promise<IssueDetails> {
  try {
    const { stdout } = await exec(
      'gh',
      [
        'issue',
        'view',
        String(ref.number),
        '--repo',
        ref.repo_full,
        '--json',
        'number,title,body,state,labels,url',
      ],
      { maxBuffer: 4 * 1024 * 1024, timeout: 30_000 },
    );
    const parsed = JSON.parse(stdout) as IssueDetails;
    return {
      number: parsed.number,
      title: parsed.title ?? '',
      body: parsed.body ?? '',
      state: parsed.state ?? 'unknown',
      labels: Array.isArray(parsed.labels) ? parsed.labels : [],
      url: parsed.url,
    };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === 'ENOENT') {
      throw new Error(
        "steward bug-fix: `gh` not found on PATH. Install GitHub CLI from https://cli.github.com/ first.",
      );
    }
    if (typeof e.stderr === 'string' && /not authenticated/i.test(e.stderr)) {
      throw new Error(
        'steward bug-fix: `gh` is installed but not authenticated. Run `gh auth login` first.',
      );
    }
    throw new Error(
      `steward bug-fix: failed to read issue ${ref.repo_full}#${ref.number}: ${e.message}`,
    );
  }
}

export interface BugFixBriefArgs {
  ref: ParsedIssueRef;
  issue: IssueDetails;
}

/**
 * Composes the Markdown brief the Steward (or, until #22 lands, the operator
 * reading the dashboard chat panel) consumes. The brief is intentionally
 * mechanical — it doesn't editorialise on what the fix should be, just lays
 * out what was filed and what the next step is.
 */
export function composeBugFixBrief(args: BugFixBriefArgs): string {
  const { ref, issue } = args;
  const labels = issue.labels.map((l) => l.name).join(', ') || 'none';
  const body = issue.body.trim().length > 0 ? issue.body.trim() : '_(no body)_';
  const urlLine = issue.url ? `URL: ${issue.url}\n` : '';
  return `# Bug-fix request: ${ref.repo_full}#${ref.number}

Title: ${issue.title}
State: ${issue.state}
Labels: ${labels}
${urlLine}
## Issue body

${body}

## Requested action

1. Read the issue in full, including any in-thread context the body links to.
2. Reproduce locally if the report is reproducible.
3. Propose a minimal diff that fixes the reported defect without expanding
   scope (do not refactor or restyle adjacent code).
4. Write or update at least one regression test that fails before the fix
   and passes after.
5. Open a PR against the default branch of ${ref.repo_full} titled
   \`fix(${ref.repo_full.split('/')[1]}): ${issue.title} [cc-mega-c1]\` (or
   include enough scope information in the title that a reviewer can route
   it). Reference this issue in the PR body with \`Fixes #${ref.number}\`.
6. Stop after the PR opens — wait for review before any follow-up.
`;
}

export interface ScopeProposalArgs {
  ref: ParsedIssueRef;
  briefId: string;
  /** Whole hours (default 6) from now until the scope expires. */
  ttlHours?: number;
  /** Max action count (default 20) — covers PR open + a few comment rounds. */
  actionCap?: number;
  now?: () => Date;
}

export interface ScopeProposal {
  scope_id: string;
  title: string;
  description: string;
  allowed_actions: Array<{ tool: string; param_constraints?: Record<string, unknown>; reason?: string }>;
  forbidden_actions?: Array<{ tool: string; reason?: string }>;
  expires_at: string;
  expires_after_actions: number;
  reporting: { cadence: 'every-action' | 'every-5-actions' | 'every-15-min' | 'on-completion-only'; channels: string[] };
  spec_url?: string;
}

/**
 * Builds the trust-scope proposal payload for the bug fix — narrowly scoped
 * to PR creation + commentary on the issue's repo only. Forbidden_actions
 * explicitly lists merge/close to make it clear the scope can open but not
 * land changes (mirrors the spec-48 no-go-list philosophy).
 */
export function buildScopeProposal(args: ScopeProposalArgs): ScopeProposal {
  const now = (args.now ?? (() => new Date()))();
  const ttlHours = args.ttlHours ?? 6;
  const actionCap = args.actionCap ?? 20;
  return {
    scope_id: `scope-bug-fix-${args.ref.repo}-${args.ref.number}-${args.briefId}`,
    title: `bug-fix: ${args.ref.repo_full}#${args.ref.number}`,
    description:
      `Scope for the Steward to open a fix PR against ${args.ref.repo_full} for issue #${args.ref.number}. ` +
      'Auto-proposed by `stavr steward bug-fix`. Allows PR creation and PR commentary; ' +
      'forbids merge / close / branch deletion. Action cap covers PR open plus a small number of follow-up comments.',
    allowed_actions: [
      {
        tool: 'github.create_pr',
        param_constraints: { repo: args.ref.repo_full },
        reason: 'Open the fix PR.',
      },
      {
        tool: 'github.create_pr_comment',
        param_constraints: { repo: args.ref.repo_full },
        reason: 'Reply to reviewer feedback on the fix PR.',
      },
      {
        tool: 'github.create_issue_comment',
        param_constraints: { repo: args.ref.repo_full, number: args.ref.number },
        reason: 'Comment on the originating issue with progress / PR link.',
      },
    ],
    forbidden_actions: [
      { tool: 'github.merge_pr', reason: 'Merging is the operator\'s call, not the Steward\'s.' },
      { tool: 'github.close_issue', reason: 'Closing the source issue is the operator\'s call.' },
    ],
    expires_at: new Date(now.getTime() + ttlHours * 60 * 60 * 1000).toISOString(),
    expires_after_actions: actionCap,
    reporting: { cadence: 'every-action', channels: ['dashboard', 'event-log'] },
  };
}

export interface AutoApprovalDecision {
  granted: boolean;
  reason: string;
}

/**
 * Centralises the STAVR_AUTO_APPROVE_BUG_FIXES env-var check. Returns a
 * decision record (not just a boolean) so the CLI can log *why* it auto-
 * approved or didn't — important for the audit log.
 */
export function decideAutoApproval(env: NodeJS.ProcessEnv = process.env): AutoApprovalDecision {
  const raw = (env.STAVR_AUTO_APPROVE_BUG_FIXES ?? '').trim();
  if (raw === '1' || raw.toLowerCase() === 'true') {
    return { granted: true, reason: 'STAVR_AUTO_APPROVE_BUG_FIXES=1 in env' };
  }
  return { granted: false, reason: 'no STAVR_AUTO_APPROVE_BUG_FIXES env var set' };
}

/** Brief identifier — short and human-readable. */
export function generateBriefId(): string {
  return randomUUID().slice(0, 8);
}
