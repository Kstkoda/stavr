import { execFile } from 'node:child_process';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Broker } from '../broker.js';
import { toolJson } from '../server.js';
import { gatedAction } from '../tools/gated-action.js';
import type { TrustStore } from '../trust/store.js';

const GH_MAX_BUFFER = 16 * 1024 * 1024;
const GH_TIMEOUT_MS = 30_000;

export interface WriteExecOpts {
  maxBuffer: number;
  timeout: number;
  input?: string;
}

export type WriteExecRunner = (
  file: string,
  args: string[],
  options: WriteExecOpts,
) => Promise<{ stdout: string; stderr: string }>;

export interface RegisterGithubWriteToolsOptions {
  exec?: WriteExecRunner;
  decisionTimeoutSec?: number;
  trustStore?: TrustStore;
}

class GhWriteError extends Error {
  exitCode?: number;
  stderr?: string;
  constructor(message: string, exitCode: number | undefined, stderr: string | undefined) {
    super(message);
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

function defaultExec(
  file: string,
  args: string[],
  opts: WriteExecOpts,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { maxBuffer: opts.maxBuffer, timeout: opts.timeout },
      (err, stdout, stderr) => {
        const out = typeof stdout === 'string' ? stdout : (stdout as Buffer | undefined)?.toString() ?? '';
        const errStr = typeof stderr === 'string' ? stderr : (stderr as Buffer | undefined)?.toString() ?? '';
        if (err) {
          const e = err as Error & { stderr?: string; code?: number };
          e.stderr = errStr;
          reject(e);
        } else {
          resolve({ stdout: out, stderr: errStr });
        }
      },
    );
    if (opts.input !== undefined && child.stdin) {
      child.stdin.end(opts.input);
    }
  });
}

function makeGhWriteExec(runner: WriteExecRunner) {
  return async function ghExec(args: string[], input?: string): Promise<string> {
    try {
      const { stdout } = await runner('gh', args, {
        maxBuffer: GH_MAX_BUFFER,
        timeout: GH_TIMEOUT_MS,
        input,
      });
      return stdout;
    } catch (err: unknown) {
      const e = err as { stderr?: string; message?: string; code?: number };
      const stderr = e?.stderr?.toString() ?? '';
      const message = stderr || e?.message || 'gh invocation failed';
      throw new GhWriteError(`gh ${args.join(' ')} failed: ${message}`, e?.code, stderr);
    }
  };
}

function extractPrNumberFromUrl(url: string): number | undefined {
  const m = url.match(/\/pull\/(\d+)/);
  return m ? Number(m[1]) : undefined;
}

function extractIssueNumberFromUrl(url: string): number | undefined {
  const m = url.match(/\/issues\/(\d+)/);
  return m ? Number(m[1]) : undefined;
}

