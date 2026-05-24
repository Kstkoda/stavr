#!/usr/bin/env node
// Bombardment Phase 2 — synthetic load harness for the stavR daemon.
//
// Salvaged from tmp/perf/load-runner.mjs (Phase 7 / v0.6.11 plans-page
// freeze investigation). Multi-mode workload generator: each mode runs
// as an async loop with its own concurrency budget; results are
// aggregated into structured JSON time-series + per-endpoint summary stats.
//
// New in Phase 2:
//   - Seeded via STAVR_HARDENING_SEED (env). When unset, captures a
//     fresh time-based seed and prints it on startup so a one-off run
//     can be reproduced by re-exporting the seed.
//   - Modes use the seed for interval jitter + endpoint round-robin
//     offset, so the same seed produces the same request sequence.
//   - Lives under the rig's real home (bombardment/) instead of tmp/perf/.
//
// Modes (composable via --modes mcp_request,sse_churn,mixed_rw,page_nav):
//   mcp_request  — MCP req/resp cycles (initialize → tools/list → close)
//   sse_churn    — open/close N subscribers/sec on /dashboard/stream
//   mixed_rw     — read (GET dashboard JSON) + write (POST plans/respond) mix
//   page_nav     — hit /dashboard/<page> in a round-robin (Phase 7 nav stress)
//
// Output (defaults to bombardment/artifacts/load-runner/):
//   load-runner-timeseries.csv  — one row per sample window
//   load-runner-summary.json    — config + final per-endpoint stats
//
// Usage:
//   node bombardment/load-runner.mjs --port 7777 --minutes 90 \
//        --modes mcp_request,sse_churn,mixed_rw,page_nav \
//        --rps-mcp 5 --sse-churn-per-sec 2 --rw-rps 3 --nav-rps 1
//
//   STAVR_HARDENING_SEED=42 node bombardment/load-runner.mjs --port 7777 --minutes 1

import { writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { dirname, resolve } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, arr) => {
    if (a.startsWith('--')) return [[a.slice(2), arr[i + 1] ?? 'true']];
    return [];
  }),
);

// ─── seeded RNG ────────────────────────────────────────────────────────────
// Inline (no .ts import — this script is plain Node for zero-friction CLI).
function resolveSeed() {
  const env = process.env.STAVR_HARDENING_SEED;
  if (env !== undefined && env !== '') {
    const n = Number.parseInt(env, 10);
    if (Number.isFinite(n)) return n >>> 0;
  }
  return (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
}
function fnv1a(label) {
  let h = 0x811c9dc5;
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const SEED = resolveSeed();
function createRng(label) {
  return mulberry32((SEED ^ fnv1a(label)) >>> 0);
}

const port = Number.parseInt(args.port ?? '7777', 10);
const minutes = Number.parseFloat(args.minutes ?? '90');
const base = `http://127.0.0.1:${port}`;
const modes = String(args.modes ?? 'mcp_request,sse_churn,mixed_rw,page_nav').split(',').filter(Boolean);
const rpsMcp = Number.parseFloat(args['rps-mcp'] ?? '5');
const sseChurnPerSec = Number.parseFloat(args['sse-churn-per-sec'] ?? '2');
const rwRps = Number.parseFloat(args['rw-rps'] ?? '3');
const navRps = Number.parseFloat(args['nav-rps'] ?? '1');
const sampleWindowSec = Number.parseInt(args['sample-window-sec'] ?? '60', 10);

const startedAt = Date.now();
const endAt = startedAt + minutes * 60_000;
const artifactsDir = resolve(args['artifacts-dir'] ?? 'bombardment/artifacts/load-runner');
const csvPath = String(args['csv'] ?? `${artifactsDir}/load-runner-timeseries.csv`);
const summaryPath = String(args['summary'] ?? `${artifactsDir}/load-runner-summary.json`);
mkdirSync(dirname(csvPath), { recursive: true });

process.stdout.write(`[load-runner] seed=${SEED} modes=${modes.join(',')} minutes=${minutes} port=${port}\n`);
process.stdout.write(`[load-runner] csv=${csvPath} summary=${summaryPath}\n`);

// ─── per-endpoint stats ────────────────────────────────────────────────────
const stats = new Map(); // key: endpoint label → { count, errors, samples: number[] (ms) }

function record(label, durMs, ok) {
  let s = stats.get(label);
  if (!s) { s = { count: 0, errors: 0, samples: [] }; stats.set(label, s); }
  s.count++;
  if (!ok) s.errors++;
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

// ─── jitter helper ─────────────────────────────────────────────────────────
// Apply ±15% jitter from the seeded stream so two runs with the same seed
// produce the same arrival sequence; without the seed they're independent.
function jitter(rng, baseMs) {
  const factor = 0.85 + rng() * 0.3;
  return Math.max(1, baseMs * factor);
}

// ─── mode: mcp_request ─────────────────────────────────────────────────────
async function mcpRequestLoop() {
  const rng = createRng('mcp_request:interval');
  const base_interval = 1000 / Math.max(1, rpsMcp);
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
    await sleep(jitter(rng, base_interval));
  }
}

// ─── mode: sse_churn ───────────────────────────────────────────────────────
async function sseChurnLoop() {
  const rng = createRng('sse_churn:interval');
  const base_interval = 1000 / Math.max(0.1, sseChurnPerSec);
  while (Date.now() < endAt) {
    await timeRequest('sse:open_close', async () => {
      const ctrl = new AbortController();
      const abortAt = setTimeout(() => ctrl.abort(), 2000);
      try {
        const r = await fetch(`${base}/dashboard/stream`, { signal: ctrl.signal });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const reader = r.body.getReader();
        await reader.read();
        ctrl.abort();
      } finally {
        clearTimeout(abortAt);
      }
    });
    await sleep(jitter(rng, base_interval));
  }
}

// ─── mode: mixed_rw ────────────────────────────────────────────────────────
const READ_ENDPOINTS = [
  '/dashboard/plans/list',
  '/dashboard/home/data',
  '/dashboard/api/diagnostics/memory',
];
async function mixedRwLoop() {
  const rng = createRng('mixed_rw:interval');
  const pickRng = createRng('mixed_rw:pick');
  const base_interval = 1000 / Math.max(0.1, rwRps);
  while (Date.now() < endAt) {
    const url = READ_ENDPOINTS[Math.floor(pickRng() * READ_ENDPOINTS.length)];
    await timeRequest(`read:${url}`, async () => {
      const r = await fetch(`${base}${url}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await r.body?.cancel?.().catch(() => {});
    });
    await sleep(jitter(rng, base_interval));
  }
}

// ─── mode: page_nav ────────────────────────────────────────────────────────
const PAGES = ['helm', 'plans', 'topology', 'decide', 'diagnostics', 'streams', 'tools'];
async function pageNavLoop() {
  const rng = createRng('page_nav:interval');
  const pickRng = createRng('page_nav:pick');
  const base_interval = 1000 / Math.max(0.1, navRps);
  while (Date.now() < endAt) {
    const page = PAGES[Math.floor(pickRng() * PAGES.length)];
    await timeRequest(`page:${page}`, async () => {
      const r = await fetch(`${base}/dashboard/${page}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await r.body?.cancel?.().catch(() => {});
    });
    await sleep(jitter(rng, base_interval));
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
  seed: SEED,
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
