import { z } from 'zod';

export type Tier = 'auto' | 'confirm' | 'never' | 'per-spawner';

export type Stability = 'stable' | 'beta' | 'experimental';

export type Category =
  | 'core'
  | 'decision'
  | 'github-read'
  | 'github-write'
  | 'worker'
  | 'trust-scope';

export interface ToolDefinition {
  name: string;
  tier: Tier;
  category: Category;
  since: string;
  stability: Stability;
  description: string;
  inputSchema: z.ZodTypeAny;
  outputSchema: z.ZodTypeAny;
  example?: { args: unknown; result: unknown };
  sideEffects: string[];
  errorModes: string[];
  seeAlso: string[];
}

const CorrelationId = z.string().optional();
const TenantId = z.string().optional();
const SourceAgent = z.string();

const EventEnvelope = z.object({
  event_id: z.string(),
  persisted_at: z.string(),
});

const DecisionOption = z.object({ id: z.string().min(1), label: z.string().min(1) });

const ActionMatcher = z.object({
  tool: z.string().min(1),
  param_constraints: z.record(z.unknown()).optional(),
  reason: z.string().optional(),
});

const ReportingZ = z.object({
  cadence: z.enum(['every-action', 'every-5-actions', 'every-15-min', 'on-completion-only']),
  channels: z.array(z.enum(['chat', 'event-log', 'dashboard', 'slack', 'email'])).min(1),
});

const GhError = z.object({
  code: z.literal('gh_failed'),
  message: z.string(),
  exit_code: z.number().optional(),
  stderr: z.string().optional(),
});

const GatedDeclined = z.object({
  ok: z.literal(false),
  reason: z.string(),
  correlation_id: z.string().optional(),
});

const SerializedWorker = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  cwd: z.string(),
  pid: z.number().int().optional(),
  status: z.enum(['starting', 'running', 'idle', 'terminated', 'crashed']),
  started_at: z.string(),
  ended_at: z.string().optional(),
  last_activity_at: z.string().optional(),
  metadata: z.record(z.unknown()),
  termination_reason: z.string().optional(),
  exit_code: z.number().int().optional(),
});

