import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileCapture, CAPTURE_TYPES } from '../../src/tools/capture.js';

describe('fileCapture — write path for the Capture ⊕ button', () => {
  it('appends a jsonl line per capture into <type>.jsonl', () => {
    const dir = mkdtempSync(join(tmpdir(), 'capture-test-'));
    const r1 = fileCapture(
      { comment: 'first one', type: 'bug', priority: 'normal', snapshot: {} },
      { capturesDir: dir },
    );
    const r2 = fileCapture(
      { comment: 'second one', type: 'bug', priority: 'high', snapshot: { page: 'helm' } },
      { capturesDir: dir },
    );
    expect(r1.destination).toBe('local');
    expect(r1.file.endsWith('bug.jsonl')).toBe(true);
    expect(r1.id).not.toBe(r2.id);
    const lines = readFileSync(join(dir, 'bug.jsonl'), 'utf8').trim().split('\n');
    expect(lines.length).toBe(2);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0].comment).toBe('first one');
    expect(parsed[0].priority).toBe('normal');
    expect(parsed[1].comment).toBe('second one');
    expect(parsed[1].snapshot.page).toBe('helm');
  });

  it('rejects empty comment', () => {
    const dir = mkdtempSync(join(tmpdir(), 'capture-test-'));
    expect(() => fileCapture(
      { comment: '', type: 'bug', priority: 'normal', snapshot: {} },
      { capturesDir: dir },
    )).toThrow(/comment is required/);
  });

  it('rejects unknown type', () => {
    const dir = mkdtempSync(join(tmpdir(), 'capture-test-'));
    expect(() => fileCapture(
      { comment: 'x', type: 'oops' as never, priority: 'normal', snapshot: {} },
      { capturesDir: dir },
    )).toThrow(/type must be one of/);
  });

  it('routes each type into a separate file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'capture-test-'));
    for (const t of CAPTURE_TYPES) {
      fileCapture({ comment: 'hi', type: t, priority: 'normal', snapshot: {} }, { capturesDir: dir });
    }
    for (const t of CAPTURE_TYPES) {
      expect(existsSync(join(dir, `${t}.jsonl`))).toBe(true);
    }
  });
});