export function registerGithubWriteTools(
  server: McpServer,
  broker: Broker,
  opts: RegisterGithubWriteToolsOptions = {},
): void {
  const runner: WriteExecRunner = opts.exec ?? defaultExec;
  const gh = makeGhWriteExec(runner);
  const timeoutSec = opts.decisionTimeoutSec;
  const trustStore = opts.trustStore;

  // Helper to format a structured success/failure as a tool response.
  const respond = (value: unknown) => toolJson(value as Record<string, unknown>);

  // 1. github.create_pr
  server.registerTool(
    'github.create_pr',
    {
      description:
        'Create a GitHub pull request. Gated by await_decision (CONFIRM tier). On approval, runs `gh pr create`. Returns { ok, pr_url, pr_number } on success.',
      inputSchema: {
        repo: z.string().min(1).describe('owner/name'),
        head: z.string().min(1),
        base: z.string().min(1),
        title: z.string().min(1),
        body: z.string().default(''),
        draft: z.boolean().optional().default(false),
        reason: z.string().optional().describe('Why this action is being requested — shown to the operator in the approval prompt.'),
      },
    },
    async ({ repo, head, base, title, body, draft, reason }) => {
      const question = `Create PR in ${repo}: "${title}" (${head} → ${base}${draft ? ', draft' : ''}). Approve?`;
      const result = await gatedAction({
        broker,
        question,
        reason,
        timeoutSec,
        scopeCheck: { tool: 'github_create_pr', args: { repo, head, base, title, body, draft }, trustStore },
        performAction: async () => {
          const args = [
            'pr',
            'create',
            '--repo',
            repo,
            '--head',
            head,
            '--base',
            base,
            '--title',
            title,
            '--body-file',
            '-',
          ];
          if (draft) args.push('--draft');
          const stdout = await gh(args, body);
          const url = stdout.trim().split('\n').pop()?.trim() ?? '';
          return { pr_url: url, pr_number: extractPrNumberFromUrl(url) };
        },
        successEvent: (r) =>
          r.pr_url
            ? { kind: 'pr_opened', payload: { url: r.pr_url, title } }
            : undefined,
      });
      if (!result.ok) return respond(result);
      return respond({
        ok: true,
        correlation_id: result.correlation_id,
        pr_url: result.result.pr_url,
        pr_number: result.result.pr_number,
      });
    },
  );

  // 2. github.merge_pr
  server.registerTool(
    'github.merge_pr',
    {
      description:
        'Merge a pull request. Gated by await_decision. Always squash + delete-branch in v1. Returns { ok, merged_sha }.',
      inputSchema: {
        repo: z.string().min(1),
        number: z.number().int().min(1),
        reason: z.string().optional().describe('Why this action is being requested — shown to the operator in the approval prompt.'),
      },
    },
    async ({ repo, number, reason }) => {
      const question = `Merge PR #${number} in ${repo} (squash + delete-branch). Approve?`;
      const result = await gatedAction({
        broker,
        question,
        reason,
        timeoutSec,
        scopeCheck: { tool: 'github_merge_pr', args: { repo, number }, trustStore },
        performAction: async () => {
          await gh([
            'pr',
            'merge',
            String(number),
            '--repo',
            repo,
            '--squash',
            '--delete-branch',
          ]);
          let merged_sha: string | undefined;
          try {
            const view = await gh([
              'pr',
              'view',
              String(number),
              '--repo',
              repo,
              '--json',
              'mergeCommit',
            ]);
            const parsed = JSON.parse(view) as { mergeCommit?: { oid?: string } };
            merged_sha = parsed.mergeCommit?.oid;
          } catch {
            // Best effort — merge succeeded even if we can't fetch the sha.
          }
          return { merged_sha };
        },
        successEvent: () => ({
          kind: 'progress',
          payload: { message: `merged PR #${number} in ${repo}` },
        }),
      });
      if (!result.ok) return respond(result);
      return respond({
        ok: true,
        correlation_id: result.correlation_id,
        merged_sha: result.result.merged_sha,
      });
    },
  );

  // 3. github.create_issue
  server.registerTool(
    'github.create_issue',
    {
      description:
        'Create a GitHub issue. Gated by await_decision. Returns { ok, issue_url, issue_number }.',
      inputSchema: {
        repo: z.string().min(1),
        title: z.string().min(1),
        body: z.string().default(''),
        labels: z.array(z.string().min(1)).optional(),
        reason: z.string().optional().describe('Why this action is being requested — shown to the operator in the approval prompt.'),
      },
    },
    async ({ repo, title, body, labels, reason }) => {
      const question = `Create issue in ${repo}: "${title}"${labels && labels.length ? ` (labels: ${labels.join(', ')})` : ''}. Approve?`;
      const result = await gatedAction({
        broker,
        question,
        reason,
        timeoutSec,
        scopeCheck: { tool: 'github_create_issue', args: { repo, title, body, labels }, trustStore },
        performAction: async () => {
          const args = [
            'issue',
            'create',
            '--repo',
            repo,
            '--title',
            title,
            '--body-file',
            '-',
          ];
          for (const l of labels ?? []) args.push('--label', l);
          const stdout = await gh(args, body);
          const url = stdout.trim().split('\n').pop()?.trim() ?? '';
          return { issue_url: url, issue_number: extractIssueNumberFromUrl(url) };
        },
        successEvent: (r) => ({
          kind: 'progress',
          payload: { message: `opened issue ${r.issue_url}` },
        }),
      });
      if (!result.ok) return respond(result);
      return respond({
        ok: true,
        correlation_id: result.correlation_id,
        issue_url: result.result.issue_url,
        issue_number: result.result.issue_number,
      });
    },
  );

  // 4. github.create_issue_comment
  server.registerTool(
    'github.create_issue_comment',
    {
      description:
        'Post a comment on an issue. Gated by await_decision. Returns { ok, comment_url }.',
      inputSchema: {
        repo: z.string().min(1),
        number: z.number().int().min(1),
        body: z.string().min(1),
        reason: z.string().optional().describe('Why this action is being requested — shown to the operator in the approval prompt.'),
      },
    },
    async ({ repo, number, body, reason }) => {
      const preview = body.length > 80 ? body.slice(0, 80) + '…' : body;
      const question = `Comment on issue #${number} in ${repo}: "${preview}". Approve?`;
      const result = await gatedAction({
        broker,
        question,
        reason,
        timeoutSec,
        scopeCheck: { tool: 'github_create_issue_comment', args: { repo, number, body }, trustStore },
        performAction: async () => {
          const stdout = await gh(
            [
              'issue',
              'comment',
              String(number),
              '--repo',
              repo,
              '--body-file',
              '-',
            ],
            body,
          );
          return { comment_url: stdout.trim().split('\n').pop()?.trim() ?? '' };
        },
        successEvent: (r) => ({
          kind: 'progress',
          payload: { message: `commented on issue #${number} in ${repo}: ${r.comment_url}` },
        }),
      });
      if (!result.ok) return respond(result);
      return respond({
        ok: true,
        correlation_id: result.correlation_id,
        comment_url: result.result.comment_url,
      });
    },
  );

  // 5. github.create_pr_comment
  server.registerTool(
    'github.create_pr_comment',
    {
      description:
        'Post a comment on a pull request. Gated by await_decision. Returns { ok, comment_url }.',
      inputSchema: {
        repo: z.string().min(1),
        number: z.number().int().min(1),
        body: z.string().min(1),
        reason: z.string().optional().describe('Why this action is being requested — shown to the operator in the approval prompt.'),
      },
    },
    async ({ repo, number, body, reason }) => {
      const preview = body.length > 80 ? body.slice(0, 80) + '…' : body;
      const question = `Comment on PR #${number} in ${repo}: "${preview}". Approve?`;
      const result = await gatedAction({
        broker,
        question,
        reason,
        timeoutSec,
        scopeCheck: { tool: 'github_create_pr_comment', args: { repo, number, body }, trustStore },
        performAction: async () => {
          const stdout = await gh(
            [
              'pr',
              'comment',
              String(number),
              '--repo',
              repo,
              '--body-file',
              '-',
            ],
            body,
          );
          return { comment_url: stdout.trim().split('\n').pop()?.trim() ?? '' };
        },
        successEvent: (r) => ({
          kind: 'progress',
          payload: { message: `commented on PR #${number} in ${repo}: ${r.comment_url}` },
        }),
      });
      if (!result.ok) return respond(result);
      return respond({
        ok: true,
        correlation_id: result.correlation_id,
        comment_url: result.result.comment_url,
      });
    },
  );

  // 6. github.close_issue
  server.registerTool(
    'github.close_issue',
    {
      description:
        'Close an issue. Optionally posts a closing comment. Gated by await_decision.',
      inputSchema: {
        repo: z.string().min(1),
        number: z.number().int().min(1),
        comment: z.string().optional(),
        reason: z.string().optional().describe('Why this action is being requested — shown to the operator in the approval prompt.'),
      },
    },
    async ({ repo, number, comment, reason }) => {
      const question = `Close issue #${number} in ${repo}${comment ? ' (with comment)' : ''}. Approve?`;
      const result = await gatedAction({
        broker,
        question,
        reason,
        timeoutSec,
        scopeCheck: { tool: 'github_close_issue', args: { repo, number, comment }, trustStore },
        performAction: async () => {
          const args = ['issue', 'close', String(number), '--repo', repo];
          if (comment) args.push('--comment', comment);
          await gh(args);
          return {};
        },
        successEvent: () => ({
          kind: 'progress',
          payload: { message: `closed issue #${number} in ${repo}` },
        }),
      });
      if (!result.ok) return respond(result);
      return respond({ ok: true, correlation_id: result.correlation_id });
    },
  );

  // 7. github.reopen_issue
  server.registerTool(
    'github.reopen_issue',
    {
      description:
        'Reopen a previously closed issue. Optionally posts a comment. Gated by await_decision.',
      inputSchema: {
        repo: z.string().min(1),
        number: z.number().int().min(1),
        comment: z.string().optional(),
        reason: z.string().optional().describe('Why this action is being requested — shown to the operator in the approval prompt.'),
      },
    },
    async ({ repo, number, comment, reason }) => {
      const question = `Reopen issue #${number} in ${repo}${comment ? ' (with comment)' : ''}. Approve?`;
      const result = await gatedAction({
        broker,
        question,
        reason,
        timeoutSec,
        scopeCheck: { tool: 'github_reopen_issue', args: { repo, number, comment }, trustStore },
        performAction: async () => {
          const args = ['issue', 'reopen', String(number), '--repo', repo];
          if (comment) args.push('--comment', comment);
          await gh(args);
          return {};
        },
        successEvent: () => ({
          kind: 'progress',
          payload: { message: `reopened issue #${number} in ${repo}` },
        }),
      });
      if (!result.ok) return respond(result);
      return respond({ ok: true, correlation_id: result.correlation_id });
    },
  );

  // 8. github.add_labels
  server.registerTool(
    'github.add_labels',
    {
      description:
        'Add labels to an issue or PR. Gated by await_decision. Returns { ok, labels_after }.',
      inputSchema: {
        repo: z.string().min(1),
        number: z.number().int().min(1),
        labels: z.array(z.string().min(1)).min(1),
        reason: z.string().optional().describe('Why this action is being requested — shown to the operator in the approval prompt.'),
      },
    },
    async ({ repo, number, labels, reason }) => {
      const question = `Add labels [${labels.join(', ')}] to #${number} in ${repo}. Approve?`;
      const result = await gatedAction({
        broker,
        question,
        reason,
        timeoutSec,
        scopeCheck: { tool: 'github_add_labels', args: { repo, number, labels }, trustStore },
        performAction: async () => {
          const args = ['issue', 'edit', String(number), '--repo', repo];
          for (const l of labels) args.push('--add-label', l);
          await gh(args);
          let labels_after: string[] = [];
          try {
            const view = await gh([
              'issue',
              'view',
              String(number),
              '--repo',
              repo,
              '--json',
              'labels',
            ]);
            const parsed = JSON.parse(view) as { labels?: Array<{ name: string }> };
            labels_after = (parsed.labels ?? []).map((l) => l.name);
          } catch {
            // Best effort.
          }
          return { labels_after };
        },
        successEvent: () => ({
          kind: 'progress',
          payload: { message: `added labels to #${number} in ${repo}: ${labels.join(', ')}` },
        }),
      });
      if (!result.ok) return respond(result);
      return respond({
        ok: true,
        correlation_id: result.correlation_id,
        labels_after: result.result.labels_after,
      });
    },
  );

  // 9. github.remove_labels
  server.registerTool(
    'github.remove_labels',
    {
      description:
        'Remove labels from an issue or PR. Gated by await_decision. Returns { ok, labels_after }.',
      inputSchema: {
        repo: z.string().min(1),
        number: z.number().int().min(1),
        labels: z.array(z.string().min(1)).min(1),
        reason: z.string().optional().describe('Why this action is being requested — shown to the operator in the approval prompt.'),
      },
    },
    async ({ repo, number, labels, reason }) => {
      const question = `Remove labels [${labels.join(', ')}] from #${number} in ${repo}. Approve?`;
      const result = await gatedAction({
        broker,
        question,
        reason,
        timeoutSec,
        scopeCheck: { tool: 'github_remove_labels', args: { repo, number, labels }, trustStore },
        performAction: async () => {
          const args = ['issue', 'edit', String(number), '--repo', repo];
          for (const l of labels) args.push('--remove-label', l);
          await gh(args);
          let labels_after: string[] = [];
          try {
            const view = await gh([
              'issue',
              'view',
              String(number),
              '--repo',
              repo,
              '--json',
              'labels',
            ]);
            const parsed = JSON.parse(view) as { labels?: Array<{ name: string }> };
            labels_after = (parsed.labels ?? []).map((l) => l.name);
          } catch {
            // Best effort.
          }
          return { labels_after };
        },
        successEvent: () => ({
          kind: 'progress',
          payload: { message: `removed labels from #${number} in ${repo}: ${labels.join(', ')}` },
        }),
      });
      if (!result.ok) return respond(result);
      return respond({
        ok: true,
        correlation_id: result.correlation_id,
        labels_after: result.result.labels_after,
      });
    },
  );

  // 10. github.request_pr_review
  server.registerTool(
    'github.request_pr_review',
    {
      description:
        'Request a review on a pull request from one or more reviewers. Gated by await_decision.',
      inputSchema: {
        repo: z.string().min(1),
        number: z.number().int().min(1),
        reviewers: z.array(z.string().min(1)).min(1),
        reason: z.string().optional().describe('Why this action is being requested — shown to the operator in the approval prompt.'),
      },
    },
    async ({ repo, number, reviewers, reason }) => {
      const question = `Request review on PR #${number} in ${repo} from [${reviewers.join(', ')}]. Approve?`;
      const result = await gatedAction({
        broker,
        question,
        reason,
        timeoutSec,
        scopeCheck: { tool: 'github_request_pr_review', args: { repo, number, reviewers }, trustStore },
        performAction: async () => {
          const args = ['pr', 'edit', String(number), '--repo', repo];
          for (const r of reviewers) args.push('--add-reviewer', r);
          await gh(args);
          return {};
        },
        successEvent: () => ({
          kind: 'progress',
          payload: {
            message: `requested review on PR #${number} in ${repo} from ${reviewers.join(', ')}`,
          },
        }),
      });
      if (!result.ok) return respond(result);
      return respond({ ok: true, correlation_id: result.correlation_id });
    },
  );
}

export const GITHUB_WRITE_TOOL_NAMES = [
  'github.create_pr',
  'github.merge_pr',
  'github.create_issue',
  'github.create_issue_comment',
  'github.create_pr_comment',
  'github.close_issue',
  'github.reopen_issue',
  'github.add_labels',
  'github.remove_labels',
  'github.request_pr_review',
] as const;
