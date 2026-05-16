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
import { renderPlansPage, type PlansData } from './pages/plans.js';
import { renderDecidePage, type DecideData } from './pages/decide.js';
import { renderToolkitPage, type ToolkitData } from './pages/toolkit.js';
import { renderMcpsPage, type McpsData } from './pages/mcps.js';
import { renderCapabilitiesPage, type CapabilitiesData } from './pages/capabilities.js';
import { renderSettingsPage, type SettingsData } from './pages/settings.js';

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
  /** Snapshot used for Toolkit server-side initial paint (C7). */
  toolkitData?: () => ToolkitData;
  /** Snapshot used for MCPs server-side initial paint (v0.4). */
  mcpsData?: () => McpsData;
  /** Snapshot used for Capabilities server-side initial paint (C8). */
  capabilitiesData?: () => CapabilitiesData;
  /** Snapshot used for Settings server-side initial paint (C9). */
  settingsData?: () => SettingsData;
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
    plans:        () => renderPlansPage(deps.plansData?.()),
    decide:       () => renderDecidePage(deps.decideData?.()),
    toolkit:      () => renderToolkitPage(deps.toolkitData?.()),
    mcps:         () => renderMcpsPage(deps.mcpsData?.()),
    capabilities: () => renderCapabilitiesPage(deps.capabilitiesData?.()),
    settings:     () => renderSettingsPage(deps.settingsData?.()),
  };

  for (const entry of [...NAV_ENTRIES, ...LEGACY_NAV_ENTRIES]) {
    const render = renderers[entry.id];
    app.get(entry.href, (_req, res) => {
      sendHtml(res, render());
    });
  }
}

export { NAV_ENTRIES } from './shell.js';
export type { DashboardPageId } from './shell.js';
