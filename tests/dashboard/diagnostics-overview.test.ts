/**
 * v0.6.12 Phase 2 — Diagnostics 5-tile overview tests.
 *
 * Verifies the new /dashboard/diagnostics landing renders 5 tiles
 * (Engine / Connections / Workers / Federation / Alerts), each with
 * a drill route declared inline. The no-orphan-components rule says
 * every tile MUST have a non-empty drill href.
 */
import { describe, expect, it } from 'vitest';
import { renderDiagnosticsOverview } from '../../src/dashboard/pages/diagnostics-overview.js';
import { renderDiagnosticsDetailStub } from '../../src/dashboard/pages/diagnostics-details.js';

describe('Diagnostics overview — 5 tiles, no orphans', () => {
  it('renders all 5 canonical tiles with drill hrefs', () => {
    const html = renderDiagnosticsOverview();
    for (const id of ['engine', 'connections', 'workers', 'federation', 'alerts']) {
      expect(html).toContain(`data-tile="${id}"`);
      expect(html).toContain(`href="/dashboard/diagnostics/${id}"`);
    }
  });

  it('Engine tile reads daemon version from the build snapshot', () => {
    const html = renderDiagnosticsOverview({
      versions: {
        daemonVersion: '0.6.12',
        daemonGitSha: 'abc1234',
        daemonUptimeSeconds: 100,
        nodeVersion: 'v20.0.0',
        stewardStatus: 'up',
        stewardModelRuntime: 'opus-4.7',
        governorVersion: null,
        governorStatus: 'unknown',
        mcpSdkVersion: '1.0.0',
        buildTimestamp: null,
        buildRunNumber: null,
        copyString: 'v0.6.12 abc1234',
      },
    });
    expect(html).toContain('v0.6.12');
    expect(html).toContain('node v20.0.0');
  });

  it('Connections tile shows "empty" status when no MCPs registered', () => {
    const html = renderDiagnosticsOverview({ bricks: [] });
    expect(html).toMatch(/data-tile="connections"[\s\S]*data-status="idle"/);
    expect(html).toContain('No MCP servers registered yet');
  });

  it('Federation tile shows standalone when peerCount is 0', () => {
    const html = renderDiagnosticsOverview({ peerCount: 0 });
    expect(html).toContain('standalone');
    expect(html).toContain('peers.yaml');
  });

  it('Federation tile shows federated when peerCount > 0', () => {
    const html = renderDiagnosticsOverview({ peerCount: 2 });
    expect(html).toContain('2 peers');
    expect(html).toContain('federated');
  });

  it('Alerts tile shows "all clear" when active=0', () => {
    const html = renderDiagnosticsOverview({ alerts: { active: 0, history_24h: 0 } });
    expect(html).toContain('all clear');
  });

  it('Alerts tile escalates to crit when latest severity is crit', () => {
    const html = renderDiagnosticsOverview({
      alerts: { active: 1, history_24h: 4, latest: { severity: 'crit', message: 'mDNS port lost', at: new Date().toISOString() } },
    });
    expect(html).toMatch(/data-tile="alerts"[\s\S]*data-status="crit"/);
  });

  it('NO-ORPHAN: every tile has a non-empty diag-tile-drill block', () => {
    const html = renderDiagnosticsOverview();
    // Count tiles and drill blocks — must match.
    const tileCount = (html.match(/data-tile="[a-z]+"/g) ?? []).length;
    const drillCount = (html.match(/class="diag-tile-drill"/g) ?? []).length;
    expect(tileCount).toBe(5);
    expect(drillCount).toBe(5);
  });
});

describe('Diagnostics drill detail pages — every route renders real content', () => {
  for (const id of ['connections', 'workers', 'federation', 'alerts'] as const) {
    it(`${id} renders with breadcrumb back to overview`, () => {
      const html = renderDiagnosticsDetailStub(id);
      expect(html).toContain('href="/dashboard/diagnostics"');
      expect(html).toContain(`Diagnostics · ${id}`);
      // Each detail page has a summary tile grid + a roster table.
      expect(html).toContain('diag-summary-tile');
    });
  }
});
