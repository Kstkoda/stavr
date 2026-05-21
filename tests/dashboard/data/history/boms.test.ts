import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, utimesSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fetchBomsHistory, parseFrontmatter } from '../../../../src/dashboard/data/history/boms.js';

describe('parseFrontmatter', () => {
  it('returns null when no frontmatter block is present', () => {
    expect(parseFrontmatter('# Just a title\nBody')).toBeNull();
  });

  it('parses a flat YAML-ish block', () => {
    const md = '---\ntitle: My BOM\nauthor: operator\nstatus: draft\n---\n# Body';
    expect(parseFrontmatter(md)).toEqual({ title: 'My BOM', author: 'operator', status: 'draft' });
  });

  it('returns null when the block is unterminated', () => {
    expect(parseFrontmatter('---\ntitle: x\n')).toBeNull();
  });
});

describe('fetchBomsHistory', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stavr-bom-test-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeBom(name: string, body: string, mtime: Date): void {
    const abs = join(dir, name);
    writeFileSync(abs, body);
    utimesSync(abs, mtime, mtime);
  }

  it('returns empty page when bomsDir does not exist', () => {
    const page = fetchBomsHistory({ bomsDir: join(dir, 'does-not-exist') });
    expect(page.items).toEqual([]);
    expect(page.total_estimate).toBe(0);
  });

  it('lists .md files sorted by mtime DESC', () => {
    writeBom('v0_5-foo.md', '# Foo', new Date('2026-05-20T08:00:00Z'));
    writeBom('v0_6-bar.md', '# Bar', new Date('2026-05-20T10:00:00Z'));
    writeBom('v0_7-baz.md', '# Baz', new Date('2026-05-20T09:00:00Z'));
    writeBom('not-a-bom.txt', 'ignored', new Date('2026-05-20T11:00:00Z'));
    const page = fetchBomsHistory({ bomsDir: dir });
    expect(page.items.map((i) => i.id)).toEqual(['v0_6-bar.md', 'v0_7-baz.md', 'v0_5-foo.md']);
    expect(page.items[0].title).toBe('Bar');
  });

  it('respects since/until + pagination', () => {
    for (let i = 0; i < 5; i++) {
      writeBom(`v0_${i}.md`, `# v${i}`, new Date(`2026-05-20T0${i}:00:00Z`));
    }
    const inRange = fetchBomsHistory(
      { bomsDir: dir },
      { since: '2026-05-20T02:00:00Z', until: '2026-05-20T05:00:00Z' },
    );
    expect(inRange.items.map((i) => i.id)).toEqual(['v0_4.md', 'v0_3.md', 'v0_2.md']);
    const paginated = fetchBomsHistory({ bomsDir: dir }, { limit: 2 });
    expect(paginated.items).toHaveLength(2);
    expect(paginated.next_cursor).toBe('2');
    expect(paginated.total_estimate).toBe(5);
  });

  it('uses frontmatter title + author when present', () => {
    writeBom('with-fm.md', '---\ntitle: Custom Title\nauthor: cc\n---\n# Body', new Date('2026-05-20T10:00:00Z'));
    const page = fetchBomsHistory({ bomsDir: dir });
    expect(page.items[0].title).toBe('Custom Title');
    expect(page.items[0].actor).toBe('cc');
  });
});
