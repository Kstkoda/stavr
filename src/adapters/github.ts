import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Buffer } from 'node:buffer';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toolError, toolJson } from '../server.js';

const execFileP = promisify(execFile);

const GH_MAX_BUFFER = 16 * 1024 * 1024; // 16 MiB — diffs can be big
const GH_TIMEOUT_MS = 30_000;
const DIFF_TRUNCATE_BYTES = 1 * 1024 * 1024; // 1 MiB

type ExecRunner = (
  file: string,
  args: string[],
  options: { maxBuffer: number; timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

export interface RegisterGithubToolsOptions {
  // Override the subprocess runner — used by tests to stub `gh`.
  exec?: ExecRunner;
}

interface GhError {
  code: 'gh_failed';
  message: string;
  exit_code?: number;
  stderr?: string;
}

class GhExecError extends Error {
  exitCode?: number;
  stderr?: string;
  constructor(message: string, exitCode: number | undefined, stderr: string | undefined) {
    super(message);
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

function makeGhExec(runner: ExecRunner) {
  return async function ghExec(args: string[]): Promise<string> {
    try {
      const { stdout } = await runner('gh', args, {
        maxBuffer: GH_MAX_BUFFER,
        timeout: GH_TIMEOUT_MS,
      });
      return stdout;
    } catch (err: unknown) {
      const e = err as { stderr?: string; message?: string; code?: number };
      const stderr = e?.stderr?.toString() ?? '';
      const message = stderr || e?.message || 'gh invocation failed';
      throw new GhExecError(`gh ${args.join(' ')} failed: ${message}`, e?.code, stderr);
    }
  };
}

function ghErrorToTool(err: unknown) {
  if (err instanceof GhExecError) {
    const payload: GhError = {
      code: 'gh_failed',
      message: err.message,
      exit_code: err.exitCode,
      stderr: err.stderr,
    };
    return {
      isError: true,
      content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
      structuredContent: payload as unknown as Record<string, unknown>,
    };
  }
  return toolError((err as Error)?.message ?? 'unknown error');
}

function parseJsonOrError(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch (e) {
    throw new GhExecError(
      `failed to parse gh JSON output: ${(e as Error).message}`,
      undefined,
      stdout.slice(0, 500),
    );
  }
}

const STATE_ENUM = z.enum(['open', 'closed', 'merged', 'all']);

export function registerGithubTools(
  server: McpServer,
  opts: RegisterGithubToolsOptions = {},
): void {
  const runner: ExecRunner = opts.exec ?? (execFileP as unknown as ExecRunner);
  const gh = makeGhExec(runner);

  // 1. github.read_pr
  server.registerTool(
    'github.read_pr',
    {
      description:
        'Read a GitHub pull request by repo + number. Returns title, body, state, head/base refs, CI status summary, files changed, mergeability.',
      inputSchema: {
        repo: z.string().min(1).describe('Repo in owner/name form, e.g. Kstkoda/privacy-tracker'),
        number: z.number().int().min(1).describe('PR number'),
      },
    },
    async ({ repo, number }) => {
      try {
        const stdout = await gh([
          'pr',
          'view',
          String(number),
          '--repo',
          repo,
          '--json',
          'number,title,body,state,headRefName,baseRefName,statusCheckRollup,files,author,createdAt,updatedAt,mergeable,mergeStateStatus',
        ]);
        return toolJson(parseJsonOrError(stdout) as Record<string, unknown>);
      } catch (err) {
        return ghErrorToTool(err);
      }
    },
  );

  // 2. github.list_prs
  server.registerTool(
    'github.list_prs',
    {
      description: 'List pull requests for a repo. Returns summaries (number, title, state, author, head/base, updatedAt).',
      inputSchema: {
        repo: z.string().min(1),
        state: STATE_ENUM.optional().default('open'),
        limit: z.number().int().min(1).max(200).optional().default(30),
      },
    },
    async ({ repo, state, limit }) => {
      try {
        const stdout = await gh([
          'pr',
          'list',
          '--repo',
          repo,
          '--state',
          state,
          '--limit',
          String(limit),
          '--json',
          'number,title,state,author,headRefName,baseRefName,updatedAt,createdAt,isDraft',
        ]);
        return toolJson({ prs: parseJsonOrError(stdout) });
      } catch (err) {
        return ghErrorToTool(err);
      }
    },
  );

  // 3. github.read_issue
  server.registerTool(
    'github.read_issue',
    {
      description: 'Read a GitHub issue by repo + number.',
      inputSchema: {
        repo: z.string().min(1),
        number: z.number().int().min(1),
      },
    },
    async ({ repo, number }) => {
      try {
        const stdout = await gh([
          'issue',
          'view',
          String(number),
          '--repo',
          repo,
          '--json',
          'number,title,body,state,author,labels,assignees,milestone,createdAt,updatedAt,closedAt,comments',
        ]);
        return toolJson(parseJsonOrError(stdout) as Record<string, unknown>);
      } catch (err) {
        return ghErrorToTool(err);
      }
    },
  );

  // 4. github.list_issues
  server.registerTool(
    'github.list_issues',
    {
      description: 'List issues for a repo. Optional label filter.',
      inputSchema: {
        repo: z.string().min(1),
        state: STATE_ENUM.optional().default('open'),
        label: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional().default(30),
      },
    },
    async ({ repo, state, label, limit }) => {
      try {
        const args = [
          'issue',
          'list',
          '--repo',
          repo,
          '--state',
          state,
          '--limit',
          String(limit),
          '--json',
          'number,title,state,author,labels,assignees,createdAt,updatedAt',
        ];
        if (label) {
          args.push('--label', label);
        }
        const stdout = await gh(args);
        return toolJson({ issues: parseJsonOrError(stdout) });
      } catch (err) {
        return ghErrorToTool(err);
      }
    },
  );

  // 5. github.read_commit
  server.registerTool(
    'github.read_commit',
    {
      description: 'Read commit detail (message, author, files changed, stats).',
      inputSchema: {
        repo: z.string().min(1),
        sha: z.string().min(1).max(64),
      },
    },
    async ({ repo, sha }) => {
      try {
        const stdout = await gh(['api', `repos/${repo}/commits/${sha}`]);
        return toolJson(parseJsonOrError(stdout) as Record<string, unknown>);
      } catch (err) {
        return ghErrorToTool(err);
      }
    },
  );

  // 6. github.list_commits
  server.registerTool(
    'github.list_commits',
    {
      description: 'List commits on a branch (defaults to the default branch).',
      inputSchema: {
        repo: z.string().min(1),
        branch: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional().default(30),
      },
    },
    async ({ repo, branch, limit }) => {
      try {
        const params = new URLSearchParams();
        if (branch) params.set('sha', branch);
        params.set('per_page', String(limit));
        const stdout = await gh(['api', `repos/${repo}/commits?${params.toString()}`]);
        return toolJson({ commits: parseJsonOrError(stdout) });
      } catch (err) {
        return ghErrorToTool(err);
      }
    },
  );

  // 7. github.read_file
  server.registerTool(
    'github.read_file',
    {
      description:
        'Read a file from a repo at a given ref. Returns decoded text content + metadata. Binary files surface as base64 in `raw_base64`.',
      inputSchema: {
        repo: z.string().min(1),
        path: z.string().min(1),
        ref: z.string().optional(),
      },
    },
    async ({ repo, path, ref }) => {
      try {
        const apiPath =
          `repos/${repo}/contents/${path}` + (ref ? `?ref=${encodeURIComponent(ref)}` : '');
        const stdout = await gh(['api', apiPath]);
        const parsed = parseJsonOrError(stdout) as Record<string, unknown>;
        if (Array.isArray(parsed)) {
          // Path resolved to a directory listing.
          return toolJson({ kind: 'directory', entries: parsed });
        }
        const encoding = parsed['encoding'];
        const content = parsed['content'];
        let decoded: string | undefined;
        let raw_base64: string | undefined;
        if (encoding === 'base64' && typeof content === 'string') {
          const buf = Buffer.from(content, 'base64');
          // Heuristic: decode as utf8 if there are no NUL bytes in the first 4KiB.
          const head = buf.subarray(0, Math.min(buf.length, 4096));
          const looksBinary = head.includes(0);
          if (looksBinary) {
            raw_base64 = content.replace(/\n/g, '');
          } else {
            decoded = buf.toString('utf8');
          }
        }
        return toolJson({
          kind: 'file',
          path: parsed['path'],
          sha: parsed['sha'],
          size: parsed['size'],
          html_url: parsed['html_url'],
          download_url: parsed['download_url'],
          content: decoded,
          raw_base64,
        });
      } catch (err) {
        return ghErrorToTool(err);
      }
    },
  );

  // 8. github.list_workflow_runs
  server.registerTool(
    'github.list_workflow_runs',
    {
      description: 'List GitHub Actions workflow runs for a repo. Optional workflow filter (name or filename).',
      inputSchema: {
        repo: z.string().min(1),
        workflow: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional().default(20),
      },
    },
    async ({ repo, workflow, limit }) => {
      try {
        const args = [
          'run',
          'list',
          '--repo',
          repo,
          '--limit',
          String(limit),
          '--json',
          'databaseId,name,displayTitle,event,status,conclusion,workflowName,headBranch,headSha,createdAt,updatedAt,url',
        ];
        if (workflow) {
          args.push('--workflow', workflow);
        }
        const stdout = await gh(args);
        return toolJson({ runs: parseJsonOrError(stdout) });
      } catch (err) {
        return ghErrorToTool(err);
      }
    },
  );

  // 9. github.read_workflow_run
  server.registerTool(
    'github.read_workflow_run',
    {
      description: 'Read a single GitHub Actions workflow run with job statuses.',
      inputSchema: {
        repo: z.string().min(1),
        run_id: z.number().int().min(1),
      },
    },
    async ({ repo, run_id }) => {
      try {
        const stdout = await gh([
          'run',
          'view',
          String(run_id),
          '--repo',
          repo,
          '--json',
          'databaseId,name,displayTitle,event,status,conclusion,workflowName,headBranch,headSha,createdAt,updatedAt,url,jobs',
        ]);
        return toolJson(parseJsonOrError(stdout) as Record<string, unknown>);
      } catch (err) {
        return ghErrorToTool(err);
      }
    },
  );

  // 10. github.read_pr_diff
  server.registerTool(
    'github.read_pr_diff',
    {
      description:
        'Unified diff for a PR as plain text. Truncated to 1 MiB; if truncated, `truncated: true` and `bytes_truncated` are set.',
      inputSchema: {
        repo: z.string().min(1),
        number: z.number().int().min(1),
      },
    },
    async ({ repo, number }) => {
      try {
        const stdout = await gh(['pr', 'diff', String(number), '--repo', repo]);
        const buf = Buffer.from(stdout, 'utf8');
        const truncated = buf.length > DIFF_TRUNCATE_BYTES;
        const diff = truncated
          ? buf.subarray(0, DIFF_TRUNCATE_BYTES).toString('utf8') +
            `\n... [truncated: ${buf.length - DIFF_TRUNCATE_BYTES} bytes omitted]`
          : stdout;
        return toolJson({
          diff,
          truncated,
          bytes: buf.length,
          bytes_truncated: truncated ? buf.length - DIFF_TRUNCATE_BYTES : 0,
        });
      } catch (err) {
        return ghErrorToTool(err);
      }
    },
  );

  // 11. github.list_pr_files
  server.registerTool(
    'github.list_pr_files',
    {
      description: 'List files changed in a PR with additions / deletions per file.',
      inputSchema: {
        repo: z.string().min(1),
        number: z.number().int().min(1),
      },
    },
    async ({ repo, number }) => {
      try {
        const stdout = await gh([
          'pr',
          'view',
          String(number),
          '--repo',
          repo,
          '--json',
          'files',
        ]);
        const parsed = parseJsonOrError(stdout) as { files?: unknown[] };
        return toolJson({ files: parsed.files ?? [] });
      } catch (err) {
        return ghErrorToTool(err);
      }
    },
  );

  // 12. github.read_pr_review_comments
  server.registerTool(
    'github.read_pr_review_comments',
    {
      description: 'List inline review comments on a PR (the line-by-line review comments, not issue comments).',
      inputSchema: {
        repo: z.string().min(1),
        number: z.number().int().min(1),
      },
    },
    async ({ repo, number }) => {
      try {
        const stdout = await gh(['api', `repos/${repo}/pulls/${number}/comments`]);
        return toolJson({ comments: parseJsonOrError(stdout) });
      } catch (err) {
        return ghErrorToTool(err);
      }
    },
  );

  // 13. github.list_labels
  server.registerTool(
    'github.list_labels',
    {
      description: 'List labels defined in a repo (name, color, description).',
      inputSchema: {
        repo: z.string().min(1),
      },
    },
    async ({ repo }) => {
      try {
        const stdout = await gh([
          'label',
          'list',
          '--repo',
          repo,
          '--limit',
          '200',
          '--json',
          'name,color,description',
        ]);
        return toolJson({ labels: parseJsonOrError(stdout) });
      } catch (err) {
        return ghErrorToTool(err);
      }
    },
  );

  // 14. github.list_branches
  server.registerTool(
    'github.list_branches',
    {
      description:
        'List branches in a repo (name + head sha + protection flag). Capped at 100 per call — pagination is not exposed in v1.',
      inputSchema: {
        repo: z.string().min(1),
      },
    },
    async ({ repo }) => {
      try {
        // Spec called for --paginate; we use a per_page=100 single call instead
        // because `gh api --paginate` emits concatenated JSON arrays that are
        // awkward to parse. Documented in the PR caveats.
        const stdout = await gh(['api', `repos/${repo}/branches?per_page=100`]);
        const raw = parseJsonOrError(stdout) as Array<{
          name: string;
          commit?: { sha: string };
          protected?: boolean;
        }>;
        const branches = raw.map((b) => ({
          name: b.name,
          sha: b.commit?.sha,
          protected: b.protected ?? false,
        }));
        return toolJson({ branches, capped_at: 100 });
      } catch (err) {
        return ghErrorToTool(err);
      }
    },
  );
}

export const GITHUB_TOOL_NAMES = [
  'github.read_pr',
  'github.list_prs',
  'github.read_issue',
  'github.list_issues',
  'github.read_commit',
  'github.list_commits',
  'github.read_file',
  'github.list_workflow_runs',
  'github.read_workflow_run',
  'github.read_pr_diff',
  'github.list_pr_files',
  'github.read_pr_review_comments',
  'github.list_labels',
  'github.list_branches',
] as const;
