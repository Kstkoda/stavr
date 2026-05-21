/**
 * Diagnostics — 5-tile overview (v0.6.12 Phase 2).
 *
 * Replaces the dense Proxmox-style landing with 5 large tiles, each summarizing
 * one substrate the operator might drill into. The dense layout moved to
 * /dashboard/diagnostics/engine (and was decomposed across the other four
 * detail routes in Phase 4).
 *
 * Per BOM:
 *   - 5 tiles: Engine, Connections, Workers, Federation, Alerts
 *   - Each: one status word/count + status-colored border + drill → affordance
 *   - No sparklines on the overview (those live on the detail pages)
 *   - Empty/future tiles dim with honest copy
 *   - NO-ORPHAN rule: every tile has a drill route declared inline
 */
import type { WorkerRecord } from '../../persistence.js';
import type { InstalledBrickLite } from '../adapters/topology.js';
import { renderShell } from '../shell.js';
import { fetchWorkerCounters } from '../data/worker-counters.js';
import { snapshotBuildVersions, type BuildVersions } from '../data/build-versions.js';

export interface DiagnosticsOverviewData {
  bricks?: InstalledBrickLite[];
  workers?: WorkerRecord[];
  peerCount?: number;
  steward?: {
    pid: number | null;
    status: 'starting' | 'up' | 'unhealthy' | 'down' | 'unwired';
    last_heartbeat_at: string | null;
    autonomy_mode: string;
    lessons_count: number;
    memory_working_keys: number;
  };
  /** Optional alert summary; absent => render "no active alerts". */
  alerts?: {
    active: number;
    history_24h: number;
    latest?: { severity: 'ok' | 'warn' | 'crit'; message: string; at: string };
  };
  versions?: BuildVersions;
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const DIAG_OVERVIEW_CSS = `
.diag-ov {
  display: flex; flex-direction: column; gap: 14px;
  padding: 4px 0;
}
.diag-ov-head {
  display: flex; align-items: baseline; gap: 12px;
}
.diag-ov-sub {
  color: var(--ink-2); font-size: 12px;
  font-family: var(--mono);
}
.diag-ov-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 14px;
}
.diag-tile {
  display: flex; flex-direction: column; gap: 8px;
  padding: 18px 20px;
  border-radius: 12px;
  background: var(--bg-glass);
  border: 1px solid var(--line);
  border-left-width: 4px;
  border-left-color: var(--ink-3);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  text-decoration: none;
  color: inherit;
  transition: transform .15s ease, border-color .15s ease, background .15s ease;
  min-height: 168px;
  cursor: pointer;
}
.diag-tile:hover {
  transform: translateY(-1px);
  background: var(--bg-glass-2);
}
.diag-tile[data-status="ok"]   { border-left-color: var(--ok);   }
.diag-tile[data-status="warn"] { border-left-color: var(--warn); }
.diag-tile[data-status="crit"] { border-left-color: var(--crit); }
.diag-tile[data-status="idle"] { border-left-color: var(--ink-3); opacity: 0.7; }
.diag-tile[data-status="future"] {
  border-left-color: var(--ink-3);
  opacity: 0.55;
  cursor: default;
  pointer-events: none;
}
.diag-tile-head {
  display: flex; align-items: baseline; justify-content: space-between;
  gap: 10px;
}
.diag-tile-title {
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--ink-2);
  font-weight: 500;
  margin: 0;
}
.diag-tile-status {
  font-family: var(--mono);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(255,255,255,0.04);
  color: var(--ink-2);
}
.diag-tile-status[data-status="ok"]   { color: var(--ok);   background: rgba(109,213,140,0.10); }
.diag-tile-status[data-status="warn"] { color: var(--warn); background: rgba(226,169,66,0.12); }
.diag-tile-status[data-status="crit"] { color: var(--crit); background: rgba(239,90,111,0.12); }
.diag-tile-status[data-status="idle"] { color: var(--ink-3); }
.diag-tile-status[data-status="future"] { color: var(--ink-3); }
.diag-tile-big {
  font-family: var(--mono);
  font-size: 22px;
  font-weight: 500;
  color: var(--ink-0);
  margin: 4px 0;
}
.diag-tile-sub {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--ink-2);
  line-height: 1.45;
  flex: 1;
}
.diag-tile-drill {
  display: inline-flex; align-items: center; gap: 6px;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--rust);
  margin-top: auto;
  letter-spacing: 0.04em;
}
.diag-tile-drill .arrow { transition: transform .15s ease; }
.diag-tile:hover .diag-tile-drill .arrow { transform: translateX(3px); }
.diag-ov-foot {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--ink-3);
  padding: 8px 4px 0;
}
`;

interface Tile {
  id: 'engine' | 'connections' | 'workers' | 'federation' | 'alerts';
  title: string;
  big: string;
  sub: string;
  statusLabel: string;
  status: 'ok' | 'warn' | 'crit' | 'idle' | 'future';
  drillHref: string;
  drillLabel: string;
}

function renderTile(t: Tile): string {
  const tag = t.status === 'future' ? 'div' : 'a';
  const href = t.status === 'future' ? '' : ` href="${t.drillHref}"`;
  return [
    `<${tag} class="diag-tile"${href} data-status="${t.status}" data-tile="${t.id}">`,
    `<div class="diag-tile-head">`,
    `<h3 class="diag-tile-title">${escapeHtml(t.title)}</h3>`,
    `<span class="diag-tile-status" data-status="${t.status}">${escapeHtml(t.statusLabel)}</span>`,
    `</div>`,
    `<div class="diag-tile-big">${escapeHtml(t.big)}</div>`,
    `<div class="diag-tile-sub">${escapeHtml(t.sub)}</div>`,
    `<div class="diag-tile-drill">${escapeHtml(t.drillLabel)} <span class="arrow">→</span></div>`,
    `</${tag}>`,
  ].join('');
}

export function renderDiagnosticsOverview(data?: DiagnosticsOverviewData): string {
  const bricks = data?.bricks ?? [];
  const workers = data?.workers ?? [];
  const peerCount = data?.peerCount ?? 0;
  const steward = data?.steward;
  const alerts = data?.alerts;
  const versions = data?.versions ?? snapshotBuildVersions();

  // ----- Engine -----
  const stewardStatus = steward?.status ?? 'unwired';
  const engineStatus: Tile['status'] =
    stewardStatus === 'up' ? 'ok'
    : stewardStatus === 'unhealthy' ? 'warn'
    : stewardStatus === 'down' ? 'crit'
    : 'idle';
  const engineTile: Tile = {
    id: 'engine',
    title: 'Engine',
    big: `v${versions.daemonVersion}`,
    sub: `daemon up · steward ${stewardStatus} · node ${versions.nodeVersion}`,
    statusLabel: engineStatus === 'ok' ? 'healthy' : engineStatus === 'warn' ? 'degraded' : engineStatus === 'crit' ? 'down' : 'idle',
    status: engineStatus,
    drillHref: '/dashboard/diagnostics/engine',
    drillLabel: 'drill · health · storage · steward · traffic',
  };

  // ----- Connections -----
  const enabledBricks = bricks.filter((b) => b.enabled);
  const connectionsStatus: Tile['status'] = enabledBricks.length === 0 ? 'idle' : 'ok';
  const connectionsTile: Tile = {
    id: 'connections',
    title: 'Connections',
    big: String(enabledBricks.length),
    sub: enabledBricks.length === 0
      ? 'No MCP servers registered yet. Register one on the MCPs page.'
      : `${enabledBricks.length} MCP server${enabledBricks.length === 1 ? '' : 's'} live · ${bricks.length - enabledBricks.length} disabled`,
    statusLabel: enabledBricks.length === 0 ? 'empty' : 'live',
    status: connectionsStatus,
    drillHref: '/dashboard/diagnostics/connections',
    drillLabel: 'drill · roster · latency · traffic',
  };

  // ----- Workers -----
  const workerCounters = fetchWorkerCounters(workers, Date.now());
  const workerCrashed = workerCounters.crashed + workerCounters.killed_by_system;
  const workersStatus: Tile['status'] =
    workerCrashed > 0 ? 'crit'
    : workerCounters.active > 0 ? 'ok'
    : workerCounters.total > 0 ? 'idle'
    : 'idle';
  const workersTile: Tile = {
    id: 'workers',
    title: 'Workers',
    big: `${workerCounters.active} active`,
    sub: `${workerCounters.total} lifetime · ${workerCrashed} crashed · last-4h shown by default on Workers + Topology`,
    statusLabel: workerCrashed > 0 ? `${workerCrashed} crashed` : workerCounters.active > 0 ? 'running' : 'idle',
    status: workersStatus,
    drillHref: '/dashboard/diagnostics/workers',
    drillLabel: 'drill · active · last-4h · spawner protocol',
  };

  // ----- Federation -----
  const federationStatus: Tile['status'] = peerCount > 0 ? 'ok' : 'idle';
  const federationTile: Tile = {
    id: 'federation',
    title: 'Federation',
    big: `${peerCount} peer${peerCount === 1 ? '' : 's'}`,
    sub: peerCount === 0
      ? 'No peers configured. Add one in ~/.stavr/peers.yaml — see /dashboard/family-mode.'
      : `${peerCount} peer${peerCount === 1 ? '' : 's'} reachable via mDNS or peers.yaml`,
    statusLabel: peerCount === 0 ? 'standalone' : 'federated',
    status: federationStatus,
    drillHref: '/dashboard/diagnostics/federation',
    drillLabel: 'drill · peers · handshakes · latency',
  };

  // ----- Alerts -----
  const alertActive = alerts?.active ?? 0;
  const alertsStatus: Tile['status'] = alertActive > 0
    ? (alerts?.latest?.severity === 'crit' ? 'crit' : 'warn')
    : 'ok';
  const alertsTile: Tile = {
    id: 'alerts',
    title: 'Alerts',
    big: alertActive === 0 ? 'all clear' : `${alertActive} active`,
    sub: alertActive === 0
      ? `${alerts?.history_24h ?? 0} alerts in the last 24h`
      : (alerts?.latest ? `latest: ${alerts.latest.message}` : `${alertActive} active alert${alertActive === 1 ? '' : 's'}`),
    statusLabel: alertActive === 0 ? 'clear' : `${alertActive} firing`,
    status: alertsStatus,
    drillHref: '/dashboard/diagnostics/alerts',
    drillLabel: 'drill · active · history · acknowledge',
  };

  const body = [
    `<div class="diag-ov">`,
    `<div class="page-head">`,
    `<div>`,
    `<h1 class="page-title">Diagnostics</h1>`,
    `<div class="page-sub">Five substrates, one tile each. Click to drill.</div>`,
    `</div>`,
    `</div>`,
    `<div class="diag-ov-grid">`,
    [engineTile, connectionsTile, workersTile, federationTile, alertsTile].map(renderTile).join(''),
    `</div>`,
    `<div class="diag-ov-foot">No-orphan rule: every tile here drills to a detail page. Status = halo on the left border (ok / warn / crit / idle).</div>`,
    `</div>`,
  ].join('');

  return renderShell({
    title: 'Stavr — Diagnostics',
    activePage: 'diagnostics',
    body,
    head: `<style>${DIAG_OVERVIEW_CSS}</style>`,
  });
}
