/**
 * Git-log history fetcher. Shells out to `git log` for the working tree
 * passed via `sources.cwd`. Returns one HistoryItem per commit.
 *
 * Read-only by construction — `git log` has no side effects. We pass
 * `--since` and `--until` through directly so SQLite-free time-range
 * filtering works without buffering the full history in memory.
 *
 * Robustness:
 *   - non-zero exit (no git, not a repo, bad range) → empty page, never
 *     throw. The page surfaces this as an empty section, not a crash.
 *   - parsed lines are token-tolerant: a malformed line is dropped, the
 *     surrounding history still renders.
 *
 * The `execRunner` injection seam lets tests stub the actual git invocation
 * with a canned string — that's what the test pack does to avoid depending
 * on the developer's clone state.
 */
import { spawnSync } from 'node:child_process';
import {
  type HistoryItem,
  type HistoryPage,
  type HistoryQuery,
  nextCursor,
  normalizeQuery,
} from './types.js';

export interface CommitsHistorySources {
  cwd: string;
  /** Test seam: override the git invocation. */
  execRunner?: (args: string[], cwd: string) => { stdout: string; status: number };
}

export interface CommitPayload {
  sha: string;
  subject: string;
  author_email: string;
  author_name: string;
  author_iso: string;
  /** Short SHA — first 7 hex chars. */
  short_sha: string;
}

/**
 * Sentinel record separator + field separator. ASCII unit-separator
 * (0x1f) for fields, ASCII record-separator (0x1e) for records. Both are
 * disallowed in commit messages by git, so this can't collide with a
 * commit subject.
 */
const FS = '\x1f';
const RS = '\x1e';

const FORMAT = `--pretty=format:%H${FS}%s${FS}%ae${FS}%an${FS}%aI${RS}`;

function defaultRunner(args: string[], cwd: string): { stdout: string; status: number } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.error || r.status == null) return { stdout: '', status: 1 };
  return { stdout: r.stdout ?? '', status: r.status };
}

export function parseGitLog(out: string): CommitPayload[] {
  const records = out.split(RS).map((r) => r.replace(/^\n+/, '')).filter((r) => r.length > 0);
  const commits: CommitPayload[] = [];
  for (const rec of records) {
    const fields = rec.split(FS);
    if (fields.length < 5) continue;
    const [sha, subject, email, name, iso] = fields;
    if (!sha || !iso) continue;
    commits.push({
      sha,
      subject,
      author_email: email,
      author_name: name,
      author_iso: iso,
      short_sha: sha.slice(0, 7),
    });
  }
  return commits;
}

export function fetchCommitsHistory(
  sources: CommitsHistorySources,
  query: HistoryQuery = {},
): HistoryPage<HistoryItem> {
  const { since, until, limit, offset } = normalizeQuery(query);
  const runner = sources.execRunner ?? defaultRunner;
  const args = ['log', FORMAT, `-n`, String(limit + offset)];
  if (since) args.push(`--since=${since}`);
  if (until) args.push(`--until=${until}`);
  const result = runner(args, sources.cwd);
  if (result.status !== 0) {
    return { items: [], next_cursor: null, total_estimate: 0 };
  }
  const commits = parseGitLog(result.stdout);
  const page = commits.slice(offset, offset + limit);
  const items: HistoryItem[] = page.map((c) => ({
    kind: 'commit',
    id: c.sha,
    at: c.author_iso,
    title: c.subject,
    actor: c.author_name,
    payload: c,
  }));
  return {
    items,
    next_cursor: nextCursor(offset, limit, items.length),
    total_estimate: commits.length,
  };
}
