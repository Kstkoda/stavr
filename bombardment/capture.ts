/**
 * Bombardment Phase 1 — preserve-on-failure capture.
 *
 * When an oracle fails (or the harness aborts), dump everything the
 * operator needs to reproduce + triage WITHOUT a second run:
 *   - The last N events from the EventStore (configurable; default 5000)
 *   - A V8 heap snapshot
 *   - The seed + the failed oracle result + any caller-supplied config
 *
 * Artifacts land under `bombardment/artifacts/<runId>-<reason>/`. The
 * runId encodes the seed so multiple parallel CI runs don't collide
 * and a re-run with the same seed lands next to the original artifacts.
 *
 * No third-party deps — `node:v8` + `node:fs` only, so this works on
 * any harness build.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { writeHeapSnapshot } from 'node:v8';
import type { EventStore } from '../src/persistence.js';
import { getSeed } from './seed.js';
import type { OracleResult } from './oracles/index.js';

export interface CaptureOpts {
  /** Subdir name beneath bombardment/artifacts/. Default uses ISO timestamp. */
  runId?: string;
  /** Short reason tag — joined into the dirname. */
  reason: string;
  /** Number of recent events to dump from the EventStore. Default 5000. */
  eventTailSize?: number;
  /** Caller-supplied config snapshot (workload modes, fault config, etc.). */
  extra?: Record<string, unknown>;
  /** The triggering oracle result, when capture was called from an oracle violation. */
  oracleResult?: OracleResult;
}

const ARTIFACTS_ROOT = resolve(process.cwd(), 'bombardment', 'artifacts');

export interface CaptureResult {
  dir: string;
  eventsDumped: number;
  heapSnapshotPath: string | null;
}

/**
 * Capture a failure bundle. Best-effort: any individual capture step that
 * throws is logged to stderr but does not propagate — the goal is to dump
 * as much as we can, not to fail the test a second time.
 */
export function captureOnFailure(store: EventStore | null, opts: CaptureOpts): CaptureResult {
  const seed = getSeed();
  const runId = opts.runId ?? `${new Date().toISOString().replace(/[:.]/g, '-')}-seed${seed}`;
  const dir = join(ARTIFACTS_ROOT, `${runId}-${opts.reason.replace(/[^a-zA-Z0-9._-]/g, '_')}`);
  mkdirSync(dir, { recursive: true });

  let eventsDumped = 0;
  if (store) {
    try {
      const limit = opts.eventTailSize ?? 5000;
      const rows = store.rawDb
        .prepare(`SELECT id, kind, source_agent, correlation_id, payload_json, created_at FROM events ORDER BY id DESC LIMIT ?`)
        .all(limit) as Array<{ id: string; kind: string; source_agent: string | null; correlation_id: string | null; payload_json: string; created_at: string }>;
      // Reverse so the file reads chronologically.
      rows.reverse();
      writeFileSync(join(dir, 'events.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
      eventsDumped = rows.length;
    } catch (err) {
      process.stderr.write(`[bombardment/capture] event dump failed: ${(err as Error).message}\n`);
    }
  }

  let heapPath: string | null = null;
  try {
    heapPath = join(dir, `heap-${Date.now()}.heapsnapshot`);
    writeHeapSnapshot(heapPath);
  } catch (err) {
    process.stderr.write(`[bombardment/capture] heap snapshot failed: ${(err as Error).message}\n`);
    heapPath = null;
  }

  try {
    const manifest = {
      reason: opts.reason,
      runId,
      seed,
      seed_env: 'STAVR_HARDENING_SEED',
      captured_at: new Date().toISOString(),
      events_dumped: eventsDumped,
      heap_snapshot: heapPath,
      oracle_result: opts.oracleResult ?? null,
      extra: opts.extra ?? {},
    };
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  } catch (err) {
    process.stderr.write(`[bombardment/capture] manifest write failed: ${(err as Error).message}\n`);
  }

  return { dir, eventsDumped, heapSnapshotPath: heapPath };
}
