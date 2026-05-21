import { describe, expect, it, vi } from 'vitest';
import { fetchCommitsHistory, parseGitLog } from '../../../../src/dashboard/data/history/commits.js';

const FS = '\x1f';
const RS = '\x1e';

function makeLog(commits: Array<{ sha: string; subject: string; email: string; name: string; iso: string }>): string {
  return commits
    .map((c) => [c.sha, c.subject, c.email, c.name, c.iso].join(FS) + RS)
    .join('\n');
}

describe('parseGitLog', () => {
  it('parses well-formed records', () => {
    const out = makeLog([
      { sha: 'abc1234567890', subject: 'fix: thing', email: 'a@b.c', name: 'Alice', iso: '2026-05-20T08:00:00Z' },
      { sha: 'def4567890abc', subject: 'feat: other', email: 'b@c.d', name: 'Bob',   iso: '2026-05-20T09:00:00Z' },
    ]);
    const commits = parseGitLog(out);
    expect(commits.map((c) => c.short_sha)).toEqual(['abc1234', 'def4567']);
    expect(commits[0].subject).toBe('fix: thing');
  });

  it('drops malformed records', () => {
    const out = `incomplete-record${RS}good-sha${FS}good-subj${FS}e@x${FS}n${FS}2026-05-20T01:00:00Z${RS}`;
    const commits = parseGitLog(out);
    expect(commits).toHaveLength(1);
    expect(commits[0].subject).toBe('good-subj');
  });
});

describe('fetchCommitsHistory', () => {
  it('returns rows + short SHA per commit', () => {
    const runner = vi.fn().mockReturnValue({
      status: 0,
      stdout: makeLog([
        { sha: '1234567890abcdef', subject: 'feat: x', email: 'a@b.c', name: 'Alice', iso: '2026-05-20T08:00:00Z' },
      ]),
    });
    const page = fetchCommitsHistory({ cwd: '/x', execRunner: runner });
    expect(page.items).toHaveLength(1);
    expect(page.items[0].id).toBe('1234567890abcdef');
    expect(page.items[0].title).toBe('feat: x');
    expect(page.items[0].actor).toBe('Alice');
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('returns empty page when git exits non-zero', () => {
    const runner = vi.fn().mockReturnValue({ status: 128, stdout: '' });
    const page = fetchCommitsHistory({ cwd: '/x', execRunner: runner });
    expect(page.items).toEqual([]);
    expect(page.total_estimate).toBe(0);
  });

  it('forwards since/until + paginates', () => {
    const runner = vi.fn().mockReturnValue({
      status: 0,
      stdout: makeLog([
        { sha: 's1' + 'a'.repeat(14), subject: 'one',   email: 'a@a', name: 'A', iso: '2026-05-20T03:00:00Z' },
        { sha: 's2' + 'b'.repeat(14), subject: 'two',   email: 'a@a', name: 'A', iso: '2026-05-20T02:00:00Z' },
        { sha: 's3' + 'c'.repeat(14), subject: 'three', email: 'a@a', name: 'A', iso: '2026-05-20T01:00:00Z' },
      ]),
    });
    const page = fetchCommitsHistory(
      { cwd: '/x', execRunner: runner },
      { since: '2026-05-19', until: '2026-05-21', limit: 2 },
    );
    expect(page.items.map((i) => i.title)).toEqual(['one', 'two']);
    expect(page.next_cursor).toBe('2');
    const args = runner.mock.calls[0][0] as string[];
    expect(args).toContain('--since=2026-05-19');
    expect(args).toContain('--until=2026-05-21');
  });
});
