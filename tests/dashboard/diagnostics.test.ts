import { describe, expect, it } from 'vitest';
import { renderDiagnosticsPage, type DiagnosticsData } from '../../src/dashboard/pages/diagnostics.js';
import type { JobRecord } from '../../src/jobs/types.js';
import type { InstalledBrickLite } from '../../src/dashboard/adapters/topology.js';

function brick(over: Partial<InstalledBrickLite> = {}): InstalledBrickLite {
  return {
    id: over.id ?? 'github',
    display_name: over.display_name ?? 'GitHub',
    kind: over.kind ?? 'mcp-remote',
    enabled: over.enabled ?? true,
  };
}

function job(over: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'job_1',
    name: 'job_1',
    binding_kind: 'process-spawn',
    binding_target: 'generic',
    params_hash: 'h',
    lifecycle_state: 'running',
    started_at: new Date().toISOString(),
    last_activity_at: new Date().toISOString(),
    metadata: {},
    ...over,
  };
}

// Storm Pass #2 — Cluster 0 (Operator Trust). The Diagnostics page must NOT
// render synthetic trending polylines when there is no underlying data.
describe('Diagnostics page — operator-trust empty states (F65)', () => {
  it('MCP trend renders the explicit empty-state when no bricks are registered', () => {
    const html = renderDiagnosticsPage({ bricks: [], jobs: [] });
    expect(html).toContain('No data — register an MCP to see traffic.');
    expect(html).toContain('data-role="mcp-trend"');
    expect(html).toContain('data-role="mcp-trend-empty"');
  });

  it('Jobs trend renders the explicit empty-state when no jobs are active', () => {
    const html = renderDiagnosticsPage({ bricks: [], jobs: [] });
    expect(html).toContain('No active jobs — dispatch a job to see throughput.');
    expect(html).toContain('data-role="job-trend"');
    expect(html).toContain('data-role="job-trend-empty"');
  });

  it('Jobs trend hides the empty-state once a running job exists', () => {
    const html = renderDiagnosticsPage({
      bricks: [],
      jobs: [job({ lifecycle_state: 'running' })],
    });
    expect(html).not.toContain('No active jobs — dispatch a job to see throughput.');
    // The polyline placeholder reappears once data could exist.
    expect(html).toContain('data-series="0"');
  });

  it('MCP trend renders polyline placeholder (not empty-state) when ≥ 1 brick is registered', () => {
    const html = renderDiagnosticsPage({ bricks: [brick()], jobs: [] });
    expect(html).not.toContain('No data — register an MCP to see traffic.');
    expect(html).toContain('data-role="mcp-trend"');
    // Polyline placeholder has data-series so the page JS can swap coords later.
    expect(html).toMatch(/data-role="mcp-trend"[\s\S]*data-series="0"/);
  });

  // F69 — window selector. Clicking 5m/1h/24h/7d must trigger a real
  // fetch against /dashboard/api/traffic-summary with the range param,
  // persist the selection in localStorage, and re-render polylines.
  it('window selector page JS calls /dashboard/api/traffic-summary with the range param', () => {
    const html = renderDiagnosticsPage({ bricks: [], jobs: [] });
    expect(html).toContain('/dashboard/api/traffic-summary?range=');
    expect(html).toContain("encodeURIComponent(w)");
  });

  it('window selector page JS persists the selection in localStorage under stavr.diagWindow', () => {
    const html = renderDiagnosticsPage({ bricks: [], jobs: [] });
    expect(html).toContain("localStorage.setItem('stavr.diagWindow'");
    expect(html).toContain("localStorage.getItem('stavr.diagWindow')");
  });

  it('window selector defaults to 5m on the server-rendered chips', () => {
    const html = renderDiagnosticsPage({ bricks: [], jobs: [] });
    expect(html).toMatch(/data-window="5m"\s+aria-pressed="true"/);
    expect(html).toMatch(/data-window="1h">/);
    expect(html).toMatch(/data-window="24h">/);
    expect(html).toMatch(/data-window="7d">/);
  });

  // F68 — page-JS bug fixes for the LIVE TRACE TAIL. The earlier code
  // (a) never cleared the "Waiting for events…" placeholder when the
  // first event arrived, and (b) read worker_id/duration_ms off the
  // top-level event object instead of payload, so every cell rendered "·".
  it('v0.6.11 — exposes Memory + Perf section deep-linkable as #perf', () => {
    const html = renderDiagnosticsPage();
    expect(html).toContain('id="perf"');
    expect(html).toContain('Memory + Perf');
    expect(html).toContain('data-role="mem-heap"');
    expect(html).toContain('data-role="mem-rss"');
    expect(html).toContain('data-role="perf-table"');
    expect(html).toContain('data-role="evt-bars"');
    expect(html).toContain('/dashboard/api/perf');
    expect(html).toContain('/dashboard/api/diagnostics/memory');
    // EXPLICIT-tier handoff: clipboard copy of the load harness command,
    // not a server-side trigger.
    expect(html).toContain('Copy load-runner command');
    expect(html).toContain('bombardment/load-runner.mjs');
  });

  it('LIVE TRACE TAIL JS reads worker_id + bom_id from event payload, not top level', () => {
    // worker_id stays in the live trace tail script even after the cutover —
    // dual-emit still publishes the worker_* shadow events during 3c.1, so
    // the live-trace SSE consumer sees both payload shapes. job_id matches
    // the new primary job_log slot.
    const html = renderDiagnosticsPage({ bricks: [], jobs: [] });
    expect(html).toContain('payload.worker_id');
    expect(html).toContain('payload.bom_id');
    expect(html).toContain('payload.duration_ms');
  });

  it('LIVE TRACE TAIL JS clears the Waiting-for-events placeholder when events arrive', () => {
    const html = renderDiagnosticsPage({ bricks: [], jobs: [] });
    expect(html).toContain('clearEmptyPlaceholder');
    expect(html).toContain('.tail-empty');
  });

  it('LIVE TRACE TAIL header includes a received-counter so operators can see the SSE pipe is alive', () => {
    const html = renderDiagnosticsPage({ bricks: [], jobs: [] });
    expect(html).toContain('data-role="tail-count"');
    expect(html).toContain('counter.textContent = String(received)');
  });

  it('No synthetic ascending trend coords leak into the SSR HTML', () => {
    const html = renderDiagnosticsPage({ bricks: [], jobs: [] });
    // The previous mockup-style polylines included these monotonic
    // ascending coordinate fragments. Catch any future regression.
    expect(html).not.toMatch(/0,70 30,68 60,72/);
    expect(html).not.toMatch(/0,60 30,58 60,62/);
    expect(html).not.toMatch(/0,100 30,95 60,98/);
    expect(html).not.toMatch(/0,80 30,82 60,78/);
    expect(html).not.toMatch(/0,80 30,75 60,70/);
  });
});
