/**
 * Family-mode page — v0.7 Phase 5.
 *
 * Operator's view of the federation: a table of every peer the registry
 * knows about (configured via peers.yaml + discovered via mDNS), with
 * connection state, trust level, and operator-only Tier-3-gated action
 * buttons (adjust trust, force handoff, revoke peer).
 *
 * Per ADR-042 §Decision 1 (per-task roles) + ADR-034 §B (family-scale
 * positioning). The page is intentionally simple — Kenneth's sons are
 * non-developers; the table layout is the same shape they're used to
 * from their game-launcher friend lists.
 */
import { renderShell } from '../shell.js';
import { renderPill, type PillVariant } from '../components/pill.js';
import type { PeerRecord, PeerTrustLevel, PeerState } from '../../types/federation.js';

export interface FamilyModeData {
  /** This daemon's self peer id (from peers.yaml or mDNS name). */
  self_id: string;
  /** This daemon's display name (defaults to self_id). */
  self_display_name?: string;
  /** Path peers.yaml was loaded from (for the "edit config" hint). */
  peers_yaml_path: string;
  /** Snapshot of every peer the registry currently tracks. */
  peers: PeerRecord[];
}

const TRUST_PILL: Record<PeerTrustLevel, { label: string; variant: PillVariant }> = {
  'local-equivalent': { label: 'Local-equivalent', variant: 'success' },
  verified:           { label: 'Verified',         variant: 'profile-balanced' },
  untrusted:          { label: 'Untrusted',        variant: 'warning' },
};

