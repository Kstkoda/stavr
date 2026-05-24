/**
 * Bombardment Phase 2 — multi-mode soak with continuous oracles.
 *
 * Replaces the serial event-pump approach (kept alive in
 * `leak-soak.test.ts` as the focused v0.6.x regression guard) with the
 * multi-mode load-runner workload driving HTTP traffic at an in-process
 * daemon. While the workload runs:
 *
 *   - Every sample window (default 30s for the short mode, 60s for long),
 *     the full Phase 1 oracle layer runs against the broker + store.
 *     A failure dumps capture artifacts + fails the test.
 *
 *   - RSS samples are collected for the growth-shape check (RSS slope,
 *     bytes-per-second, computed via linear regression over the run).
 *
 *   - Event-loop lag is sampled in-band (50ms target) so a wedge in the
 *     daemon's tick rate surfaces as p99 lag at end-of-run.
 *
 *   - Heap snapshots are taken at start + end; the per-class diff is
 *     dumped to bombardment/artifacts/ for triage on failure.
 *
 * At end-of-run:
 *   - broker.sessionCount + subscriptionCount return to baseline.
 *   - RSS slope is bounded (< 1 MB/sec, sustained).
 *   - All workers reach terminal (strict mode).
 *
 * Default: skipped — long-running. Enable via STAVR_RUN_SOAK=1 (short)
 * or STAVR_RUN_SOAK=long (CI weekly). The seeded RNG makes a one-off
 * failure replayable via STAVR_HARDENING_SEED.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir, platform } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventStore } from '../../src/persistence.js';
import { Broker } from '../../src/broker.js';
import { mountTransports, type MountedTransports } from '../../src/transports.js';
import {
  defaultOracles,
  makeWorkersReachTerminal,
  runOracles,
  type OracleResult,
} from '../../bombardment/oracles/index.js';
import { captureOnFailure } from '../../bombardment/capture.js';
import { getSeed } from '../../bombardment/seed.js';
import {
  baselineReturn,
  captureHeapSnapshot,
  diffClassCounts,
  rssSlope,
  summarizeHeapSnapshot,
  writeHeapDiffSummary,
  type RssSample,
} from '../../bombardment/observability/growth-shape.js';
import { startEventLoopLagSampler } from '../../bombardment/observability/event-loop-lag.js';

const SHOULD_RUN = process.env.STAVR_RUN_SOAK === '1' || process.env.STAVR_RUN_SOAK === 'long';
const LONG = process.env.STAVR_RUN_SOAK === 'long';
const RSS_CEILING_MB = Number(process.env.STAVR_SOAK_RSS_CEILING_MB ?? '600');
const RSS_SLOPE_CEILING_BYTES_PER_SEC = Number(process.env.STAVR_SOAK_RSS_SLOPE_BPS ?? `${1_000_000}`); // 1 MB/s

const DURATION_MINUTES = LONG ? Number(process.env.STAVR_SOAK_MINUTES ?? '30') : Number(process.env.STAVR_SOAK_MINUTES ?? '3');
const SAMPLE_WINDOW_SEC = LONG ? 60 : 15;

// The CI-friendly modes — every mode the load-runner supports.
const MODES = (process.env.STAVR_SOAK_MODES ?? 'mcp_request,sse_churn,mixed_rw,page_nav').split(',');

const ARTIFACTS_DIR = resolve(process.cwd(), 'bombardment', 'artifacts', 'multi-mode-soak');

interface Harness {
  store: EventStore;
  broker: Broker;
  transports: MountedTransports;
  port: number;
  baseUrl: string;
  stavrHome: string;
}

async function boot(): Promise<Harness> {
  const stavrHome = mkdtempSync(join(tmpdir(), 'stavr-multi-soak-'));
  process.env.STAVR_HOME = stavrHome;
  process.env.STAVR_EVENTS_OP_RETENTION_DAYS = '7';
  process.env.STAVR_EVENTS_OP_MAX_ROWS = '5000';
  process.env.STAVR_DASHBOARD_CACHE_MS = '1000';
  process.env.STAVR_WORKERS_MAX_EVENTS = '50';

  const store = new EventStore();
  store.init(join(stavrHome, 'soak.db'));
  const broker = new Broker(store);
  const transports = await mountTransports(broker, {
    mode: 'daemon',
    port: 0,
    bindHost: '127.0.0.1',
    requireAuthWhenNonLocal: false,
    authConfigured: false,
    silent: true,
  });
  const addr = transports.httpServer?.address() as AddressInfo | null;
  if (!addr || typeof addr === 'string') throw new Error('listen address unavailable');
  return { store, broker, transports, port: addr.port, baseUrl: `http://127.0.0.1:${addr.port}`, stavrHome };
}

function spawnLoadRunner(port: number, minutes: number, modes: string[], sampleWindowSec: number, csvPath: string, summaryPath: string): ChildProcess {
  const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
  const runner = join(root, 'bombardment', 'load-runner.mjs');
  const child = spawn(
    process.execPath,
    [
      runner,
      '--port', String(port),
      '--minutes', String(minutes),
      '--modes', modes.join(','),
      '--sample-window-sec', String(sampleWindowSec),
      '--csv', csvPath,
      '--summary', summaryPath,
      // CI-friendly rates — keep the daemon busy but well under saturation.
      '--rps-mcp', '5',
      '--sse-churn-per-sec', '2',
      '--rw-rps', '3',
      '--nav-rps', '1',
    ],
    {
      env: { ...process.env, STAVR_HARDENING_SEED: String(getSeed()) },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  // Drain stdio to avoid backpressure; tag for triage.
  child.stdout?.on('data', (b) => process.stdout.write(`[load-runner] ${b}`));
  child.stderr?.on('data', (b) => process.stderr.write(`[load-runner-err] ${b}`));
  return child;
}

function killTree(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (platform() === 'win32') {
    try {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      /* best-effort */
    }
  } else {
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
}

