/**
 * v0.4 dashboard route wiring. Mounts /dashboard + per-page routes; the
 * caller still owns the /dashboard/* JSON APIs in transports.ts.
 *
 * /dashboard       → 302 /dashboard/helm (v0.4 primary, was /dashboard/home)
 * /dashboard/home  → legacy alias kept for v0.3 bookmarks + integration tests
 * /dashboard/helm, /topology, /streams, /plans, /decide, /toolkit,
 * /mcps, /capabilities, /settings → server-rendered shell + page body.
 *
 * Page snapshots are pull-based: pages that need data (Helm/Home, Plans,
 * Topology, …) declare a getter on the DashboardPageDeps bag so
 * transports.ts can wire them to the broker. Pages without a getter
 * fall back to their no-data placeholder render.
 */
import type express from 'express';
import { NAV_ENTRIES, LEGACY_NAV_ENTRIES, type DashboardPageId } from './shell.js';
import { renderHelmPage, type HelmData } from './pages/helm.js';
import { renderHomePage, type HomeData } from './pages/home.js';
import { renderTopologyPage, type TopologyData } from './pages/topology.js';
import { renderStreamsPage, type StreamsData } from './pages/streams.js';
import { renderHistoryPage, type HistoryData } from './pages/history.js';
import { renderPlansPage, type PlansData } from './pages/plans.js';
import { renderDecidePage, type DecideData } from './pages/decide.js';
import { renderToolkitPage, type ToolkitData } from './pages/toolkit.js';
import { renderMcpsPage, type McpsData } from './pages/mcps.js';
import { renderToolsPage } from './pages/tools.js';
import type { ToolsData } from './data/tools-data.js';
import { renderPermissionsPage } from './pages/permissions.js';
import type { PermissionsData } from './data/permissions-data.js';
import { renderCapabilitiesPage, type CapabilitiesData } from './pages/capabilities.js';
import { renderDiagnosticsPage, type DiagnosticsData } from './pages/diagnostics.js';
import { renderDiagnosticsOverview } from './pages/diagnostics-overview.js';
import {
  renderConnectionsDetail,
  renderWorkersDetail,
  renderFederationDetail,
  renderAlertsDetail,
} from './pages/diagnostics-details.js';
import { renderSettingsPage, type SettingsData } from './pages/settings.js';
import { renderFamilyModePage, type FamilyModeData } from './pages/family-mode.js';
import { renderAboutPage } from './pages/about.js';

export interface DashboardPageDeps {
  /** Snapshot used for Helm server-side initial paint (v0.4 primary). */
  helmData?: () => HelmData;
  /** Snapshot used for Home server-side initial paint (v0.3 legacy alias). */
  homeData?: () => HomeData;
  /** Snapshot used for Plans server-side initial paint (C3). */
  plansData?: () => PlansData;
  /** Snapshot used for Decide server-side initial paint (C4). */
  decideData?: () => DecideData;
  /** Snapshot used for Topology server-side initial paint (C5). */
  topologyData?: () => TopologyData;
  /** Snapshot used for Streams server-side initial paint (C6). */
  streamsData?: () => StreamsData;
  /** Snapshot used for History server-side initial paint (v0.8). */
  historyData?: () => HistoryData;
  /** Snapshot used for Toolkit server-side initial paint (C7). */
  toolkitData?: () => ToolkitData;
  /** Snapshot used for MCPs server-side initial paint (v0.4). */
  mcpsData?: () => McpsData;
  /** Snapshot used for Tools server-side initial paint (v0.6.9 PR #1). */
  toolsData?: () => ToolsData;
  /** Snapshot used for Permissions server-side initial paint (v0.6.9 PR #2). */
  permissionsData?: () => PermissionsData;
  /** Snapshot used for Capabilities server-side initial paint (C8). */
  capabilitiesData?: () => CapabilitiesData;
  /** Snapshot used for Diagnostics server-side initial paint (v0.4.1). */
  diagnosticsData?: () => DiagnosticsData;
  /** Snapshot used for Settings server-side initial paint (C9). */
  settingsData?: () => SettingsData;
  /** Snapshot used for Family-mode server-side initial paint (v0.7 Phase 5). */
  familyModeData?: () => FamilyModeData;
}

