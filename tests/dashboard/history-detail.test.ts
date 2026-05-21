/**
 * P3 tests — per-kind detail renderer + source-link helpers + markdown
 * sanitization. Doesn't boot the daemon; calls the renderer directly.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventStore } from '../../src/persistence.js';
import { renderHistoryDetail, gitHubCommitUrl, gitHubPrUrl } from '../../src/dashboard/data/history/detail.js';
import {
  classifyLink,
  renderSourceLink,
} from '../../src/dashboard/components/source-link.js';
import { renderSafeMarkdown } from '../../src/dashboard/components/history-drawer.js';

describe('renderSafeMarkdown', () => {
  it('escapes script tags', () => {
    const html = renderSafeMarkdown('<script>alert(1)</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders headings + inline code + bold', () => {
    const html = renderSafeMarkdown('# Title\n\nA **bold** word with `code`.');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<code>code</code>');
  });

  it('rejects javascript: URLs in links', () => {
    const html = renderSafeMarkdown('Click [here](javascript:alert(1))');
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('here');
  });

  it('renders bullet lists + fenced code', () => {
    const html = renderSafeMarkdown('- one\n- two\n\n```\nx = 1\n```\n');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('<pre><code>');
  });
});

describe('classifyLink + renderSourceLink', () => {
  it('classifies external https URLs as external', () => {
    expect(classifyLink('https://github.com/x/y')).toBe('external');
  });
  it('classifies leading-slash paths as internal', () => {
    expect(classifyLink('/dashboard/history')).toBe('internal');
  });
  it('treats anything else as plain', () => {
    expect(classifyLink('javascript:alert(1)')).toBe('plain');
  });
  it('renders external links with rel=noopener noreferrer + target=_blank', () => {
    const html = renderSourceLink({ href: 'https://x.test', label: 'View' });
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('target="_blank"');
  });
  it('renders plain as a span (no href)', () => {
    const html = renderSourceLink({ href: 'data:text/html,xyz', label: 'View' });
    expect(html).not.toContain('href');
    expect(html).toContain('<span');
  });
});

describe('gitHubCommitUrl + gitHubPrUrl', () => {
  it('returns null for invalid SHA + repo', () => {
    expect(gitHubCommitUrl('', 'x/y')).toBeNull();
    expect(gitHubCommitUrl('badbeef', 'noslash')).toBeNull();
    expect(gitHubPrUrl(-1, 'x/y')).toBeNull();
  });
  it('builds the expected URLs', () => {
    expect(gitHubCommitUrl('1234567', 'Kstkoda/stavr')).toBe('https://github.com/Kstkoda/stavr/commit/1234567');
    expect(gitHubPrUrl(42, 'Kstkoda/stavr')).toBe('https://github.com/Kstkoda/stavr/pull/42');
  });
});

describe('renderHistoryDetail', () => {
  let store: EventStore;
  let db: import('better-sqlite3').Database;
  let bomsDir: string;

  beforeEach(() => {
    store = new EventStore();
    store.init(':memory:');
    db = store.rawDb;
    bomsDir = mkdtempSync(join(tmpdir(), 'stavr-detail-test-'));
  });
  afterEach(() => {
    rmSync(bomsDir, { recursive: true, force: true });
    store.close();
  });

  it('returns missing=true for an unknown decision', () => {
    const r = renderHistoryDetail('decision', 'nope', { db, bomsDir });
    expect(r.missing).toBe(true);
    expect(r.html).toContain('Decision not found');
  });

  it('renders an inline-rendered BOM markdown file', () => {
    writeFileSync(join(bomsDir, 'v0_8.md'), '# Hello\nWorld');
    const r = renderHistoryDetail('bom-file', 'v0_8.md', { db, bomsDir });
    expect(r.missing).toBeUndefined();
    expect(r.html).toContain('<h1>Hello</h1>');
  });

  it('returns missing=true with the original filename when the BOM is gone', () => {
    const r = renderHistoryDetail('bom-file', 'v0_X.md', { db, bomsDir });
    expect(r.missing).toBe(true);
    expect(r.html).toContain('BOM file no longer on disk');
    expect(r.html).toContain('v0_X.md');
  });

  it('renders a decision with options + chosen', () => {
    db.prepare(
      `INSERT INTO decisions (correlation_id, question, options_json, default_option_id, timeout_sec, status, requested_at, expires_at, responded_by, chosen_option_id)
       VALUES (?, ?, ?, NULL, 60, 'responded', ?, ?, ?, ?)`,
    ).run(
      'cid-1',
      'Approve fix?',
      JSON.stringify([{ id: 'a', label: 'Approve' }, { id: 'd', label: 'Deny' }]),
      '2026-05-20T10:00:00Z',
      '2099-01-01T00:00:00Z',
      'operator',
      'a',
    );
    const r = renderHistoryDetail('decision', 'cid-1', { db, bomsDir });
    expect(r.html).toContain('Approve fix?');
    expect(r.html).toContain('Approve');
  });

  it('renders host-exec with raw payload toggle', () => {
    db.prepare(
      `INSERT INTO events (id, kind, correlation_id, source_agent, payload_json, at, persisted_at, seq, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'ev-1',
      'host_exec_started',
      'corr-1',
      'cc',
      JSON.stringify({ command: 'git', scope_id: 'ts-1', args_count: 2, args_hash: 'h', timeout_ms: 5000 }),
      '2026-05-20T10:00:00Z',
      '2026-05-20T10:00:00Z',
      1,
      '2026-05-20T10:00:00Z',
    );
    const r = renderHistoryDetail('host-exec', 'ev-1', { db, bomsDir });
    expect(r.html).toContain('git');
    expect(r.html).toContain('data-role="show-raw"');
    // Raw payload pre-block exists but starts hidden.
    expect(r.html).toMatch(/<pre class="hist-drawer-raw"\s+hidden/);
  });

  it('renders unknown kind as missing', () => {
    const r = renderHistoryDetail('not-a-kind', 'x', { db, bomsDir });
    expect(r.missing).toBe(true);
  });
});