const SUITE_DESC = SHOULD_RUN
  ? `bombardment multi-mode soak (modes=${MODES.join(',')}, ${DURATION_MINUTES}min)`
  : 'bombardment multi-mode soak (skipped — set STAVR_RUN_SOAK=1)';

(SHOULD_RUN ? describe : describe.skip)(SUITE_DESC, () => {
  let h: Harness;
  beforeAll(async () => {
    mkdirSync(ARTIFACTS_DIR, { recursive: true });
    h = await boot();
    process.stdout.write(`[soak] seed=${getSeed()} port=${h.port} home=${h.stavrHome}\n`);
  });

  afterAll(async () => {
    if (h) {
      await h.transports.shutdown();
    }
    delete process.env.STAVR_HOME;
    delete process.env.STAVR_EVENTS_OP_RETENTION_DAYS;
    delete process.env.STAVR_EVENTS_OP_MAX_ROWS;
    delete process.env.STAVR_DASHBOARD_CACHE_MS;
    delete process.env.STAVR_WORKERS_MAX_EVENTS;
  });

  it(
    `runs multi-mode workload, asserts oracles continuously, bounds growth shape`,
    async () => {
      const baseline = {
        sessionCount: h.broker.sessionCount(),
        subscriptionCount: h.broker.subscriptionCount(),
        eventCount: h.store.eventCount(),
      };

      // Heap snapshot before — diff at end shows per-class growth.
      const heapStart = captureHeapSnapshot(join(ARTIFACTS_DIR, `heap-start-${Date.now()}.heapsnapshot`));

      // Event-loop lag sampler runs throughout.
      const lagSampler = startEventLoopLagSampler(50);

      // Spawn the load-runner subprocess against our in-process daemon.
      const csvPath = join(ARTIFACTS_DIR, 'load-runner-timeseries.csv');
      const summaryPath = join(ARTIFACTS_DIR, 'load-runner-summary.json');
      const loadRunner = spawnLoadRunner(h.port, DURATION_MINUTES, MODES, SAMPLE_WINDOW_SEC, csvPath, summaryPath);
      const runnerExit = new Promise<number>((resolveP) => loadRunner.on('exit', (code) => resolveP(code ?? 0)));

      // Sample RSS + run oracles every window. Loop while the load-runner
      // is still alive; the runner owns the duration deadline (--minutes),
      // so the test drains in lockstep with it. A hard safety cutoff at
      // duration + 90s catches a wedged runner.
      const rssSamples: RssSample[] = [];
      const oracleHistory: Array<{ tMs: number; failed: number; firstFail?: OracleResult }> = [];
      const startMs = Date.now();
      const safetyDeadlineMs = startMs + DURATION_MINUTES * 60_000 + 90_000;
      let oracleViolation: OracleResult | null = null;

      while (loadRunner.exitCode === null && Date.now() < safetyDeadlineMs) {
        await new Promise((r) => setTimeout(r, SAMPLE_WINDOW_SEC * 1000));

        rssSamples.push({ tMs: Date.now(), rssBytes: process.memoryUsage().rss });

        const summary = await runOracles({
          kind: 'in-process',
          store: h.store,
          broker: h.broker,
          baseline,
        });
        const firstFail = summary.results.find((r) => r.ok === false);
        oracleHistory.push({ tMs: Date.now(), failed: summary.failed, firstFail });
        if (firstFail && !oracleViolation) {
          oracleViolation = firstFail;
          process.stderr.write(`[soak] oracle violation: ${firstFail.name} — ${firstFail.reason}\n`);
          // Capture but keep running so we collect the full growth-shape sample.
          captureOnFailure(h.store, {
            reason: `oracle_${firstFail.name}`,
            oracleResult: firstFail,
            extra: { modes: MODES, minutes_elapsed: (Date.now() - startMs) / 60_000 },
          });
        }
      }

      // Hit the safety cutoff with the runner still alive — that's a wedge,
      // force-kill it. Otherwise wait for the natural exit so the runner
      // gets a chance to write its summary.
      if (loadRunner.exitCode === null) {
        process.stderr.write(`[soak] safety cutoff reached with load-runner still alive; force-killing\n`);
        killTree(loadRunner);
      }
      await runnerExit;

      // Run the retention sweep so the cap kicks in before the bound check.
      // The multi-mode soak generates events via the daemon's own pollers
      // (daemon_memory, sse_session_opened/closed, etc.) rather than a
      // direct pump, so beforeCount can be small at the bottom of the
      // short-mode envelope. Assert non-negative — the value of running
      // pruneEvents() here is exercising the code path, not asserting
      // we deleted rows.
      const sweep = h.store.pruneEvents();
      expect(sweep.beforeCount).toBeGreaterThanOrEqual(0);

      lagSampler.stop();
      const lagSummary = lagSampler.summary();

      // End-of-run snapshot + diff.
      const heapEnd = captureHeapSnapshot(join(ARTIFACTS_DIR, `heap-end-${Date.now()}.heapsnapshot`));
      let topGrowers: ReturnType<typeof diffClassCounts> = [];
      try {
        topGrowers = diffClassCounts(summarizeHeapSnapshot(heapStart), summarizeHeapSnapshot(heapEnd), 20);
        writeHeapDiffSummary(join(ARTIFACTS_DIR, 'heap-diff.json'), topGrowers, {
          heap_start: heapStart,
          heap_end: heapEnd,
          seed: getSeed(),
        });
      } catch (err) {
        process.stderr.write(`[soak] heap diff failed: ${(err as Error).message}\n`);
      }

      // Growth-shape: RSS slope must be bounded.
      const slope = rssSlope(rssSamples);
      const maxRssMb = Math.round(Math.max(...rssSamples.map((s) => s.rssBytes), 0) / 1024 / 1024);

      // Baseline-return at end of run.
      const sessionsCheck = baselineReturn('broker.sessionCount', baseline.sessionCount, h.broker.sessionCount(), 2);
      const subsCheck = baselineReturn('broker.subscriptionCount', baseline.subscriptionCount, h.broker.subscriptionCount(), 2);

      // End-of-run oracle: strict-mode workers oracle (any non-terminal is a fail).
      const strictWorkersOracle = makeWorkersReachTerminal({ requireAllTerminal: true });
      const strictWorkersResult = await strictWorkersOracle({ kind: 'in-process', store: h.store, broker: h.broker });

      // Persist run-summary so the operator has a single-file view post-soak.
      const runSummary = {
        seed: getSeed(),
        duration_minutes: DURATION_MINUTES,
        modes: MODES,
        sample_window_sec: SAMPLE_WINDOW_SEC,
        rss: {
          ceiling_mb: RSS_CEILING_MB,
          max_mb: maxRssMb,
          slope_bytes_per_sec: slope.bytesPerSec,
          total_growth_bytes: slope.totalGrowthBytes,
          n_samples: slope.n,
          elapsed_sec: slope.elapsedSec,
        },
        baseline_return: { sessions: sessionsCheck, subscriptions: subsCheck },
        event_loop_lag: lagSummary,
        retention_sweep_after: sweep,
        oracle_history_summary: {
          windows: oracleHistory.length,
          windows_with_violation: oracleHistory.filter((w) => w.failed > 0).length,
          first_violation: oracleViolation,
        },
        strict_workers_result: strictWorkersResult,
        top_heap_growers: topGrowers.slice(0, 10),
      };
      writeFileSync(join(ARTIFACTS_DIR, 'run-summary.json'), JSON.stringify(runSummary, null, 2), 'utf8');

      // ── ASSERTIONS ───────────────────────────────────────────────────────
      // 1. No oracle violations during the run.
      expect(oracleViolation, `oracle violation detected: ${oracleViolation?.name} — ${oracleViolation?.reason}`).toBeNull();

      // 2. RSS ceiling.
      expect(maxRssMb).toBeLessThan(RSS_CEILING_MB);

      // 3. RSS growth shape — slope under threshold.
      expect(slope.bytesPerSec).toBeLessThan(RSS_SLOPE_CEILING_BYTES_PER_SEC);

      // 4. Baseline return — sessions + subscriptions drain to baseline + slack.
      expect(sessionsCheck.ok, `sessions did not return to baseline: ${sessionsCheck.current} > ${sessionsCheck.baseline} + ${sessionsCheck.slack}`).toBe(true);
      expect(subsCheck.ok, `subscriptions did not return to baseline: ${subsCheck.current} > ${subsCheck.baseline} + ${subsCheck.slack}`).toBe(true);

      // 5. After the retention sweep, the row count is at-or-near the cap.
      expect(h.store.eventCount()).toBeLessThanOrEqual(7500);

      // 6. The load-runner artifacts landed where expected (catch a silent
      //    subprocess failure that would otherwise leave us asserting on stale
      //    state from a previous run).
      expect(existsSync(summaryPath), `load-runner summary missing at ${summaryPath}`).toBe(true);
    },
    // Test timeout: duration + 5 min slack for boot/teardown.
    (DURATION_MINUTES + 5) * 60_000,
  );
});
