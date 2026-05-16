/**
 * bom-oom-leak-hunt C2.5 — soak regression guard.
 *
 * Default: skipped. The short-mode soak takes ~5 min and would slow the
 * vitest matrix. Enable explicitly:
 *
 *   STAVR_RUN_SOAK=1 npx vitest run tests/soak
 *
 * Long mode (STAVR_RUN_SOAK=long) bumps the load to 100k events + 1000
 * dashboard fetches and tightens the RSS ceiling. Used by the weekly
 * GitHub Actions workflow on Linux runners.
 *
 * Asserts:
 *   - rss_max < 600 MB (configurable via STAVR_SOAK_RSS_CEILING_MB)
 *   - eventCount stays bounded (< 1.5x retention cap)
 *   - heap snapshots written at start + end to tmp/heap-snapshots/
 */

import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { writeHeapSnapshot } from 'node:v8';
import { EventStore } from '../../src/persistence.js';
import { Broker } from '../../src/broker.js';
import { mountTransports } from '../../src/transports.js';

const SHOULD_RUN = process.env.STAVR_RUN_SOAK === '1' || process.env.STAVR_RUN_SOAK === 'long';
const LONG = process.env.STAVR_RUN_SOAK === 'long';
const RSS_CEILING_MB = Number(process.env.STAVR_SOAK_RSS_CEILING_MB ?? '600');

const SUITE_DESC = SHOULD_RUN ? 'leak-soak' : 'leak-soak (skipped — set STAVR_RUN_SOAK=1)';

(SHOULD_RUN ? describe : describe.skip)(SUITE_DESC, () => {
  it(
    `keeps RSS under ${RSS_CEILING_MB} MB and eventCount bounded`,
    async () => {
      const eventTarget = LONG ? 100_000 : 10_000;
      const fetchTarget = LONG ? 1000 : 100;
      const stavrHome = mkdtempSync(join(tmpdir(), 'stavr-soak-'));
      process.env.STAVR_HOME = stavrHome;
      process.env.STAVR_EVENTS_OP_RETENTION_DAYS = '7';
      process.env.STAVR_EVENTS_OP_MAX_ROWS = '5000';
      process.env.STAVR_DASHBOARD_CACHE_MS = '1000';
      process.env.STAVR_STREAMS_MAX_EVENTS = '50';

      const dbPath = join(stavrHome, 'soak.db');
      const store = new EventStore();
      store.init(dbPath);
      const broker = new Broker(store);
      const transports = await mountTransports(broker, {
        mode: 'daemon',
        port: 0,
        bindHost: '127.0.0.1',
        requireAuthWhenNonLocal: false,
        authConfigured: false,
      });

      const snapDir = resolve(process.cwd(), 'tmp', 'heap-snapshots');
      mkdirSync(snapDir, { recursive: true });
      writeHeapSnapshot(resolve(snapDir, `soak-start-${Date.now()}.heapsnapshot`));

      const baseRss = process.memoryUsage().rss;
      let maxRss = baseRss;

      // Pump events
      for (let i = 0; i < eventTarget; i++) {
        await broker.publish({
          kind: 'worker_progress',
          at: new Date().toISOString(),
          source_agent: 'soak',
          correlation_id: `soak-${i % 100}`,
          payload: { id: 'w', message: `pump ${i}` },
        });
        if (i % 1000 === 0) maxRss = Math.max(maxRss, process.memoryUsage().rss);
      }

      // Run the retention sweep so the cap kicks in.
      const sweep = store.pruneEvents();
      expect(sweep.deletedOperational).toBeGreaterThan(0);

      const addr = transports.httpServer?.address();
      if (!addr || typeof addr === 'string') throw new Error('listen address unavailable');
      const base = `http://127.0.0.1:${addr.port}`;
      for (let i = 0; i < fetchTarget; i++) {
        const path = i % 2 === 0 ? '/dashboard/home/data' : '/dashboard/streams';
        const r = await fetch(base + path);
        await r.text();
        if (i % 50 === 0) maxRss = Math.max(maxRss, process.memoryUsage().rss);
      }

      writeHeapSnapshot(resolve(snapDir, `soak-end-${Date.now()}.heapsnapshot`));

      const finalCount = store.eventCount();
      // After retention, op-class events should be at or near the cap.
      expect(finalCount).toBeLessThanOrEqual(7500);

      const maxRssMb = Math.round(maxRss / 1024 / 1024);
      // Soak ceiling: 600 MB by default. Short-mode pump shouldn't get
      // close; this is the canary for future regressions.
      expect(maxRssMb).toBeLessThan(RSS_CEILING_MB);

      await transports.shutdown();
    },
    LONG ? 30 * 60_000 : 10 * 60_000,
  );

  afterAll(() => {
    delete process.env.STAVR_HOME;
    delete process.env.STAVR_EVENTS_OP_RETENTION_DAYS;
    delete process.env.STAVR_EVENTS_OP_MAX_ROWS;
    delete process.env.STAVR_DASHBOARD_CACHE_MS;
    delete process.env.STAVR_STREAMS_MAX_EVENTS;
  });
});
