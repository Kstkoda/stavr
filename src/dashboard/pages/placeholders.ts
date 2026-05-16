/**
 * Placeholder pages — C1 ships every nav entry as a reachable URL so the
 * shell is exercise-able end-to-end. Each subsequent checkpoint replaces
 * one of these with the real implementation:
 *   C2 → home (already real-ish)
 *   C3 → plans
 *   C4 → decide
 *   C5 → topology
 *   C6 → streams
 *   C7 → toolkit
 *   C8 → capabilities
 *   C9 → settings
 */
import { renderShell, type DashboardPageId } from '../shell.js';

interface PlaceholderSpec {
  id: DashboardPageId;
  title: string;
  sub: string;
  comingIn: string;
  description: string;
}

const SPECS: Record<Exclude<DashboardPageId, 'home' | 'helm' | 'mcps'>, PlaceholderSpec> = {
  topology: {
    id: 'topology',
    title: 'Topology',
    sub: 'Ops control center',
    comingIn: 'C5',
    description: 'SVG topology with workers, connectors, and a time scrubber for history rollback.',
  },
  streams: {
    id: 'streams',
    title: 'Streams',
    sub: 'Live worker terminals',
    comingIn: 'C6',
    description: 'Multi-pane terminal view for up to 20 concurrent workers with filters and search.',
  },
  plans: {
    id: 'plans',
    title: 'Stavr — Plans',
    sub: 'BOM approval surface',
    comingIn: 'C3',
    description: 'Food-label cards for each proposed BOM with What / Risk / Reversible / Cost.',
  },
  decide: {
    id: 'decide',
    title: 'Decide',
    sub: 'Open decisions',
    comingIn: 'C4',
    description: 'Food-label cards for every open decision with countdown, options, and context.',
  },
  toolkit: {
    id: 'toolkit',
    title: 'Toolkit',
    sub: 'ESB bus + bricks',
    comingIn: 'C7',
    description: 'Bricks above (external) and below (internal) the steward bus; click to inspect.',
  },
  capabilities: {
    id: 'capabilities',
    title: 'Capabilities',
    sub: 'Lego baseplate',
    comingIn: 'C8',
    description: 'Capability slots per profile mode (Turbo / Balanced / Eco).',
  },
  settings: {
    id: 'settings',
    title: 'Settings',
    sub: 'Profile · trust scopes · no-go list',
    comingIn: 'C9',
    description: 'Switch profile mode, manage trust scopes, edit the no-go list, install bricks.',
  },
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderPlaceholderPage(id: Exclude<DashboardPageId, 'home' | 'helm' | 'mcps'>): string {
  const spec = SPECS[id];
  const body = [
    `<div class="page-head">`,
    `<h1 class="page-title">${escapeHtml(spec.title)}</h1>`,
    `<span class="page-sub">${escapeHtml(spec.sub)}</span>`,
    `</div>`,
    `<div class="placeholder">`,
    `<strong>Coming in ${escapeHtml(spec.comingIn)}</strong>`,
    escapeHtml(spec.description),
    `</div>`,
  ].join('');

  return renderShell({
    title: spec.title,
    activePage: spec.id,
    body,
  });
}
