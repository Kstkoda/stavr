#!/usr/bin/env tsx
/**
 * OOM leak-hunt (bom-oom-leak-hunt C1.5) — controlled repro of the heap
 * growth shape observed in the 2026-05-15 daemon crash.
 *
 * What it does:
 *  1. Boots an in-process daemon (EventStore + Broker + transports) on a
 *     loopback random port using an isolated STAVR_HOME so it doesn't
 *     collide with the user's real daemon.
 *  2. Captures heap snapshot #1 (baseline, empty store).
 *  3. Pumps N synthetic events (default 50k) directly through broker.publish
 *     — same write path the broker hits in production.
 *  4. Captures heap snapshot #2 (after pump).
 *  5. Makes M dashboard requests (default 200) hitting the home + streams
 *     JSON endpoints, exercising getEvents({limit:500}) and homeData().
 *  6. Captures heap snapshot #3 (after dashboard storm).
 *  7. Writes a summary to stdout and a `leak-repro-summary.json` next to
 *     the snapshots with memoryUsage deltas, event count, and timings.
 *
 * Run with:
 *   npx tsx scripts/leak-repro.ts
 * Tunables:
 *   LEAK_REPRO_EVENTS (default 50000)
 *   LEAK_REPRO_FETCHES (default 200)
 *   LEAK_REPRO_PORT (default random ephemeral)
 *
 * Snapshots land in ./tmp/heap-snapshots/. The summary JSON is committable;
 * the .heapsnapshot files are not (.gitignored — they're large and may
 * contain sensitive payloads).
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { writeHeapSnapshot } from 'node:v8';
import { EventStore } from '../src/persistence.js';
import { Broker } from '../src/broker.js';
import { mountTransports } from '../src/transports.js';

interface SnapshotPoint {
  label: string;
  at: string;
  file: string;
  memoryUsage: NodeJS.MemoryUsage;
  eventCount: number;
  elapsed_ms: number;
}

async function main(): Promise<void> {
  const eventTarget = Number(process.env.LEAK_REPRO_EVENTS ?? '50000');
  const fetchTarget = Number(process.env.LEAK_REPRO_FETCHES ?? '200');
  const port = Number(process.env.LEAK_REPRO_PORT ?? '0') || pickEphemeralPort();

  const snapDir = resolve(process.cwd(), 'tmp', 'heap-snapshots');
  mkdirSync(snapDir, { recursive: true });

  // Isolated STAVR_HOME so we don't touch the user's real ~/.stavr DB.
  const stavrHome = mkdtempSync(join(tmpdir(), 'leak-repro-'));
  process.env.STAVR_HOME = stavrHome;
  const dbPath = join(stavrHome, 'runestone.db');

  console.log(`[leak-repro] target events=${eventTarget} fetches=${fetchTarget}`);
  console.log(`[leak-repro] db=${dbPath}`);
  console.log(`[leak-repro] snapshot dir=${snapDir}`);

  const store = new EventStore();
  store.init(dbPath);
  const broker = new Broker(store);
  const transports = await mountTransports(broker, {
    mode: 'daemon',
    port,
    bindHost: '127.0.0.1',
    requireAuthWhenNonLocal: false,
    authConfigured: false,
  });

  const t0 = performance.now();
  const points: SnapshotPoint[] = [];

  const snap = (label: string): SnapshotPoint => {
    if (global.gc) {
      try { global.gc(); } catch { /* ignore if --expose-gc not set */ }
    }
    const file = writeHeapSnapshot(resolve(snapDir, `repro-${label}-${Date.now()}.heapsnapshot`));
    const point: SnapshotPoint = {
      label,
      at: new Date().toISOString(),
      file,
      memoryUsage: process.memoryUsage(),
      eventCount: safeEventCount(store),
      elapsed_ms: Math.round(performance.now() - t0),
    };
    console.log(
      `[leak-repro] snapshot ${label}: file=${file} rss=${mb(point.memoryUsage.rss)}MB heapUsed=${mb(
        point.memoryUsage.heapUsed,
      )}MB events=${point.eventCount}`,
    );
    points.push(point);
    return point;
  };

  // 1) baseline
  snap('baseline');

  // 2) pump events
  console.log(`[leak-repro] pumping ${eventTarget} events …`);
  const pumpStart = performance.now();
  for (let i = 0; i < eventTarget; i++) {
    await broker.publish({
      kind: 'progress',
      at: new Date().toISOString(),
      source_agent: 'leak-repro',
      correlation_id: `repro-${i % 100}`,
      payload: { message: `synthetic event ${i} ` + 'x'.repeat(120) },
    });
    if (i > 0 && i % 5000 === 0) {
      console.log(`[leak-repro]   ${i}/${eventTarget} pumped (rss=${mb(process.memoryUsage().rss)}MB)`);
    }
  }
  console.log(`[leak-repro] pump done in ${Math.round(performance.now() - pumpStart)} ms`);
  snap('after-pump');

  // 3) dashboard fetch storm
  if (!transports.httpServer) throw new Error('http server did not start; nothing to fetch');
  const addr = transports.httpServer.address();
  if (!addr || typeof addr === 'string') throw new Error('unexpected listen address');
  const base = `http://127.0.0.1:${addr.port}`;
  console.log(`[leak-repro] fetching ${fetchTarget} requests against ${base} …`);
  const fetchStart = performance.now();
  for (let i = 0; i < fetchTarget; i++) {
    // Hit both pages — home/data is the 5s polling JSON endpoint;
    // /dashboard/streams is the HTML render that calls streamsData() and
    // hits broker.store.getEvents({ limit: 500 }) per render. Alternating
    // exercises both leaky paths the recon flagged.
    const path = i % 2 === 0 ? '/dashboard/home/data' : '/dashboard/streams';
    try {
      const res = await fetch(base + path);
      // Drain the body so the connection releases.
      await res.text();
    } catch (err) {
      console.warn(`[leak-repro]   fetch #${i} ${path} failed: ${(err as Error).message}`);
    }
    if (i > 0 && i % 25 === 0) {
      console.log(`[leak-repro]   ${i}/${fetchTarget} fetches (rss=${mb(process.memoryUsage().rss)}MB)`);
    }
  }
  console.log(`[leak-repro] fetches done in ${Math.round(performance.now() - fetchStart)} ms`);
  snap('after-fetches');

  // Summary
  const summary = {
    repro_ran_at: new Date().toISOString(),
    target_events: eventTarget,
    target_fetches: fetchTarget,
    db_path: dbPath,
    snapshot_dir: snapDir,
    points,
    deltas: {
      rss_pumped: points[1].memoryUsage.rss - points[0].memoryUsage.rss,
      rss_after_fetches: points[2].memoryUsage.rss - points[0].memoryUsage.rss,
      heapUsed_pumped: points[1].memoryUsage.heapUsed - points[0].memoryUsage.heapUsed,
      heapUsed_after_fetches: points[2].memoryUsage.heapUsed - points[0].memoryUsage.heapUsed,
      arrayBuffers_after_fetches: points[2].memoryUsage.arrayBuffers - points[0].memoryUsage.arrayBuffers,
    },
  };
  const summaryPath = resolve(snapDir, `leak-repro-summary-${Date.now()}.json`);
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  console.log(`[leak-repro] summary written to ${summaryPath}`);
  console.log(
    `[leak-repro] RSS delta after fetches: +${mb(summary.deltas.rss_after_fetches)}MB; ` +
      `heapUsed delta: +${mb(summary.deltas.heapUsed_after_fetches)}MB`,
  );

  await transports.shutdown();
  // Don't close the store explicitly — transports.shutdown already does it.
}

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

function safeEventCount(store: EventStore): number {
  try { return store.eventCount(); } catch { return -1; }
}

function pickEphemeralPort(): number {
  // 0 tells the OS to assign; mountTransports honors it via http.listen.
  return 0;
}

main().catch((err) => {
  console.error('[leak-repro] failed:', err);
  process.exit(1);
});
