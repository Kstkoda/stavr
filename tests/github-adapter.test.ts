import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Buffer } from 'node:buffer';
import { GITHUB_TOOL_NAMES, registerGithubTools } from '../src/adapters/github.js';

type ExecCall = { file: string; args: string[] };
type ExecResponse =
  | { stdout: string; stderr?: string }
  | { error: { message: string; stderr?: string; code?: number } };

function makeFakeExec(plan: (args: string[]) => ExecResponse) {
  const calls: ExecCall[] = [];
  const exec = async (
    file: string,
    args: string[],
    _opts: { maxBuffer: number; timeout: number },
  ) => {
    calls.push({ file, args });
    const r = plan(args);
    if ('error' in r) {
      const err = new Error(r.error.message) as Error & {
        stderr?: string;
        code?: number;
      };
      err.stderr = r.error.stderr;
      err.code = r.error.code;
      throw err;
    }
    return { stdout: r.stdout, stderr: r.stderr ?? '' };
  };
  return { exec, calls };
}

async function makeHarness(plan: (args: string[]) => ExecResponse) {
  const fake = makeFakeExec(plan);
  const server = new McpServer({ name: 'gh-test', version: '0.0.0' });
  registerGithubTools(server, { exec: fake.exec });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: 'gh-test-client', version: '0.0.0' });
  await client.connect(clientT);
  return {
    client,
    calls: fake.calls,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

async function callJson(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ structured: any; isError: boolean | undefined; text: string }> {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text?: string }>)
    .map((c) => c.text ?? '')
    .join('');
  let structured: any = undefined;
  try {
    structured = JSON.parse(text);
  } catch {
    /* leave undefined; text mode */
  }
  return { structured, isError: res.isError, text };
}

