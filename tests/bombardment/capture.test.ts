/**
 * Bombardment Phase 1 — preserve-on-failure capture test.
 *
 * We don't want this test to litter the real `bombardment/artifacts/`
 * directory, so we chdir into a tmpdir and let `captureOnFailure`
 * land its dump there. Asserts the manifest + events.jsonl + a
 * heapsnapshot all exist.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../../src/persistence.js';
import { captureOnFailure } from '../../bombardment/capture.js';
import { setSeedForTest } from '../../bombardment/seed.js';

describe('bombardment/capture', () => {
  let workdir: string;
  let originalCwd: string;
  beforeEach(() => {
    setSeedForTest(99);
    originalCwd = process.cwd();
    workdir = mkdtempSync(join(tmpdir(), 'bombardment-capture-'));
    process.chdir(workdir);
  });
  afterEach(() => {
    process.chdir(originalCwd);
    try {
      rmSync(workdir, { recursive: true, force: true });
    } catch {
      /* WAL handles on Windows may linger; harmless */
    }
  });

  it('writes manifest, events.jsonl, and a heap snapshot', () => {
    const store = new EventStore();
    store.init(':memory:');
    // Stash a couple of events so events.jsonl has content.
    store.appendEvent({ kind: 'progress', at: new Date().toISOString(), source_agent: 'test', payload: { msg: 'a' } } as never);
    store.appendEvent({ kind: 'progress', at: new Date().toISOString(), source_agent: 'test', payload: { msg: 'b' } } as never);

    const result = captureOnFailure(store, {
      reason: 'oracle_violation',
      oracleResult: { name: 'no_orphan_sessions', ok: false, durationMs: 1, reason: 'synthetic' },
      extra: { workload: 'sse_churn' },
    });

    expect(existsSync(result.dir)).toBe(true);
    expect(result.dir).toContain('seed99');
    expect(result.dir).toContain('oracle_violation');
    const files = readdirSync(result.dir);
    expect(files).toContain('manifest.json');
    expect(files).toContain('events.jsonl');
    expect(files.some((f) => f.endsWith('.heapsnapshot'))).toBe(true);

    const manifest = JSON.parse(readFileSync(join(result.dir, 'manifest.json'), 'utf8'));
    expect(manifest.seed).toBe(99);
    expect(manifest.events_dumped).toBe(2);
    expect(manifest.oracle_result.name).toBe('no_orphan_sessions');
    expect(manifest.extra.workload).toBe('sse_churn');
  });

  it('tolerates a null store by dumping just the heap + manifest', () => {
    const result = captureOnFailure(null, { reason: 'startup_failure' });
    expect(existsSync(result.dir)).toBe(true);
    expect(result.eventsDumped).toBe(0);
    const files = readdirSync(result.dir);
    expect(files).toContain('manifest.json');
    expect(files).not.toContain('events.jsonl');
  });
});
