#!/usr/bin/env node
// v0.6.11 Phase 0 — Plans-page freeze probe.
//
// Lightweight perf measurement against a running daemon. No headless-browser
// dep: measures server-side render latency, response payload size, and SSE
// event arrival rate. Use in tandem with Chrome DevTools "Performance" panel
// for the main-thread blocking trace (record-and-export to
// tmp/perf/plans-freeze-trace.json — manual step, browser-driven).
//
// Usage:
//   node tmp/perf/freeze-probe.mjs --port 7779 --iterations 20 --pages plans,helm,topology
//
// Output: tmp/perf/freeze-probe-summary.json

import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, arr) => {
    if (a.startsWith('--')) return [[a.slice(2), arr[i + 1] ?? 'true']];
    return [];
  }),
);

const port = Number.parseInt(args.port ?? '7779', 10);
const base = `http://127.0.0.1:${port}`;
const iterations = Number.parseInt(args.iterations ?? '20', 10);
const pages = (args.pages ?? 'helm,plans,topology,decide,diagnostics,streams').split(',');
const sseSeconds = Number.parseInt(args['sse-seconds'] ?? '30', 10);

async function timeFetch(url) {
  const t0 = performance.now();
  const r = await fetch(url);
  const ttfb = performance.now() - t0;
  const body = await r.text();
  const total = performance.now() - t0;
  return {
    status: r.status,
    ttfb_ms: Math.round(ttfb * 100) / 100,
    total_ms: Math.round(total * 100) / 100,
    bytes: body.length,
  };
}

function summarize(samples) {
  if (samples.length === 0) return null;
  const ts = samples.map((s) => s.total_ms).sort((a, b) => a - b);
  const bs = samples.map((s) => s.bytes);
  const pct = (p) => ts[Math.min(ts.length - 1, Math.floor((ts.length * p) / 100))];
  return {
    n: samples.length,
    bytes: { min: Math.min(...bs), max: Math.max(...bs), avg: Math.round(bs.reduce((a, b) => a + b, 0) / bs.length) },
    total_ms: { min: ts[0], p50: pct(50), p95: pct(95), p99: pct(99), max: ts[ts.length - 1] },
  };
}

const result = { config: { port, base, iterations, pages, sse_seconds: sseSeconds }, pages: {}, sse: null };

for (const page of pages) {
  const samples = [];
  for (let i = 0; i < iterations; i++) {
    try {
      samples.push(await timeFetch(`${base}/dashboard/${page}`));
    } catch (e) {
      samples.push({ status: 0, total_ms: -1, bytes: 0, error: String(e) });
    }
    await sleep(50);
  }
  result.pages[page] = summarize(samples);
  process.stdout.write(`[${page}] ${JSON.stringify(result.pages[page])}\n`);
}

// SSE event rate sample: open one tail, count events for N seconds.
const events = { byKind: {}, total: 0, durationMs: 0 };
const t0 = performance.now();
try {
  const ctrl = new AbortController();
  const r = await fetch(`${base}/dashboard/stream`, { signal: ctrl.signal });
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const endAt = Date.now() + sseSeconds * 1000;
  while (Date.now() < endAt) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const ev = chunk.match(/event:\s*(\S+)/)?.[1];
      if (ev) {
        events.byKind[ev] = (events.byKind[ev] ?? 0) + 1;
        events.total++;
      }
    }
  }
  ctrl.abort();
} catch (e) {
  events.error = String(e);
}
events.durationMs = Math.round(performance.now() - t0);
events.eventsPerSec = events.total / Math.max(1, events.durationMs / 1000);
result.sse = events;
process.stdout.write(`[sse] ${JSON.stringify(events)}\n`);

const out = 'tmp/perf/freeze-probe-summary.json';
writeFileSync(out, JSON.stringify(result, null, 2));
process.stdout.write(`\nwrote ${out}\n`);