const TrustScope = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  status: z.enum(['proposed', 'active', 'expired', 'revoked', 'completed']),
  allowed_actions: z.array(ActionMatcher),
  forbidden_actions: z.array(ActionMatcher).optional(),
  reporting: ReportingZ,
  proposed_at: z.string(),
  expires_at: z.string(),
  expires_after_actions: z.number().int().positive().optional(),
  actions_executed: z.number().int().nonnegative(),
  granted_at: z.string().optional(),
  granted_by: z.string().optional(),
  spec_url: z.string().optional(),
});

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  // ─── Core event bus ─────────────────────────────────────────────────────
  {
    name: 'emit_event',
    tier: 'auto',
    category: 'core',
    since: '0.1.0',
    stability: 'stable',
    description:
      'Publish an event. Validates payload against the event taxonomy, persists, fans out to subscribers.',
    inputSchema: z.object({
      kind: z.string(),
      payload: z.unknown(),
      correlation_id: CorrelationId,
      tenant_id: TenantId,
      source_agent: SourceAgent,
      at: z.string().datetime().optional(),
    }),
    outputSchema: EventEnvelope,
    sideEffects: [
      'writes one row to the events table',
      'fans out a `notifications/event/published` MCP notification to every subscribed session',
    ],
    errorModes: [
      'unknown event kind → tool returns isError with `unknown event kind: <kind>`',
      'payload does not match the schema for `kind` → `invalid payload for <kind>: ...`',
    ],
    seeAlso: ['get_events', 'subscribe_to_events', 'docs/event-taxonomy.md'],
  },
  {
    name: 'subscribe_to_events',
    tier: 'auto',
    category: 'core',
    since: '0.1.0',
    stability: 'stable',
    description:
      'Register this MCP session to receive notifications/event/published for the given kinds. Use ["*"] for all.',
    inputSchema: z.object({
      kinds: z.array(z.string()).min(1),
      since_event_id: z.string().optional(),
    }),
    outputSchema: z.object({
      subscription_id: z.string(),
      kinds: z.array(z.string()),
      replayed_events: z.number().int().nonnegative(),
    }),
    sideEffects: [
      'attaches a subscription to the current MCP session (cleared when the session disconnects)',
      'if `since_event_id` is set, replays missed events of the requested kinds to the caller',
    ],
    errorModes: ['empty kinds array rejected by Zod'],
    seeAlso: ['unsubscribe', 'emit_event', 'get_events'],
  },
  {
    name: 'unsubscribe',
    tier: 'auto',
    category: 'core',
    since: '0.1.0',
    stability: 'stable',
    description: 'Remove kinds from this session subscription. Omit kinds to remove all.',
    inputSchema: z.object({ kinds: z.array(z.string()).optional() }),
    outputSchema: z.object({ ok: z.literal(true) }),
    sideEffects: ['removes the named kinds from this session\'s subscription, or all kinds if omitted'],
    errorModes: ['none — unsubscribing a non-subscribed kind is a no-op'],
    seeAlso: ['subscribe_to_events'],
  },
  {
    name: 'get_events',
    tier: 'auto',
    category: 'core',
    since: '0.1.0',
    stability: 'stable',
    description:
      'Query the event log. Cursor on since_event_id (event id from a prior call).',
    inputSchema: z.object({
      since_event_id: z.string().optional(),
      kinds: z.array(z.string()).optional(),
      source_agent: z.string().optional(),
      tenant_id: z.string().optional(),
      limit: z.number().int().min(1).max(5000).optional(),
    }),
    outputSchema: z.object({
      events: z.array(z.unknown()),
      next_cursor: z.string().optional(),
    }),
    sideEffects: ['read-only SQLite query'],
    errorModes: ['limit out of range (1..5000) rejected by Zod'],
    seeAlso: ['subscribe_to_events', 'docs/event-taxonomy.md'],
  },

  // ─── Decisions ───────────────────────────────────────────────────────────
  {
    name: 'await_decision',
    tier: 'auto',
    category: 'decision',
    since: '0.1.0',
    stability: 'stable',
    description:
      'Open a decision and block until a response arrives or the timeout fires. 30-min ceiling. If default_option_id is set, the call resolves with the default on timeout; otherwise it errors.',
    inputSchema: z.object({
      question: z.string().min(1),
      options: z.array(DecisionOption).min(1).max(8),
      default_option_id: z.string().optional(),
      timeout_sec: z.number().int().min(1).max(1800),
      correlation_id: z.string().optional(),
      tenant_id: z.string().optional(),
      source_agent: z.string().default('cc'),
    }),
    outputSchema: z.object({
      correlation_id: z.string(),
      chosen_option_id: z.string(),
      responder: z.string(),
      reason: z.string().optional(),
      timed_out: z.boolean(),
    }),
    sideEffects: [
      'creates a row in the decisions table',
      'publishes a `decision_request` event',
      'blocks the calling tool until a response arrives or the timeout fires',
      'on timeout with `default_option_id`, writes a `switch-default` response + `decision_response` event',
    ],
    errorModes: [
      'default_option_id not in options → isError',
      'timeout with no default → isError (`decision <id> timed out and no default was provided`)',
    ],
    seeAlso: ['respond_to_decision', 'docs/event-taxonomy.md'],
  },
  {
    name: 'respond_to_decision',
    tier: 'auto',
    category: 'decision',
    since: '0.1.0',
    stability: 'stable',
    description:
      'Resolve a pending decision. If the decision has already closed via switch-default fallback, this is recorded as a decision_late_response event but does not override the fallback.',
    inputSchema: z.object({
      correlation_id: z.string(),
      chosen_option_id: z.string(),
      reason: z.string().optional(),
      responder: z.string(),
    }),
    outputSchema: z.union([
      z.object({ ok: z.literal(true), responded_at: z.string() }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
    sideEffects: [
      'writes the response row + publishes `decision_response`',
      'on late reply, publishes `decision_late_response` and leaves the original fallback in place',
    ],
    errorModes: [
      '`not_found` — no decision with that correlation_id',
      '`already_responded` — decision already closed; late-response event is emitted instead',
    ],
    seeAlso: ['await_decision'],
  },

  // ─── GitHub reads (auto) ─────────────────────────────────────────────────
  {
    name: 'github.read_pr',
    tier: 'auto',
    category: 'github-read',
    since: '0.1.0',
    stability: 'stable',
    description:
      'Read a GitHub pull request by repo + number. Returns title, body, state, head/base refs, CI status summary, files changed, mergeability.',
    inputSchema: z.object({
      repo: z.string().min(1),
      number: z.number().int().min(1),
    }),
    outputSchema: z.record(z.unknown()),
    sideEffects: ['shells out to `gh pr view --json` (read-only)'],
    errorModes: ['gh CLI not authenticated or repo not visible → `{ code: "gh_failed", ... }`'],
    seeAlso: ['github.list_prs', 'github.read_pr_diff', 'github.list_pr_files'],
  },
  {
    name: 'github.list_prs',
    tier: 'auto',
    category: 'github-read',
    since: '0.1.0',
    stability: 'stable',
    description:
      'List pull requests for a repo. Returns summaries (number, title, state, author, head/base, updatedAt).',
    inputSchema: z.object({
      repo: z.string().min(1),
      state: z.enum(['open', 'closed', 'merged', 'all']).optional().default('open'),
      limit: z.number().int().min(1).max(200).optional().default(30),
    }),
    outputSchema: z.object({ prs: z.array(z.record(z.unknown())) }),
    sideEffects: ['shells out to `gh pr list --json` (read-only)'],
    errorModes: ['gh CLI failure → `gh_failed`'],
    seeAlso: ['github.read_pr'],
  },
  {
    name: 'github.read_issue',
    tier: 'auto',
    category: 'github-read',
    since: '0.1.0',
    stability: 'stable',
    description: 'Read a GitHub issue by repo + number.',
    inputSchema: z.object({
      repo: z.string().min(1),
      number: z.number().int().min(1),
    }),
    outputSchema: z.record(z.unknown()),
    sideEffects: ['shells out to `gh issue view --json` (read-only)'],
    errorModes: ['gh CLI failure → `gh_failed`'],
    seeAlso: ['github.list_issues', 'github.create_issue_comment'],
  },
  {
    name: 'github.list_issues',
    tier: 'auto',
    category: 'github-read',
    since: '0.1.0',
    stability: 'stable',
    description: 'List issues for a repo. Optional label filter.',
    inputSchema: z.object({
      repo: z.string().min(1),
      state: z.enum(['open', 'closed', 'merged', 'all']).optional().default('open'),
      label: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional().default(30),
    }),
    outputSchema: z.object({ issues: z.array(z.record(z.unknown())) }),
    sideEffects: ['shells out to `gh issue list --json` (read-only)'],
    errorModes: ['gh CLI failure → `gh_failed`'],
    seeAlso: ['github.read_issue'],
  },
  {
    name: 'github.read_commit',
    tier: 'auto',
    category: 'github-read',
    since: '0.1.0',
    stability: 'stable',
    description: 'Read commit detail (message, author, files changed, stats).',
    inputSchema: z.object({
      repo: z.string().min(1),
      sha: z.string().min(1).max(64),
    }),
    outputSchema: z.record(z.unknown()),
    sideEffects: ['shells out to `gh api repos/{repo}/commits/{sha}` (read-only)'],
    errorModes: ['gh CLI failure → `gh_failed`'],
    seeAlso: ['github.list_commits'],
  },
  {
    name: 'github.list_commits',
    tier: 'auto',
    category: 'github-read',
    since: '0.1.0',
    stability: 'stable',
    description: 'List commits on a branch (defaults to the default branch).',
    inputSchema: z.object({
      repo: z.string().min(1),
      branch: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional().default(30),
    }),
    outputSchema: z.object({ commits: z.array(z.record(z.unknown())) }),
    sideEffects: ['shells out to `gh api repos/{repo}/commits` (read-only)'],
    errorModes: ['gh CLI failure → `gh_failed`'],
    seeAlso: ['github.read_commit'],
  },
  {
    name: 'github.read_file',
    tier: 'auto',
    category: 'github-read',
    since: '0.1.0',
    stability: 'stable',
    description:
      'Read a file from a repo at a given ref. Returns decoded text content + metadata. Binary files surface as base64 in `raw_base64`.',
    inputSchema: z.object({
      repo: z.string().min(1),
      path: z.string().min(1),
      ref: z.string().optional(),
    }),
    outputSchema: z.union([
      z.object({ kind: z.literal('directory'), entries: z.array(z.record(z.unknown())) }),
      z.object({
        kind: z.literal('file'),
        path: z.string(),
        sha: z.string(),
        size: z.number(),
        html_url: z.string().optional(),
        download_url: z.string().optional(),
        content: z.string().optional(),
        raw_base64: z.string().optional(),
      }),
    ]),
    sideEffects: ['shells out to `gh api repos/{repo}/contents/{path}` (read-only)'],
    errorModes: ['gh CLI failure → `gh_failed`'],
    seeAlso: ['github.read_pr_diff'],
  },
  {
    name: 'github.list_workflow_runs',
    tier: 'auto',
    category: 'github-read',
    since: '0.1.0',
    stability: 'stable',
    description: 'List GitHub Actions workflow runs for a repo. Optional workflow filter (name or filename).',
    inputSchema: z.object({
      repo: z.string().min(1),
      workflow: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional().default(20),
    }),
    outputSchema: z.object({ runs: z.array(z.record(z.unknown())) }),
    sideEffects: ['shells out to `gh run list --json` (read-only)'],
    errorModes: ['gh CLI failure → `gh_failed`'],
    seeAlso: ['github.read_workflow_run'],
  },
  {
    name: 'github.read_workflow_run',
    tier: 'auto',
    category: 'github-read',
    since: '0.1.0',
    stability: 'stable',
    description: 'Read a single GitHub Actions workflow run with job statuses.',
    inputSchema: z.object({
      repo: z.string().min(1),
      run_id: z.number().int().min(1),
    }),
    outputSchema: z.record(z.unknown()),
    sideEffects: ['shells out to `gh run view --json` (read-only)'],
    errorModes: ['gh CLI failure → `gh_failed`'],
    seeAlso: ['github.list_workflow_runs'],
  },
  {
    name: 'github.read_pr_diff',
    tier: 'auto',
    category: 'github-read',
    since: '0.1.0',
    stability: 'stable',
    description:
      'Unified diff for a PR as plain text. Truncated to 1 MiB; if truncated, `truncated: true` and `bytes_truncated` are set.',
    inputSchema: z.object({
      repo: z.string().min(1),
      number: z.number().int().min(1),
    }),
    outputSchema: z.object({
      diff: z.string(),
      truncated: z.boolean(),
      bytes: z.number().int().nonnegative(),
      bytes_truncated: z.number().int().nonnegative(),
    }),
    sideEffects: ['shells out to `gh pr diff` (read-only)'],
    errorModes: ['gh CLI failure → `gh_failed`'],
    seeAlso: ['github.read_pr', 'github.list_pr_files'],
  },
  {
    name: 'github.list_pr_files',
    tier: 'auto',
    category: 'github-read',
    since: '0.1.0',
    stability: 'stable',
    description: 'List files changed in a PR with additions / deletions per file.',
    inputSchema: z.object({
      repo: z.string().min(1),
      number: z.number().int().min(1),
    }),
    outputSchema: z.object({ files: z.array(z.record(z.unknown())) }),
    sideEffects: ['shells out to `gh pr view --json files` (read-only)'],
    errorModes: ['gh CLI failure → `gh_failed`'],
    seeAlso: ['github.read_pr_diff'],
  },
  {
    name: 'github.read_pr_review_comments',
    tier: 'auto',
    category: 'github-read',
    since: '0.1.0',
    stability: 'stable',
    description:
      'List inline review comments on a PR (the line-by-line review comments, not issue comments).',
    inputSchema: z.object({
      repo: z.string().min(1),
      number: z.number().int().min(1),
    }),
    outputSchema: z.object({ comments: z.array(z.record(z.unknown())) }),
    sideEffects: ['shells out to `gh api repos/{repo}/pulls/{n}/comments` (read-only)'],
    errorModes: ['gh CLI failure → `gh_failed`'],
    seeAlso: ['github.create_pr_comment'],
  },
  {
    name: 'github.list_labels',
    tier: 'auto',
    category: 'github-read',
    since: '0.1.0',
    stability: 'stable',
    description: 'List labels defined in a repo (name, color, description).',
    inputSchema: z.object({ repo: z.string().min(1) }),
    outputSchema: z.object({ labels: z.array(z.record(z.unknown())) }),
    sideEffects: ['shells out to `gh label list --json` (read-only)'],
    errorModes: ['gh CLI failure → `gh_failed`'],
    seeAlso: ['github.add_labels', 'github.remove_labels'],
  },
  {
    name: 'github.list_branches',
    tier: 'auto',
    category: 'github-read',
    since: '0.1.0',
    stability: 'stable',
    description:
      'List branches in a repo (name + head sha + protection flag). Capped at 100 per call — pagination is not exposed in v1.',
    inputSchema: z.object({ repo: z.string().min(1) }),
    outputSchema: z.object({
      branches: z.array(
        z.object({ name: z.string(), sha: z.string().optional(), protected: z.boolean() }),
      ),
      capped_at: z.literal(100),
    }),
    sideEffects: ['shells out to `gh api repos/{repo}/branches?per_page=100` (read-only)'],
    errorModes: ['gh CLI failure → `gh_failed`'],
    seeAlso: ['github.list_commits'],
  },

  // ─── GitHub writes (confirm tier) ───────────────────────────────────────
  {
    name: 'github.create_pr',
    tier: 'confirm',
    category: 'github-write',
    since: '0.1.0',
    stability: 'stable',
    description:
      'Create a GitHub pull request. Gated by await_decision (CONFIRM tier). On approval, runs `gh pr create`. Returns { ok, pr_url, pr_number } on success.',
    inputSchema: z.object({
      repo: z.string().min(1),
      head: z.string().min(1),
      base: z.string().min(1),
      title: z.string().min(1),
      body: z.string().default(''),
      draft: z.boolean().optional().default(false),
    }),
    outputSchema: z.union([
      z.object({
        ok: z.literal(true),
        correlation_id: z.string(),
        pr_url: z.string(),
        pr_number: z.number().int().optional(),
      }),
      GatedDeclined,
    ]),
    sideEffects: [
      'opens an `await_decision` (CONFIRM gate) unless a matching trust scope authorizes auto-approval',
      'on approve: shells out to `gh pr create` and emits a `pr_opened` event',
      'on reject/timeout: no PR created, no `pr_opened` event',
    ],
    errorModes: [
      'rejected_by_user (gated decline) → `{ ok: false, reason: "rejected_by_user" }`',
      'gh failed → `{ code: "gh_failed", ... }`',
    ],
    seeAlso: ['await_decision', 'trust_scope_propose', 'github.merge_pr'],
  },
  {
    name: 'github.merge_pr',
    tier: 'confirm',
    category: 'github-write',
    since: '0.1.0',
    stability: 'stable',
    description:
      'Merge a pull request. Gated by await_decision. Always squash + delete-branch in v1. Returns { ok, merged_sha }.',
    inputSchema: z.object({
      repo: z.string().min(1),
      number: z.number().int().min(1),
    }),
    outputSchema: z.union([
      z.object({
        ok: z.literal(true),
        correlation_id: z.string(),
        merged_sha: z.string().optional(),
      }),
      GatedDeclined,
    ]),
    sideEffects: [
      'opens an `await_decision` (CONFIRM gate)',
      'on approve: shells out to `gh pr merge --squash --delete-branch`',
      'force/non-squash variants are NEVER tier — see ADR-018',
    ],
    errorModes: ['rejected_by_user', 'gh_failed'],
    seeAlso: ['github.create_pr', 'await_decision'],
  },
  {
    name: 'github.create_issue',
    tier: 'confirm',
    category: 'github-write',
    since: '0.1.0',
    stability: 'stable',
    description:
      'Create a GitHub issue. Gated by await_decision. Returns { ok, issue_url, issue_number }.',
    inputSchema: z.object({
      repo: z.string().min(1),
      title: z.string().min(1),
      body: z.string().default(''),
      labels: z.array(z.string().min(1)).optional(),
    }),
    outputSchema: z.union([
      z.object({
        ok: z.literal(true),
        correlation_id: z.string(),
        issue_url: z.string(),
        issue_number: z.number().int().optional(),
      }),
      GatedDeclined,
    ]),
    sideEffects: ['gated by await_decision; on approve: `gh issue create`'],
    errorModes: ['rejected_by_user', 'gh_failed'],
    seeAlso: ['github.close_issue', 'github.create_issue_comment'],
  },
  {
    name: 'github.create_issue_comment',
    tier: 'confirm',
    category: 'github-write',
    since: '0.1.0',
    stability: 'stable',
    description:
      'Post a comment on an issue. Gated by await_decision. Returns { ok, comment_url }.',
    inputSchema: z.object({
      repo: z.string().min(1),
      number: z.number().int().min(1),
      body: z.string().min(1),
    }),
    outputSchema: z.union([
      z.object({ ok: z.literal(true), correlation_id: z.string(), comment_url: z.string() }),
      GatedDeclined,
    ]),
    sideEffects: ['gated by await_decision; on approve: `gh issue comment`'],
    errorModes: ['rejected_by_user', 'gh_failed'],
    seeAlso: ['github.read_issue'],
  },
  {
    name: 'github.create_pr_comment',
    tier: 'confirm',
    category: 'github-write',
    since: '0.1.0',
    stability: 'stable',
    description:
      'Post a comment on a pull request. Gated by await_decision. Returns { ok, comment_url }.',
    inputSchema: z.object({
      repo: z.string().min(1),
      number: z.number().int().min(1),
      body: z.string().min(1),
    }),
    outputSchema: z.union([
      z.object({ ok: z.literal(true), correlation_id: z.string(), comment_url: z.string() }),
      GatedDeclined,
    ]),
    sideEffects: ['gated by await_decision; on approve: `gh pr comment`'],
    errorModes: ['rejected_by_user', 'gh_failed'],
    seeAlso: ['github.read_pr'],
  },
  {
    name: 'github.close_issue',
    tier: 'confirm',
    category: 'github-write',
    since: '0.1.0',
    stability: 'stable',
    description: 'Close an issue. Optionally posts a closing comment. Gated by await_decision.',
    inputSchema: z.object({
      repo: z.string().min(1),
      number: z.number().int().min(1),
      comment: z.string().optional(),
    }),
    outputSchema: z.union([
      z.object({ ok: z.literal(true), correlation_id: z.string() }),
      GatedDeclined,
    ]),
    sideEffects: ['gated by await_decision; on approve: `gh issue close`'],
    errorModes: ['rejected_by_user', 'gh_failed'],
    seeAlso: ['github.reopen_issue'],
  },
  {
    name: 'github.reopen_issue',
    tier: 'confirm',
    category: 'github-write',
    since: '0.1.0',
    stability: 'stable',
    description:
      'Reopen a previously closed issue. Optionally posts a comment. Gated by await_decision.',
    inputSchema: z.object({
      repo: z.string().min(1),
      number: z.number().int().min(1),
      comment: z.string().optional(),
    }),
    outputSchema: z.union([
      z.object({ ok: z.literal(true), correlation_id: z.string() }),
      GatedDeclined,
    ]),
    sideEffects: ['gated by await_decision; on approve: `gh issue reopen`'],
    errorModes: ['rejected_by_user', 'gh_failed'],
    seeAlso: ['github.close_issue'],
  },
  {
    name: 'github.add_labels',
    tier: 'confirm',
    category: 'github-write',
    since: '0.1.0',
    stability: 'stable',
    description:
      'Add labels to an issue or PR. Gated by await_decision. Returns { ok, labels_after }.',
    inputSchema: z.object({
      repo: z.string().min(1),
      number: z.number().int().min(1),
      labels: z.array(z.string().min(1)).min(1),
    }),
    outputSchema: z.union([
      z.object({
        ok: z.literal(true),
        correlation_id: z.string(),
        labels_after: z.array(z.string()),
      }),
      GatedDeclined,
    ]),
    sideEffects: ['gated by await_decision; on approve: `gh issue edit --add-label`'],
    errorModes: ['rejected_by_user', 'gh_failed'],
    seeAlso: ['github.remove_labels', 'github.list_labels'],
  },
  {
    name: 'github.remove_labels',
    tier: 'confirm',
    category: 'github-write',
    since: '0.1.0',
    stability: 'stable',
    description:
      'Remove labels from an issue or PR. Gated by await_decision. Returns { ok, labels_after }.',
    inputSchema: z.object({
      repo: z.string().min(1),
      number: z.number().int().min(1),
      labels: z.array(z.string().min(1)).min(1),
    }),
    outputSchema: z.union([
      z.object({
        ok: z.literal(true),
        correlation_id: z.string(),
        labels_after: z.array(z.string()),
      }),
      GatedDeclined,
    ]),
    sideEffects: ['gated by await_decision; on approve: `gh issue edit --remove-label`'],
    errorModes: ['rejected_by_user', 'gh_failed'],
    seeAlso: ['github.add_labels'],
  },
  {
    name: 'github.request_pr_review',
    tier: 'confirm',
    category: 'github-write',
    since: '0.1.0',
    stability: 'stable',
    description:
      'Request a review on a pull request from one or more reviewers. Gated by await_decision.',
    inputSchema: z.object({
      repo: z.string().min(1),
      number: z.number().int().min(1),
      reviewers: z.array(z.string().min(1)).min(1),
    }),
    outputSchema: z.union([
      z.object({ ok: z.literal(true), correlation_id: z.string() }),
      GatedDeclined,
    ]),
    sideEffects: ['gated by await_decision; on approve: `gh pr edit --add-reviewer`'],
    errorModes: ['rejected_by_user', 'gh_failed'],
    seeAlso: ['github.create_pr'],
  },

  // ─── Worker orchestration ────────────────────────────────────────────────
  {
    name: 'worker_list_types',
    tier: 'auto',
    category: 'worker',
    since: '0.1.0',
    stability: 'stable',
    description: 'List registered worker types and their spawn parameter schemas. Auto-tier.',
    inputSchema: z.object({}),
    outputSchema: z.object({
      types: z.array(
        z.object({
          type: z.string(),
          displayName: z.string(),
          description: z.string(),
          tier: z.enum(['auto', 'confirm', 'never']),
          paramsSchema: z.record(z.unknown()),
        }),
      ),
    }),
    sideEffects: ['read-only registry lookup'],
    errorModes: ['none'],
    seeAlso: ['worker_spawn'],
  },
  {
    name: 'worker_spawn',
    tier: 'per-spawner',
    category: 'worker',
    since: '0.1.0',
    stability: 'stable',
    description:
      'Spawn a worker of the given type. Tier comes from the spawner; confirm-tier spawners gate on await_decision. Built-in spawners (`cc`, `shell`) are CONFIRM tier.',
    inputSchema: z.object({
      type: z.string().min(1),
      name: z.string().min(1).max(128),
      params: z
        .union([z.record(z.unknown()), z.string()])
        .describe(
          'Spawner-specific params. Either an object matching the spawner schema, or a JSON-encoded string (some MCP clients serialize unknowns to strings).',
        ),
    }),
    outputSchema: z.object({
      worker: SerializedWorker,
      gated: z.boolean(),
    }),
    sideEffects: [
      'CONFIRM-tier spawners open an await_decision first',
      'on approve: creates a worker record + spawns the child process',
      'emits `worker_spawned` and (for cc) a follow-up `worker_progress`/`worker_activity` stream',
    ],
    errorModes: [
      'unknown worker type → OrchestratorError(code=`unknown_type`)',
      'duplicate name → OrchestratorError(code=`duplicate_name`)',
      'spawner-specific failures (e.g. cc: git fetch/worktree errors)',
    ],
    seeAlso: ['worker_list_types', 'worker_status', 'worker_terminate'],
  },
  {
    name: 'worker_list',
    tier: 'auto',
    category: 'worker',
    since: '0.1.0',
    stability: 'stable',
    description: 'List workers, optionally filtered by type or status. Auto-tier.',
    inputSchema: z.object({
      type: z.string().optional(),
      status: z.enum(['starting', 'running', 'idle', 'terminated', 'crashed']).optional(),
    }),
    outputSchema: z.object({ workers: z.array(SerializedWorker) }),
    sideEffects: ['read-only orchestrator query'],
    errorModes: ['none'],
    seeAlso: ['worker_status'],
  },
  {
    name: 'worker_status',
    tier: 'auto',
    category: 'worker',
    since: '0.1.0',
    stability: 'stable',
    description: 'Full state of a single worker by id or name. Auto-tier.',
    inputSchema: z.object({ id_or_name: z.string().min(1) }),
    outputSchema: z.object({ worker: SerializedWorker.nullable() }),
    sideEffects: ['read-only'],
    errorModes: ['none — unknown id_or_name returns `{ worker: null }`'],
    seeAlso: ['worker_list'],
  },
  {
    name: 'worker_dispatch',
    tier: 'per-spawner',
    category: 'worker',
    since: '0.1.0',
    stability: 'stable',
    description:
      'Deliver an instruction to a running worker. Per-spawner tier — some spawners refuse dispatch entirely.',
    inputSchema: z.object({
      id_or_name: z.string().min(1),
      body: z.union([z.record(z.unknown()), z.string(), z.unknown()]),
    }),
    outputSchema: z.record(z.unknown()),
    sideEffects: [
      'emits `worker_dispatch_request`',
      'effect on the worker is spawner-specific',
    ],
    errorModes: [
      'unknown worker → `unknown_worker`',
      'spawner does not support dispatch → `dispatch_not_supported`',
    ],
    seeAlso: ['worker_spawn', 'worker_terminate'],
  },
  {
    name: 'worker_terminate',
    tier: 'confirm',
    category: 'worker',
    since: '0.1.0',
    stability: 'stable',
    description: 'Terminate a worker. Always confirm-tier.',
    inputSchema: z.object({
      id_or_name: z.string().min(1),
      force: z.boolean().optional().default(false),
    }),
    outputSchema: z.object({
      ok: z.literal(true),
      exit_code: z.number().int().optional(),
    }),
    sideEffects: [
      'sends SIGTERM (or SIGKILL if `force: true`) to the worker process',
      'emits `worker_terminated`',
      'cleans up the worktree if the spawner created one',
    ],
    errorModes: ['unknown worker → `unknown_worker`'],
    seeAlso: ['worker_status'],
  },

  // ─── Trust scopes ────────────────────────────────────────────────────────
  {
    name: 'trust_scope_propose',
    tier: 'auto',
    category: 'trust-scope',
    since: '0.1.0',
    stability: 'beta',
    description:
      'Propose a trust scope (auto-tier). Logs trust_scope_proposed; does NOT activate. Use trust_scope_grant to activate.',
    inputSchema: z.object({
      title: z.string().min(1),
      description: z.string().min(1),
      allowed_actions: z.array(ActionMatcher).min(1),
      forbidden_actions: z.array(ActionMatcher).optional(),
      reporting: ReportingZ.optional(),
      expires_at: z.string().datetime().optional(),
      expires_after_actions: z.number().int().positive().optional(),
      spec_url: z.string().optional(),
      source_agent: z.string().default('co'),
    }),
    outputSchema: z.object({ scope_id: z.string(), scope: TrustScope }),
    sideEffects: [
      'creates a proposed trust scope row',
      'emits `trust_scope_proposed`',
    ],
    errorModes: ['none — proposal is unconditionally accepted; activation is gated separately'],
    seeAlso: ['trust_scope_grant', 'trust_scope_status'],
  },
  {
    name: 'trust_scope_grant',
    tier: 'confirm',
    category: 'trust-scope',
    since: '0.1.0',
    stability: 'beta',
    description:
      'Activate a proposed trust scope. CONFIRM-tier: opens an await_decision; on approve, flips the scope to active and emits trust_scope_granted.',
    inputSchema: z.object({
      id: z.string().min(1),
      granted_by: z.string().default('cowork-user-relayed'),
      timeout_sec: z.number().int().min(1).max(1800).optional(),
      source_agent: z.string().default('co'),
    }),
    outputSchema: z.union([
      z.object({ ok: z.literal(true), correlation_id: z.string(), scope: TrustScope }),
      GatedDeclined,
    ]),
    sideEffects: [
      'opens an await_decision (CONFIRM gate)',
      'on approve: flips scope status `proposed → active`, emits `trust_scope_granted`',
    ],
    errorModes: [
      'unknown scope id → isError',
      'scope not in `proposed` state → isError',
      'rejected_by_user',
    ],
    seeAlso: ['trust_scope_propose', 'trust_scope_extend', 'trust_scope_revoke'],
  },
  {
    name: 'trust_scope_revoke',
    tier: 'auto',
    category: 'trust-scope',
    since: '0.1.0',
    stability: 'beta',
    description:
      'Revoke an active trust scope (auto-tier escape hatch). Emits trust_scope_revoked.',
    inputSchema: z.object({
      id: z.string().min(1),
      reason: z.string().optional(),
      revoked_by: z.string().default('user-direct'),
      source_agent: z.string().default('cowork'),
    }),
    outputSchema: z.object({ ok: z.literal(true), scope: TrustScope }),
    sideEffects: [
      'flips scope status to `revoked` immediately (no gate — escape hatch)',
      'emits `trust_scope_revoked`',
    ],
    errorModes: ['unknown scope id → isError'],
    seeAlso: ['trust_scope_grant'],
  },
  {
    name: 'trust_scope_list',
    tier: 'auto',
    category: 'trust-scope',
    since: '0.1.0',
    stability: 'beta',
    description: 'List trust scopes, optionally filtered by status. Auto-tier.',
    inputSchema: z.object({
      status: z.enum(['proposed', 'active', 'expired', 'revoked', 'completed']).optional(),
    }),
    outputSchema: z.object({
      scopes: z.array(
        TrustScope.extend({
          time_remaining_ms: z.number().nonnegative(),
          actions_remaining: z.number().int().nonnegative().nullable(),
        }),
      ),
    }),
    sideEffects: ['sweeps wall-clock expiries before returning'],
    errorModes: ['none'],
    seeAlso: ['trust_scope_status'],
  },
  {
    name: 'trust_scope_status',
    tier: 'auto',
    category: 'trust-scope',
    since: '0.1.0',
    stability: 'beta',
    description: 'Full state of one trust scope including action history. Auto-tier.',
    inputSchema: z.object({ id: z.string().min(1) }),
    outputSchema: z.object({
      scope: TrustScope.nullable(),
      time_remaining_ms: z.number().nonnegative().optional(),
      actions_remaining: z.number().int().nonnegative().nullable().optional(),
      actions: z.array(z.record(z.unknown())).optional(),
    }),
    sideEffects: ['sweeps wall-clock expiries before returning'],
    errorModes: ['none — unknown id returns `{ scope: null }`'],
    seeAlso: ['trust_scope_list'],
  },
  {
    name: 'trust_scope_extend',
    tier: 'confirm',
    category: 'trust-scope',
    since: '0.1.0',
    stability: 'beta',
    description:
      'Extend an active scope by bumping its expiry deadline or action cap. CONFIRM-tier (gates on await_decision).',
    inputSchema: z.object({
      id: z.string().min(1),
      new_expires_at: z.string().datetime().optional(),
      new_expires_after_actions: z.number().int().positive().optional(),
      extended_by: z.string().default('cowork-user-relayed'),
      timeout_sec: z.number().int().min(1).max(1800).optional(),
      source_agent: z.string().default('co'),
    }),
    outputSchema: z.union([
      z.object({ ok: z.literal(true), correlation_id: z.string(), scope: TrustScope }),
      GatedDeclined,
    ]),
    sideEffects: [
      'opens an await_decision (CONFIRM gate)',
      'on approve: bumps `expires_at` and/or `expires_after_actions`, emits `trust_scope_extended`',
    ],
    errorModes: [
      'unknown scope id',
      'scope not in `active` state',
      'neither new_expires_at nor new_expires_after_actions supplied',
      'rejected_by_user',
    ],
    seeAlso: ['trust_scope_grant'],
  },
];

/**
 * Examples bag. Kept separate so the schemas above stay compact.
 * Missing entries are fine — the card simply omits an example section.
 */
export const TOOL_EXAMPLES: Record<string, { args: unknown; result: unknown }> = {
  emit_event: {
    args: {
      kind: 'progress',
      payload: { message: 'finished phase 2' },
      source_agent: 'cc',
    },
    result: { event_id: 'evt_01H...', persisted_at: '2026-05-12T15:00:00.000Z' },
  },
  subscribe_to_events: {
    args: { kinds: ['decision_request', 'worker_progress'] },
    result: { subscription_id: 'sub_...', kinds: ['decision_request', 'worker_progress'], replayed_events: 0 },
  },
  await_decision: {
    args: {
      question: 'Merge PR #42?',
      options: [
        { id: 'approve', label: 'Approve' },
        { id: 'reject', label: 'Reject' },
      ],
      default_option_id: 'reject',
      timeout_sec: 300,
      source_agent: 'cc',
    },
    result: {
      correlation_id: 'cor_...',
      chosen_option_id: 'approve',
      responder: 'cowork-user',
      reason: 'looks good',
      timed_out: false,
    },
  },
  'github.read_pr': {
    args: { repo: 'stenlund/stavr', number: 9 },
    result: { number: 9, title: 'Spec 40 Phase 2', state: 'MERGED', /* … */ },
  },
  'github.create_pr': {
    args: {
      repo: 'stenlund/stavr',
      head: 'feat/foo',
      base: 'main',
      title: 'feat: add foo',
      body: 'See spec.',
    },
    result: { ok: true, correlation_id: 'cor_...', pr_url: 'https://github.com/stenlund/stavr/pull/42', pr_number: 42 },
  },
  worker_spawn: {
    args: {
      type: 'cc',
      name: 'my-cc',
      params: {
        repo_path: 'C:/dev/stavr',
        branch: 'feat/spec-X',
        base: 'main',
        prompt: 'Implement spec X',
      },
    },
    result: { worker: { id: 'w_...', name: 'my-cc', type: 'cc', status: 'running' }, gated: true },
  },
  trust_scope_propose: {
    args: {
      title: 'Auto-merge dependabot PRs',
      description: 'Allow merging dependabot PRs without confirmation',
      allowed_actions: [{ tool: 'github_merge_pr', param_constraints: { repo: 'stenlund/stavr' } }],
      expires_after_actions: 10,
    },
    result: { scope_id: 'ts_...', scope: { /* TrustScope */ } },
  },
};

for (const def of TOOL_DEFINITIONS) {
  const ex = TOOL_EXAMPLES[def.name];
  if (ex) def.example = ex;
}

/**
 * Note: `GhError` is referenced in error-mode prose. Keep it in scope so the
 * import isn't pruned by the tree-shaker on consumers that build this file.
 */
export const _GH_ERROR_SCHEMA = GhError;
