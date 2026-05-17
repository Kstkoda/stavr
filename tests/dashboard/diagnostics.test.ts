import { describe, expect, it } from 'vitest';
import { renderDiagnosticsPage, type DiagnosticsData } from '../../src/dashboard/pages/diagnostics.js';
import type { WorkerRecord } from '../../src/persistence.js';
import type { InstalledBrickLite } from '../../src/dashboard/adapters/topology.js';

function brick(over: Partial<InstalledBrickLite> = {}): InstalledBrickLite {
  return {
    id: over.id ?? 'github',
    display_name: over.display_name ?? 'GitHub',
    kind: over.kind ?? 'mcp-remote',
    enabled: over.enabled ?? true,
  };
}

function worker(over: Partial<WorkerRecord> = {}): WorkerRecord {
  return {
    id: over.id ?? 'wkr_1',
    name: over.name ?? 'wkr_1',
    type: over.type ?? 'cc',
    status: over.status ?? 'idle',
    cwd: over.cwd ?? 'C:\\dev\\x',
    pid: over.pid,
    started_at: over.started_at ?? new Date().toISOString(),
    last_activity_at: over.last_activity_at ?? new Date().toISOString(),
    ended_at: over.ended_at,
    metadata: over.metadata ?? {},
  };
}

// Storm Pass #2 — Cluster 0 (Operator Trust). The Diagnostics page must NOT
// render synthetic trending polylines when there is no underlying data.
describe('Diagnostics page — operator-trust empty states (F65)', () => {
  it('MCP trend renders the explicit empty-state when no bricks are registered', () => {
    const html = renderDiagnosticsPage({ bricks: [], workers: [] });
    expect(html).toContain('No data — register an MCP to see traffic.');
    expect(html).toContain('data-role="mcp-trend"');
    expect(html).toContain('data-role="mcp-trend-empty"');
  });

  it('Workers trend renders the explicit empty-state when no workers are active', () => {
    const html = renderDiagnosticsPage({ bricks: [], workers: [] });
    expect(html).toContain('No active workers — spawn a job to see throughput.');
    expect(html).toContain('data-role="worker-trend"');
    expect(html).toContain('data-role="worker-trend-empty"');
  });

  it('Workers trend hides the empty-state once a running worker exists', () => {
    const html = renderDiagnosticsPage({
      bricks: [],
      workers: [worker({ status: 'running' })],
    });
    expect(html).not.toContain('No active workers — spawn a job to see throughput.');
    // The polyline placeholder reappears once data could exist.
    expect(html).toContain('data-series="0"');
  });

  it('MCP trend renders polyline placeholder (not empty-state) when ≥ 1 brick is registered', () => {
    const html = renderDiagnosticsPage({ bricks: [brick()], workers: [] });
    expect(html).not.toContain('No data — register an MCP to see traffic.');
    expect(html).toContain('data-role="mcp-trend"');
    // Polyline placeholder has data-series so the page JS can swap coords later.
    expect(html).toMatch(/data-role="mcp-trend"[\s\S]*data-series="0"/);
  });

  it('No synthetic ascending trend coords leak into the SSR HTML', () => {
    const html = renderDiagnosticsPage({ bricks: [], workers: [] });
    // The previous mockup-style polylines included these monotonic
    // ascending coordinate fragments. Catch any future regression.
    expect(html).not.toMatch(/0,70 30,68 60,72/);
    expect(html).not.toMatch(/0,60 30,58 60,62/);
    expect(html).not.toMatch(/0,100 30,95 60,98/);
    expect(html).not.toMatch(/0,80 30,82 60,78/);
    expect(html).not.toMatch(/0,80 30,75 60,70/);
  });
});
