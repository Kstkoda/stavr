/**
 * v0.3 dashboard route wiring. Mounts /dashboard + per-page routes; the
 * caller still owns the /dashboard/* JSON APIs in transports.ts.
 *
 * /dashboard → 302 /dashboard/home (entry point)
 * /dashboard/home, /topology, /streams, /plans, /decide, /toolkit,
 * /capabilities, /settings  → server-rendered shell + page body.
 */
import type express from 'express';
import { NAV_ENTRIES, type DashboardPageId } from './shell.js';
import { renderHomePage } from './pages/home.js';
import { renderTopologyPage } from './pages/topology.js';
import { renderStreamsPage } from './pages/streams.js';
import { renderPlansPage } from './pages/plans.js';
import { renderDecidePage } from './pages/decide.js';
import { renderToolkitPage } from './pages/toolkit.js';
import { renderCapabilitiesPage } from './pages/capabilities.js';
import { renderSettingsPage } from './pages/settings.js';

const RENDERERS: Record<DashboardPageId, () => string> = {
  home:         renderHomePage,
  topology:     renderTopologyPage,
  streams:      renderStreamsPage,
  plans:        renderPlansPage,
  decide:       renderDecidePage,
  toolkit:      renderToolkitPage,
  capabilities: renderCapabilitiesPage,
  settings:     renderSettingsPage,
};

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
export function mountDashboardPages(app: ReturnType<typeof express>): void {
  app.get('/dashboard', (_req, res) => {
    res.redirect(302, '/dashboard/home');
  });

  for (const entry of NAV_ENTRIES) {
    const render = RENDERERS[entry.id];
    app.get(entry.href, (_req, res) => {
      sendHtml(res, render());
    });
  }
}

export { NAV_ENTRIES } from './shell.js';
export type { DashboardPageId } from './shell.js';