describe('GitHub adapter — read-only tools', () => {
  let harness: Awaited<ReturnType<typeof makeHarness>>;

  afterEach(async () => {
    if (harness) await harness.close();
  });

  it('registers all 14 tools', async () => {
    harness = await makeHarness(() => ({ stdout: '{}' }));
    const list = await harness.client.listTools();
    const names = list.tools.map((t) => t.name);
    for (const expected of GITHUB_TOOL_NAMES) {
      expect(names).toContain(expected);
    }
    expect(GITHUB_TOOL_NAMES.length).toBe(14);
  });

  it('github.read_pr — invokes gh pr view with --json and returns the parsed body', async () => {
    const fakePr = {
      number: 14,
      title: 'Phase B1 — pre-flight gates',
      state: 'OPEN',
      headRefName: 'feat/phase-b1',
      baseRefName: 'main',
      mergeable: 'MERGEABLE',
    };
    harness = await makeHarness((args) => {
      expect(args.slice(0, 4)).toEqual(['pr', 'view', '14', '--repo']);
      expect(args).toContain('Kstkoda/privacy-tracker');
      expect(args).toContain('--json');
      return { stdout: JSON.stringify(fakePr) };
    });
    const r = await callJson(harness.client, 'github.read_pr', {
      repo: 'Kstkoda/privacy-tracker',
      number: 14,
    });
    expect(r.isError).toBeFalsy();
    expect(r.structured.title).toBe('Phase B1 — pre-flight gates');
  });

  it('github.list_prs — applies state + limit defaults and returns prs array', async () => {
    const fakeList = [{ number: 1, title: 'A' }, { number: 2, title: 'B' }];
    harness = await makeHarness((args) => {
      expect(args[0]).toBe('pr');
      expect(args[1]).toBe('list');
      expect(args).toContain('--state');
      expect(args).toContain('open');
      return { stdout: JSON.stringify(fakeList) };
    });
    const r = await callJson(harness.client, 'github.list_prs', { repo: 'Kstkoda/x' });
    expect(r.structured.prs).toHaveLength(2);
  });

  it('github.read_issue — returns issue detail', async () => {
    const fakeIssue = { number: 7, title: 'I7', state: 'OPEN' };
    harness = await makeHarness(() => ({ stdout: JSON.stringify(fakeIssue) }));
    const r = await callJson(harness.client, 'github.read_issue', {
      repo: 'Kstkoda/x',
      number: 7,
    });
    expect(r.structured.number).toBe(7);
  });

  it('github.list_issues — applies optional label filter', async () => {
    harness = await makeHarness((args) => {
      const i = args.indexOf('--label');
      expect(i).toBeGreaterThan(-1);
      expect(args[i + 1]).toBe('bug');
      return { stdout: '[]' };
    });
    const r = await callJson(harness.client, 'github.list_issues', {
      repo: 'Kstkoda/x',
      label: 'bug',
    });
    expect(r.structured.issues).toEqual([]);
  });

  it('github.read_commit — uses gh api repos/.../commits/<sha>', async () => {
    harness = await makeHarness((args) => {
      expect(args[0]).toBe('api');
      expect(args[1]).toBe('repos/Kstkoda/x/commits/deadbeef');
      return { stdout: JSON.stringify({ sha: 'deadbeef', commit: { message: 'fix' } }) };
    });
    const r = await callJson(harness.client, 'github.read_commit', {
      repo: 'Kstkoda/x',
      sha: 'deadbeef',
    });
    expect(r.structured.sha).toBe('deadbeef');
  });

  it('github.list_commits — passes per_page and optional branch', async () => {
    harness = await makeHarness((args) => {
      expect(args[0]).toBe('api');
      expect(args[1]).toMatch(/^repos\/Kstkoda\/x\/commits\?/);
      expect(args[1]).toContain('per_page=10');
      expect(args[1]).toContain('sha=main');
      return { stdout: '[]' };
    });
    const r = await callJson(harness.client, 'github.list_commits', {
      repo: 'Kstkoda/x',
      branch: 'main',
      limit: 10,
    });
    expect(r.structured.commits).toEqual([]);
  });

  it('github.read_file — decodes base64 content as utf8', async () => {
    const fileBody = '# README\n\nhello world\n';
    const fakeApi = {
      path: 'README.md',
      sha: 'aaa',
      size: fileBody.length,
      encoding: 'base64',
      content: Buffer.from(fileBody, 'utf8').toString('base64'),
      html_url: 'https://example/blob',
      download_url: 'https://example/raw',
    };
    harness = await makeHarness((args) => {
      expect(args[0]).toBe('api');
      expect(args[1]).toContain('repos/Kstkoda/x/contents/README.md');
      expect(args[1]).toContain('ref=main');
      return { stdout: JSON.stringify(fakeApi) };
    });
    const r = await callJson(harness.client, 'github.read_file', {
      repo: 'Kstkoda/x',
      path: 'README.md',
      ref: 'main',
    });
    expect(r.structured.kind).toBe('file');
    expect(r.structured.content).toBe(fileBody);
    expect(r.structured.raw_base64).toBeUndefined();
  });

  it('github.read_file — marks binary content as raw_base64', async () => {
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]).toString('base64');
    harness = await makeHarness(() => ({
      stdout: JSON.stringify({ path: 'a.png', sha: 'b', size: 6, encoding: 'base64', content: binary }),
    }));
    const r = await callJson(harness.client, 'github.read_file', {
      repo: 'Kstkoda/x',
      path: 'a.png',
    });
    expect(r.structured.content).toBeUndefined();
    expect(r.structured.raw_base64).toBe(binary);
  });

  it('github.list_workflow_runs — passes optional workflow', async () => {
    harness = await makeHarness((args) => {
      expect(args[0]).toBe('run');
      expect(args[1]).toBe('list');
      const i = args.indexOf('--workflow');
      expect(i).toBeGreaterThan(-1);
      expect(args[i + 1]).toBe('ci.yml');
      return { stdout: '[]' };
    });
    const r = await callJson(harness.client, 'github.list_workflow_runs', {
      repo: 'Kstkoda/x',
      workflow: 'ci.yml',
    });
    expect(r.structured.runs).toEqual([]);
  });

  it('github.read_workflow_run — uses gh run view', async () => {
    harness = await makeHarness((args) => {
      expect(args[0]).toBe('run');
      expect(args[1]).toBe('view');
      expect(args[2]).toBe('555');
      return { stdout: JSON.stringify({ databaseId: 555, status: 'completed' }) };
    });
    const r = await callJson(harness.client, 'github.read_workflow_run', {
      repo: 'Kstkoda/x',
      run_id: 555,
    });
    expect(r.structured.databaseId).toBe(555);
  });

  it('github.read_pr_diff — returns raw diff text and not-truncated for small diffs', async () => {
    const diff = 'diff --git a/x b/x\n+hello\n';
    harness = await makeHarness((args) => {
      expect(args.slice(0, 3)).toEqual(['pr', 'diff', '14']);
      return { stdout: diff };
    });
    const r = await callJson(harness.client, 'github.read_pr_diff', {
      repo: 'Kstkoda/x',
      number: 14,
    });
    expect(r.structured.truncated).toBe(false);
    expect(r.structured.diff).toBe(diff);
  });

  it('github.read_pr_diff — truncates diffs over 1 MiB', async () => {
    const big = 'x'.repeat(1024 * 1024 + 500);
    harness = await makeHarness(() => ({ stdout: big }));
    const r = await callJson(harness.client, 'github.read_pr_diff', {
      repo: 'Kstkoda/x',
      number: 14,
    });
    expect(r.structured.truncated).toBe(true);
    expect(r.structured.bytes_truncated).toBe(500);
    expect(r.structured.diff).toMatch(/truncated:/);
  });

  it('github.list_pr_files — returns files array', async () => {
    const stdout = JSON.stringify({
      files: [
        { path: 'src/a.ts', additions: 10, deletions: 2 },
        { path: 'src/b.ts', additions: 0, deletions: 5 },
      ],
    });
    harness = await makeHarness(() => ({ stdout }));
    const r = await callJson(harness.client, 'github.list_pr_files', {
      repo: 'Kstkoda/x',
      number: 1,
    });
    expect(r.structured.files).toHaveLength(2);
  });

  it('github.read_pr_review_comments — returns comments array', async () => {
    harness = await makeHarness((args) => {
      expect(args[0]).toBe('api');
      expect(args[1]).toBe('repos/Kstkoda/x/pulls/14/comments');
      return { stdout: JSON.stringify([{ id: 1, body: 'nit' }]) };
    });
    const r = await callJson(harness.client, 'github.read_pr_review_comments', {
      repo: 'Kstkoda/x',
      number: 14,
    });
    expect(r.structured.comments).toHaveLength(1);
  });

  it('github.list_labels — returns labels with name/color/description', async () => {
    harness = await makeHarness((args) => {
      expect(args[0]).toBe('label');
      expect(args[1]).toBe('list');
      return { stdout: JSON.stringify([{ name: 'bug', color: 'fff', description: '' }]) };
    });
    const r = await callJson(harness.client, 'github.list_labels', { repo: 'Kstkoda/x' });
    expect(r.structured.labels[0].name).toBe('bug');
  });

  it('github.list_branches — returns normalized name/sha/protected', async () => {
    harness = await makeHarness(() => ({
      stdout: JSON.stringify([
        { name: 'main', commit: { sha: 'aaa' }, protected: true },
        { name: 'dev', commit: { sha: 'bbb' } },
      ]),
    }));
    const r = await callJson(harness.client, 'github.list_branches', { repo: 'Kstkoda/x' });
    expect(r.structured.branches).toEqual([
      { name: 'main', sha: 'aaa', protected: true },
      { name: 'dev', sha: 'bbb', protected: false },
    ]);
    expect(r.structured.capped_at).toBe(100);
  });

  it('error path — gh failure surfaces as typed gh_failed error, not a crash', async () => {
    harness = await makeHarness(() => ({
      error: { message: 'gh exited 1', stderr: 'HTTP 404: Not Found', code: 1 },
    }));
    const r = await callJson(harness.client, 'github.read_pr', {
      repo: 'Kstkoda/missing',
      number: 99999,
    });
    expect(r.isError).toBe(true);
    expect(r.structured.code).toBe('gh_failed');
    expect(r.structured.stderr).toContain('404');
  });

  it('schema validation — non-string repo is rejected', async () => {
    harness = await makeHarness(() => ({ stdout: '{}' }));
    const res = await harness.client.callTool({
      name: 'github.read_pr',
      arguments: { repo: 12345, number: 14 } as any,
    });
    expect(res.isError).toBe(true);
  });

  it('schema validation — missing number is rejected', async () => {
    harness = await makeHarness(() => ({ stdout: '{}' }));
    const res = await harness.client.callTool({
      name: 'github.read_pr',
      arguments: { repo: 'Kstkoda/x' } as any,
    });
    expect(res.isError).toBe(true);
  });
});
