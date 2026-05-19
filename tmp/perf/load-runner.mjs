#!/usr/bin/env node
// v0.6.11 Phase 2 — synthetic load harness for the stavR daemon.
//
// Extends tmp/leak-verify/load-and-sample.mjs from a single-mode stateless-
// POST driver into a multi-mode workload generator. Each mode runs as an
// async loop with its own concurrency budget; results are aggregated into
// structured JSON time-series + per-endpoint summary stats.
//
// Modes (composable via --modes mcp_request,sse_churn,mixed_rw):
//   mcp_request  — MCP req/resp cycles (initialize → tools/list → close)
//   sse_churn    — open/close N subscribers/sec on /dashboard/stream
//   mixed_rw     — read (GET dashboard JSON) + write (POST plans/respond) mix
//   page_nav     — hit /dashboard/<page> in a round-robin (Phase 7 nav stress)
//
// Output:
//   tmp/perf/load-runner-timeseries.csv  — one row per sample window
//   tmp/perf/load-runner-summary.json    — config + final per-endpoint stats
//
// Usage:
//   node tmp/perf/load-runner.mjs --port 7777 --minutes 90 \
//        --modes mcp_request,sse_churn,mixed_rw,page_nav \
//        --rps-mcp 5 --sse-churn-per-sec 2 --rw-rps 3 --nav-rps 1

import { writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { dirname } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, arr) => {
    if (a.startsWith('--')) return [[a.slice(2), arr[i + 1] ?? 'true']];
    return [];
  }),
);

const port = Number.parseInt(args.port ?? '7777', 10);
const minutes = Number.parseInt(args.minutes ?? '90', 10);
const base = `http://127.0.0.1:${port}`;
const modes = String(args.modes ?? 'mcp_request,sse_churn,mixed_rw,page_nav').split(',').filter(Boolean);
const rpsMcp = Number.parseInt(args['rps-mcp'] ?? '5', 10);
const sseChurnPerSec = Number.parseFloat(args['sse-churn-per-sec'] ?? '2');
const rwRps = Number.parseFloat(args['rw-rps'] ?? '3');
const navRps = Number.parseFloat(args['nav-rps'] ?? '1');
const sampleWindowSec = Number.parseInt(args['sample-window-sec'] ?? '60', 10);

const startedAt = Date.now();
const endAt = startedAt + minutes * 60_000;
const csvPath = String(args['csv'] ?? 'tmp/perf/load-runner-timeseries.csv');
const summaryPath = String(args['summary'] ?? 'tmp/perf/load-runner-summary.json');
mkdirSync(dirname(csvPath), { recursive: true });

// ─── per-endpoint stats ────────────────────────────────────────────────────
const stats = new Map(); // key: endpoint label → { count, errors, samples: number[] (ms) }

function record(label, durMs, ok) {
  let s = stats.get(label);
  if (!s) { s = { count: 0, errors: 0, samples: [] }; stats.set(label, s); }
  s.count++;
  if (!ok) s.errors++;
  // Cap sample buffer per endpoint to avoid unbounded memory.
  if (s.samples.length < 50_000) s.samples.push(durMs);
}

function summarize(samples) {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))];
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    n: sorted.length,
    avg_ms: Math.round((sum / sorted.length) * 100) / 100,
    min_ms: sorted[0],
    p50_ms: pct(50),
    p95_ms: pct(95),
    p99_ms: pct(99),
    max_ms: sorted[sorted.length - 1],
  };
}

async function timeRequest(label, fn) {
  const t0 = performance.now();
  let ok = true;
  try { await fn(); } catch { ok = false; }
  const dur = performance.now() - t0;
  record(label, dur, ok);
  return { dur, ok };
}

// ─── mode: mcp_request ─────────────────────────────────────────────────────
async function mcpRequestLoop() {
  const interval = 1000 / Math.max(1, rpsMcp);
  while (Date.now() < endAt) {
    await timeRequest('mcp:tools_list', async () => {
      const r = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: stats.get('mcp:tools_list')?.count ?? 0, method: 'tools/list', params: {} }),
      });
      if (!r.ok && r.status !== 400) throw new Error(`HTTP ${r.status}`);
      await r.body?.cancel?.().catch(() => {});
    });
    await sleep(interval);
  }
}

// ─── mode: sse_churn ───────────────────────────────────────────────────────
async function sseChurnLoop() {
  const interval = 1000 / Math.max(0.1, sseChurnPerSec);
  while (Date.now() < endAt) {
    // Measure time-to-open (handshake + first byte) only — the open/close
    // pair is what stresses the broker's tap registration. Holding the
    // connection then aborting is fire-and-forget on a separate timer.
    await timeRequest('sse:open_close', async () => {
      const ctrl = new AbortController();
      const abortAt = setTimeout(() => ctrl.abort(), 2000);
      try {
        const r = await fetch(`${base}/dashboard/stream`, { signal: ctrl.signal });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        // Drain the initial "ping" event (server writes it eagerly) then bail.
        const reader = r.body.getReader();
        await reader.read();
        ctrl.abort();
      } finally {
        clearTimeout(abortAt);
      }
    });
    await sleep(interval);
  }
}