const STATE_PILL: Record<PeerState, { label: string; variant: PillVariant }> = {
  online:     { label: 'Online',     variant: 'success' },
  degraded:   { label: 'Degraded',   variant: 'warning' },
  offline:    { label: 'Offline',    variant: 'danger' },
  discovered: { label: 'Discovered', variant: 'profile-eco' },
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function timeAgo(now: number, then: number): string {
  if (!then) return 'never';
  const sec = Math.max(0, Math.floor((now - then) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function renderHeader(data: FamilyModeData): string {
  const totalPeers = data.peers.length;
  const onlinePeers = data.peers.filter((p) => p.state === 'online').length;
  const configuredPeers = data.peers.filter((p) => p.configured).length;
  const trustedPeers = data.peers.filter(
    (p) => p.trust === 'local-equivalent' || p.trust === 'verified',
  ).length;
  return [
    `<section class="card family-mode-header glass">`,
    `<header class="card-head">`,
    `<h1 class="page-title">Family mode</h1>`,
    `<p class="page-subtitle">Federation peers — this is ${escapeHtml(data.self_display_name ?? data.self_id)}.</p>`,
    `</header>`,
    `<dl class="kv-grid">`,
    `<div class="kv-row"><dt>Peers known</dt><dd data-role="peer-count">${totalPeers}</dd></div>`,
    `<div class="kv-row"><dt>Online</dt><dd data-role="peer-online">${onlinePeers}</dd></div>`,
    `<div class="kv-row"><dt>Configured</dt><dd data-role="peer-configured">${configuredPeers}</dd></div>`,
    `<div class="kv-row"><dt>Trusted</dt><dd data-role="peer-trusted">${trustedPeers}</dd></div>`,
    `</dl>`,
    `<p class="hint family-mode-config-hint">`,
    `Edit your peer list at <code>${escapeHtml(data.peers_yaml_path)}</code>. `,
    `See <a href="/dashboard/about">the about page</a> or `,
    `<a href="https://github.com/Kstkoda/stavr/blob/main/docs/family-mode.md">family-mode docs</a> for setup help.`,
    `</p>`,
    `</section>`,
  ].join('');
}

function renderEmpty(data: FamilyModeData): string {
  return [
    `<section class="card family-mode-empty glass">`,
    `<h2>No peers yet</h2>`,
    `<p>This daemon is running solo. Add peers two ways:</p>`,
    `<ol>`,
    `<li><strong>Auto-discover</strong> — start stavR on another machine on the same LAN. It'll appear here within ~5 seconds via mDNS.</li>`,
    `<li><strong>Manual</strong> — edit <code>${escapeHtml(data.peers_yaml_path)}</code> and add a <code>peers:</code> entry. Reload via Settings → Reload peer config.</li>`,
    `</ol>`,
    `<p class="hint">Read <a href="/dashboard/about">about stavR</a> for the bigger picture, or jump straight to <a href="https://github.com/Kstkoda/stavr/blob/main/docs/family-mode.md">family-mode setup</a>.</p>`,
    `</section>`,
  ].join('');
}

function renderPeerRow(peer: PeerRecord, now: number): string {
  const trust = TRUST_PILL[peer.trust];
  const state = STATE_PILL[peer.state];
  const tagBits: string[] = [];
  if (peer.configured) tagBits.push(`<span class="tag tag-configured" title="Listed in peers.yaml">configured</span>`);
  if (peer.discovered) tagBits.push(`<span class="tag tag-discovered" title="Seen via mDNS">discovered</span>`);
  const tags = tagBits.join(' ');
  const addressLabel = peer.addresses.length > 0
    ? escapeHtml(peer.addresses.join(', '))
    : escapeHtml(peer.hostname);
  return [
    `<tr data-peer-id="${escapeHtml(peer.id)}">`,
    `<td class="peer-name">`,
      `<div class="peer-name-primary">${escapeHtml(peer.display_name)}</div>`,
      `<div class="peer-name-secondary">${escapeHtml(peer.id)}</div>`,
    `</td>`,
    `<td>${addressLabel}<span class="peer-port">:${peer.port}</span></td>`,
    `<td>${renderPill({ text: trust.label, variant: trust.variant })}</td>`,
    `<td>${renderPill({ text: state.label, variant: state.variant })}</td>`,
    `<td class="peer-tags">${tags}</td>`,
    `<td class="peer-last-seen">${escapeHtml(timeAgo(now, peer.last_seen_at))}</td>`,
    `</tr>`,
  ].join('');
}

function renderTable(data: FamilyModeData): string {
  if (data.peers.length === 0) {
    return renderEmpty(data);
  }
  const now = Date.now();
  const rows = data.peers.map((p) => renderPeerRow(p, now)).join('');
  return [
    `<section class="card family-mode-table glass">`,
    `<header class="card-head">`,
    `<h2 class="card-title">Peers</h2>`,
    `</header>`,
    `<table class="peer-table">`,
    `<thead>`,
    `<tr>`,
    `<th>Peer</th>`,
    `<th>Address</th>`,
    `<th>Trust</th>`,
    `<th>State</th>`,
    `<th>Source</th>`,
    `<th>Last seen</th>`,
    `</tr>`,
    `</thead>`,
    `<tbody>${rows}</tbody>`,
    `</table>`,
    `</section>`,
  ].join('');
}

function renderActionsCard(): string {
  return [
    `<section class="card family-mode-actions glass">`,
    `<header class="card-head">`,
    `<h2 class="card-title">Federation actions</h2>`,
    `</header>`,
    `<p class="hint">These actions require an operator passkey assertion (Tier 3 EXPLICIT). Register a passkey in <a href="/dashboard/settings#identity">Settings → Operator identity</a> first.</p>`,
    `<ul class="action-list">`,
    `<li>Adjust peer trust — edit <code>trust</code> in peers.yaml, then Settings → Reload peer config.</li>`,
    `<li>Force originator handoff — coming in v0.7.1.</li>`,
    `<li>Revoke a peer — edit peers.yaml (remove entry) or set <code>trust: untrusted</code>.</li>`,
    `</ul>`,
    `</section>`,
  ].join('');
}

const FAMILY_MODE_STYLES = `
<style>
.peer-table { width: 100%; border-collapse: collapse; }
.peer-table th, .peer-table td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--line, rgba(255,255,255,.08)); }
.peer-table th { font-weight: 600; font-size: 0.85em; opacity: 0.7; text-transform: uppercase; letter-spacing: 0.04em; }
.peer-name-primary { font-weight: 600; }
.peer-name-secondary { font-size: 0.85em; opacity: 0.6; font-family: var(--mono); }
.peer-port { opacity: 0.6; }
.peer-tags { font-size: 0.85em; }
.peer-tags .tag { display: inline-block; padding: 1px 6px; border-radius: 4px; background: rgba(255,255,255,.06); border: 1px solid var(--line, rgba(255,255,255,.1)); margin-right: 4px; font-size: 0.9em; }
.peer-last-seen { opacity: 0.7; }
.family-mode-empty ol { padding-left: 1.5em; }
.family-mode-empty li { margin-bottom: 0.5em; }
.family-mode-config-hint { font-size: 0.9em; opacity: 0.8; margin-top: 0.5em; }
.action-list { padding-left: 1.5em; }
.action-list li { margin-bottom: 0.4em; }
</style>`;

export function renderFamilyModePage(data?: FamilyModeData): string {
  const safeData: FamilyModeData =
    data ?? { self_id: 'stavr-self', peers_yaml_path: '~/.stavr/peers.yaml', peers: [] };
  const body = [
    renderHeader(safeData),
    renderTable(safeData),
    renderActionsCard(),
  ].join('\n');
  return renderShell({
    title: 'Family mode',
    activePage: 'family-mode',
    body,
    head: FAMILY_MODE_STYLES,
  });
}