function sendHtml(res: express.Response, body: string): void {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.send(body);
}

/**
 * Register the shell + per-page routes. Call before any path-specific
 * `/dashboard/<page>` JSON endpoints — Express dispatches in mount order
 * and we want HTML routes to win for bare-page GETs.
 */
export function mountDashboardPages(
  app: ReturnType<typeof express>,
  deps: DashboardPageDeps = {},
): void {
  app.get('/dashboard', (_req, res) => {
    res.redirect(302, '/dashboard/helm');
  });

  const renderers: Record<DashboardPageId, () => string> = {
    helm:         () => renderHelmPage(deps.helmData?.()),
    home:         () => renderHomePage(deps.homeData?.()),
    topology:     () => renderTopologyPage(deps.topologyData?.()),
    streams:      () => renderStreamsPage(deps.streamsData?.()),
    history:      () => renderHistoryPage(deps.historyData?.()),
    plans:        () => renderPlansPage(deps.plansData?.()),
    decide:       () => renderDecidePage(deps.decideData?.()),
    toolkit:      () => renderToolkitPage(deps.toolkitData?.()),
    mcps:         () => renderMcpsPage(deps.mcpsData?.()),
    tools:        () => renderToolsPage(deps.toolsData?.()),
    permissions:  () => renderPermissionsPage(deps.permissionsData?.()),
    capabilities: () => renderCapabilitiesPage(deps.capabilitiesData?.()),
    diagnostics:  () => renderDiagnosticsOverview(deps.diagnosticsData?.()),
    settings:     () => renderSettingsPage(deps.settingsData?.()),
    'family-mode': () => renderFamilyModePage(deps.familyModeData?.()),
    about:        () => renderAboutPage(),
  };

  for (const entry of [...NAV_ENTRIES, ...LEGACY_NAV_ENTRIES]) {
    const render = renderers[entry.id];
    app.get(entry.href, (_req, res) => {
      sendHtml(res, render());
    });
  }

  // v0.6.12 Phase 2 — Diagnostics drill routes. Engine reuses the dense
  // existing layout (Health/Storage/Steward/Traffic), the other four
  // render honesty stubs in Phase 2 and are filled in Phase 4.
  app.get('/dashboard/diagnostics/engine', (_req, res) => {
    sendHtml(res, renderDiagnosticsPage(deps.diagnosticsData?.()));
  });
  app.get('/dashboard/diagnostics/connections', (_req, res) => {
    const d = deps.diagnosticsData?.();
    sendHtml(res, renderConnectionsDetail(d?.bricks ?? []));
  });
  app.get('/dashboard/diagnostics/workers', (_req, res) => {
    const d = deps.diagnosticsData?.();
    sendHtml(res, renderWorkersDetail(d?.workers ?? []));
  });
  app.get('/dashboard/diagnostics/federation', (_req, res) => {
    // peerCount on the DiagnosticsData bag is a number; until a richer
    // peer-roster getter wires through, render N placeholder rows so the
    // page has structure beyond the count tile.
    const d = deps.diagnosticsData?.();
    const count = d?.peerCount ?? 0;
    const peers = Array.from({ length: count }, (_, i) => ({
      id: `peer-${i + 1}`, reachable: true,
    }));
    sendHtml(res, renderFederationDetail(peers));
  });
  app.get('/dashboard/diagnostics/alerts', (_req, res) => {
    sendHtml(res, renderAlertsDetail([]));
  });
}

export { NAV_ENTRIES } from './shell.js';
export type { DashboardPageId } from './shell.js';