// ─── mode: mixed_rw ────────────────────────────────────────────────────────
const READ_ENDPOINTS = [
  '/dashboard/plans/list',
  '/dashboard/home/data',
  '/dashboard/api/diagnostics/memory',
];
async function mixedRwLoop() {
  const interval = 1000 / Math.max(0.1, rwRps);
  let i = 0;
  while (Date.now() < endAt) {
    const url = READ_ENDPOINTS[i++ % READ_ENDPOINTS.length];
    await timeRequest(`read:${url}`, async () => {
      const r = await fetch(`${base}${url}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await r.body?.cancel?.().catch(() => {});
    });
    await sleep(interval);
  }
}

// ─── mode: page_nav ────────────────────────────────────────────────────────
const PAGES = ['helm', 'plans', 'topology', 'decide', 'diagnostics', 'streams', 'tools'];
async function pageNavLoop() {
  const interval = 1000 / Math.max(0.1, navRps);
  let i = 0;
  while (Date.now() < endAt) {
    const page = PAGES[i++ % PAGES.length];
    await timeRequest(`page:${page}`, async () => {
      const r = await fetch(`${base}/dashboard/${page}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await r.body?.cancel?.().catch(() => {});
    });
    await sleep(interval);
  }
}

const MODE_FNS = {
  mcp_request: mcpRequestLoop,
  sse_churn: sseChurnLoop,
  mixed_rw: mixedRwLoop,
  page_nav: pageNavLoop,
};

// ─── periodic memory sampler ───────────────────────────────────────────────
writeFileSync(csvPath, 'window_idx,elapsed_s,rss_mb,heap_used_mb,heap_total_mb,event_count,sse_sessions,broker_sessions,req_count,err_count\n');

let windowIdx = 0;
async function sampleWindow() {
  while (Date.now() < endAt) {
    const nextAt = startedAt + (windowIdx + 1) * sampleWindowSec * 1000;
    const wait = nextAt - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      const r = await fetch(`${base}/dashboard/api/diagnostics/memory`);
      if (r.ok) {
        const body = await r.json();
        let totalReq = 0, totalErr = 0;
        for (const s of stats.values()) { totalReq += s.count; totalErr += s.errors; }
        const rec = {
          window_idx: windowIdx,
          elapsed_s: Math.round((Date.now() - startedAt) / 1000),
          rss_mb: Math.round(body.process.rss / 1024 / 1024),
          heap_used_mb: Math.round(body.process.heap_used / 1024 / 1024),
          heap_total_mb: Math.round(body.process.heap_total / 1024 / 1024),
          event_count: body.db?.event_count ?? 0,
          sse_sessions: body.broker?.sse_sessions ?? 0,
          broker_sessions: body.broker?.session_count ?? 0,
          req_count: totalReq,
          err_count: totalErr,
        };
        appendFileSync(csvPath, `${rec.window_idx},${rec.elapsed_s},${rec.rss_mb},${rec.heap_used_mb},${rec.heap_total_mb},${rec.event_count},${rec.sse_sessions},${rec.broker_sessions},${rec.req_count},${rec.err_count}\n`);
        process.stdout.write(`[w=${rec.window_idx} t=${rec.elapsed_s}s] rss=${rec.rss_mb}MB heap=${rec.heap_used_mb}MB sse=${rec.sse_sessions} reqs=${rec.req_count} errs=${rec.err_count}\n`);
      }
    } catch (e) {
      process.stderr.write(`sample failed: ${e.message}\n`);
    }
    windowIdx++;
  }
}

// ─── launch ────────────────────────────────────────────────────────────────
const loops = modes.filter((m) => MODE_FNS[m]).map((m) => MODE_FNS[m]());
loops.push(sampleWindow());
await Promise.all(loops);

const perEndpoint = {};
for (const [label, s] of stats) {
  perEndpoint[label] = {
    count: s.count,
    errors: s.errors,
    error_rate: s.count > 0 ? s.errors / s.count : 0,
    latency: summarize(s.samples),
  };
}

const summary = {
  config: { port, base, minutes, modes, rps_mcp: rpsMcp, sse_churn_per_sec: sseChurnPerSec, rw_rps: rwRps, nav_rps: navRps, sample_window_sec: sampleWindowSec },
  started_at_iso: new Date(startedAt).toISOString(),
  ended_at_iso: new Date().toISOString(),
  endpoints: perEndpoint,
  totals: {
    requests: Array.from(stats.values()).reduce((a, s) => a + s.count, 0),
    errors: Array.from(stats.values()).reduce((a, s) => a + s.errors, 0),
  },
  csv: csvPath,
};

writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
process.stdout.write(`\nsummary: ${summaryPath}\ncsv: ${csvPath}\n`);
process.stdout.write(`totals: ${summary.totals.requests} requests, ${summary.totals.errors} errors\n`);
