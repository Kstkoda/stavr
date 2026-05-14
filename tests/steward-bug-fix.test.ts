/**
 * Unit tests for src/steward-bug-fix.ts (stream C C1 — orchestration).
 *
 * The pure pieces — issue-ref parsing, brief composition, scope shape,
 * auto-approval decision — are tested here. The CLI wiring + the actual
 * HTTP/event-emit flow are exercised by tests/federation/steward-bug-fix.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  buildScopeProposal,
  composeBugFixBrief,
  decideAutoApproval,
  fetchIssue,
  generateBriefId,
  parseIssueRef,
  type GhExec,
} from '../src/steward-bug-fix.js';

describe('parseIssueRef', () => {
  it('accepts owner/repo#42', () => {
    expect(parseIssueRef('Kstkoda/privacy-tracker#42')).toEqual({
      owner: 'Kstkoda',
      repo: 'privacy-tracker',
      number: 42,
      repo_full: 'Kstkoda/privacy-tracker',
    });
  });

  it('accepts owner/repo/issues/42', () => {
    expect(parseIssueRef('Kstkoda/privacy-tracker/issues/123')).toEqual({
      owner: 'Kstkoda',
      repo: 'privacy-tracker',
      number: 123,
      repo_full: 'Kstkoda/privacy-tracker',
    });
  });

  it('accepts https GitHub URLs', () => {
    expect(parseIssueRef('https://github.com/stenlund/stavr/issues/26')).toEqual({
      owner: 'stenlund',
      repo: 'stavr',
      number: 26,
      repo_full: 'stenlund/stavr',
    });
  });

  it('rejects malformed refs with a clear error message', () => {
    expect(() => parseIssueRef('not-a-ref')).toThrow(/cannot parse issue ref/);
    expect(() => parseIssueRef('Kstkoda/repo#abc')).toThrow(/cannot parse/);
    expect(() => parseIssueRef('')).toThrow(/cannot parse/);
  });

  it('strips whitespace', () => {
    expect(parseIssueRef('  Kstkoda/repo#7  ').number).toBe(7);
  });
});

describe('composeBugFixBrief', () => {
  const ref = parseIssueRef('Kstkoda/privacy-tracker#42');

  it('includes the issue title, state, labels, and body', () => {
    const brief = composeBugFixBrief({
      ref,
      issue: {
        number: 42,
        title: 'Login button is gray',
        body: 'After upgrading to 0.2.0 the login button is unclickable.',
        state: 'open',
        labels: [{ name: 'bug' }, { name: 'priority/high' }],
        url: 'https://github.com/Kstkoda/privacy-tracker/issues/42',
      },
    });
    expect(brief).toContain('# Bug-fix request: Kstkoda/privacy-tracker#42');
    expect(brief).toContain('Title: Login button is gray');
    expect(brief).toContain('State: open');
    expect(brief).toContain('Labels: bug, priority/high');
    expect(brief).toContain('URL: https://github.com/Kstkoda/privacy-tracker/issues/42');
    expect(brief).toContain('After upgrading to 0.2.0');
  });

  it('handles empty bodies', () => {
    const brief = composeBugFixBrief({
      ref,
      issue: { number: 42, title: 't', body: '', state: 'open', labels: [] },
    });
    expect(brief).toContain('_(no body)_');
  });

  it('emits the requested-action list with the explicit stop-after-PR rule', () => {
    const brief = composeBugFixBrief({
      ref,
      issue: { number: 42, title: 't', body: 'b', state: 'open', labels: [] },
    });
    expect(brief).toContain('Stop after the PR opens');
    expect(brief).toContain('Fixes #42');
  });

  it('Labels: none when no labels', () => {
    const brief = composeBugFixBrief({
      ref,
      issue: { number: 42, title: 't', body: 'b', state: 'open', labels: [] },
    });
    expect(brief).toContain('Labels: none');
  });
});

describe('buildScopeProposal', () => {
  const ref = parseIssueRef('Kstkoda/privacy-tracker#42');

  it('scopes allowed_actions to the issue repo only', () => {
    const fixed = new Date('2026-05-13T00:00:00Z');
    const scope = buildScopeProposal({ ref, briefId: 'abc12345', now: () => fixed });
    for (const a of scope.allowed_actions) {
      expect(a.tool).toMatch(/^github\.(create_pr|create_pr_comment|create_issue_comment)$/);
      expect(a.param_constraints?.repo).toBe('Kstkoda/privacy-tracker');
    }
  });

  it('forbids merge + close', () => {
    const scope = buildScopeProposal({ ref, briefId: 'x' });
    const tools = (scope.forbidden_actions ?? []).map((a) => a.tool);
    expect(tools).toContain('github.merge_pr');
    expect(tools).toContain('github.close_issue');
  });

  it('expires 6 hours from now by default', () => {
    const fixed = new Date('2026-05-13T00:00:00Z');
    const scope = buildScopeProposal({ ref, briefId: 'x', now: () => fixed });
    expect(scope.expires_at).toBe('2026-05-13T06:00:00.000Z');
  });

  it('respects custom ttlHours and actionCap', () => {
    const fixed = new Date('2026-05-13T00:00:00Z');
    const scope = buildScopeProposal({
      ref,
      briefId: 'x',
      ttlHours: 2,
      actionCap: 5,
      now: () => fixed,
    });
    expect(scope.expires_at).toBe('2026-05-13T02:00:00.000Z');
    expect(scope.expires_after_actions).toBe(5);
  });

  it('embeds the brief id in scope_id', () => {
    const scope = buildScopeProposal({ ref, briefId: 'abc12345' });
    expect(scope.scope_id).toBe('scope-bug-fix-privacy-tracker-42-abc12345');
  });

  it('reports to dashboard + event-log on every action', () => {
    const scope = buildScopeProposal({ ref, briefId: 'x' });
    expect(scope.reporting.cadence).toBe('every-action');
    expect(scope.reporting.channels).toEqual(['dashboard', 'event-log']);
  });
});

describe('decideAutoApproval', () => {
  it('grants on STAVR_AUTO_APPROVE_BUG_FIXES=1', () => {
    expect(decideAutoApproval({ STAVR_AUTO_APPROVE_BUG_FIXES: '1' })).toEqual({
      granted: true,
      reason: 'STAVR_AUTO_APPROVE_BUG_FIXES=1 in env',
    });
  });

  it('grants on STAVR_AUTO_APPROVE_BUG_FIXES=true (case-insensitive)', () => {
    expect(decideAutoApproval({ STAVR_AUTO_APPROVE_BUG_FIXES: 'TRUE' }).granted).toBe(true);
    expect(decideAutoApproval({ STAVR_AUTO_APPROVE_BUG_FIXES: 'true' }).granted).toBe(true);
  });

  it('does not grant when the env var is missing', () => {
    expect(decideAutoApproval({}).granted).toBe(false);
  });

  it('does not grant on STAVR_AUTO_APPROVE_BUG_FIXES=0 or empty', () => {
    expect(decideAutoApproval({ STAVR_AUTO_APPROVE_BUG_FIXES: '0' }).granted).toBe(false);
    expect(decideAutoApproval({ STAVR_AUTO_APPROVE_BUG_FIXES: '' }).granted).toBe(false);
  });

  it('does not grant on arbitrary other values', () => {
    expect(decideAutoApproval({ STAVR_AUTO_APPROVE_BUG_FIXES: 'yes' }).granted).toBe(false);
  });
});

describe('fetchIssue (gh-injectable)', () => {
  function fakeGh(plan: (args: string[]) => { stdout: string } | { error: string; code?: string; stderr?: string }): GhExec {
    return async (_file, args) => {
      const r = plan(args);
      if ('error' in r) {
        const err = new Error(r.error) as NodeJS.ErrnoException & { stderr?: string };
        if (r.code) err.code = r.code;
        if (r.stderr) err.stderr = r.stderr;
        throw err;
      }
      return { stdout: r.stdout, stderr: '' };
    };
  }

  it('shells gh issue view with --json fields and returns the parsed body', async () => {
    const captured: string[][] = [];
    const exec: GhExec = async (_file, args) => {
      captured.push(args);
      return {
        stdout: JSON.stringify({
          number: 42,
          title: 'broken thing',
          body: 'detail',
          state: 'open',
          labels: [{ name: 'bug' }],
          url: 'https://github.com/Kstkoda/privacy-tracker/issues/42',
        }),
        stderr: '',
      };
    };
    const issue = await fetchIssue(parseIssueRef('Kstkoda/privacy-tracker#42'), exec);
    expect(issue.title).toBe('broken thing');
    expect(issue.labels[0].name).toBe('bug');
    expect(captured[0]).toContain('issue');
    expect(captured[0]).toContain('view');
    expect(captured[0]).toContain('--repo');
    expect(captured[0]).toContain('Kstkoda/privacy-tracker');
    expect(captured[0]).toContain('--json');
  });

  it('surfaces a friendly error when gh is missing (ENOENT)', async () => {
    const exec = fakeGh(() => ({ error: 'spawn gh ENOENT', code: 'ENOENT' }));
    await expect(fetchIssue(parseIssueRef('x/y#1'), exec)).rejects.toThrow(/gh.*not found on PATH/i);
  });

  it('surfaces a friendly error when gh is not authenticated', async () => {
    const exec = fakeGh(() => ({
      error: 'gh exited with 4',
      stderr: 'You are not authenticated to gh. Run `gh auth login` first.',
    }));
    await expect(fetchIssue(parseIssueRef('x/y#1'), exec)).rejects.toThrow(/not authenticated/);
  });

  it('surfaces the issue number in generic-failure errors', async () => {
    const exec = fakeGh(() => ({ error: 'gh exited with 1: rate limit' }));
    await expect(fetchIssue(parseIssueRef('Kstkoda/repo#999'), exec)).rejects.toThrow(/Kstkoda\/repo#999/);
  });
});

describe('generateBriefId', () => {
  it('produces 8-char strings unique enough to dedupe scope ids', () => {
    const a = generateBriefId();
    const b = generateBriefId();
    expect(a.length).toBe(8);
    expect(a).not.toBe(b);
  });
});
