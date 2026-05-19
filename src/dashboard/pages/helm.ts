/**
 * Helm — the v0.4.1 primary page. Five-band vertical stack fills the
 * viewport from intent down to systems:
 *
 *   L4 INTENT     — Steward composer + last-5 intent timeline
 *   L3 PLANS      — 4 BOM cards + 24h gantt strip
 *   L2 WORKERS    — 6-up worker tiles (progress + step + uptime/eta)
 *   L1 TOOL CALLS — throughput histogram + top-5 tools + qps/p95/err trends
 *   L0 SYSTEMS    — 5-up system tiles (name + status + 1h sparkline)
 *
 * Visual contract: each band is .glass with a left-edge gradient in its
 * tier colour (L4 purple, L3 sky, L2 green, L1 amber, L0 ink). Status is
 * communicated by halo/dot color (ok/warn/crit); type colour is reserved
 * for L0 chips + L2 worker pills.
 *
 * Data: HelmData (existing shape, untouched) feeds the L4 sub line and the
 * worker + system fixtures. The 24h gantt strip and the L1 trend
 * sparklines are deterministic stubs derived from event_count — real
 * series come from /metrics, polled by the page JS.
 */

import type { Bom, ProfileMode } from '../../types/stavr-bom.js';
import type { DecisionRecord } from '../../persistence.js';
import { renderShell } from '../shell.js';
import { renderPill, type PillVariant } from '../components/pill.js';

export interface HelmWorker {
  id: string;
  type: string;
  /**
   * Legacy chip status. Retained for backwards compatibility — every L2
   * worker chip carries a `data-state` attribute that downstream tests
   * key off. New code should prefer `lifecycle_state` (added per BOM
   * v0.6.6 P3) which carries the finer-grained classification.
   */
  status: 'idle' | 'running' | 'crashed' | 'cleanup';
  uptime_sec?: number;
  current_step?: string;
  /**
   * BOM v0.6.6 — derived lifecycle bucket. When present, drives the chip
   * label and halo color. May be undefined for legacy HelmData payloads
   * (tests + back-compat snapshots); helm renderers fall back to status.
   */
  lifecycle_state?: import('../../workers/lifecycle.js').LifecycleState;
}

/**
 * BOM v0.6.6 P3 — single-source counter snapshot for the L2 WORKERS band.
 * Lifetime counts on the right hand of `0 active · N completed · X crashed`
 * style display per BOM hard rule #5.
 */
export interface HelmWorkerCounters {
  active: number;
  completed: number;
  crashed: number;
  killed_by_operator: number;
  stale: number;
  total: number;
}

export interface HelmSystem {
  id: string;
  label: string;
  /** Emoji / single-char glyph. */
  glyph: string;
  health: 'ok' | 'degraded' | 'down' | 'unknown';
  detail?: string;
}

export interface HelmDigestState {
  enabled: boolean;
  hour: number;
  minute: number;
  lastFiredAt?: number;
}

export interface HelmData {
  intent: {
    /** Current Steward focus — what the daemon thinks it's doing right now. */
    summary: string;
    /** Optional sub line (e.g., "Eco profile · 2 active BOMs"). */
    sub?: string;
  };
  health: {
    ok: boolean;
    version: string;
    port: number;
    started_at: string;
    uptime_sec: number;
    profile_mode: ProfileMode;
    event_count: number;
    active_scopes: number;
  };
  boms: { recent: Bom[]; total: number; open: number };
  decisions: { recent: DecisionRecord[]; open: number };
  workers: HelmWorker[];
  /**
   * BOM v0.6.6 — counters from src/dashboard/data/worker-counters.ts.
   * When undefined, the L2 band falls back to deriving from workers[]
   * (length-based; conflates lifetime with currently-active — that's
   * exactly the lie this PR is fixing, so transports.ts MUST populate
   * this field).
   */
  worker_counters?: HelmWorkerCounters;
  systems: HelmSystem[];
  /** v0.6 — daily digest state. Undefined when the notify fabric is disabled. */
  digest?: HelmDigestState;
}

const PROFILE_PILL: Record<ProfileMode, { label: string; variant: PillVariant }> = {
  turbo:    { label: 'Turbo',    variant: 'profile-turbo' },
  balanced: { label: 'Balanced', variant: 'profile-balanced' },
  eco:      { label: 'Eco',      variant: 'profile-eco' },
};

function levelTag(level: 'L0' | 'L1' | 'L2' | 'L3' | 'L4', name: string): string {
  // The num pill + visible " · NAME" + an sr-only mirror of the full
  // "Lx · NAME" string (tests assert that literal substring).
  return [
    `<span class="level-tag">`,
    `<span class="num">${level}</span>`,
    `<span class="lt-vis"> · ${name}</span>`,
    `<span class="lt-sr">${level} · ${name}</span>`,
    `</span>`,
  ].join('');
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtUptime(sec: number | undefined): string {
  if (!sec || sec <= 0) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function fmtAgo(iso: string | undefined): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const secs = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

function workerStatusClass(s: HelmWorker['status']): 'ok' | 'warn' | 'crit' | 'idle' {
  if (s === 'running') return 'ok';
  if (s === 'cleanup') return 'warn';
  if (s === 'crashed') return 'crit';
  return 'idle';
}

/**
 * BOM v0.6.6 P3 — when a worker has a lifecycle_state, its chip uses the
 * lifecycle halo class instead of the legacy status mapping. Maps the
 * lifecycle halo categories (ok/warn/crit/neutral/operator) into the
 * existing iron-palette class names recognised by the L2 CSS.
 */
function workerLifecycleClass(
  state: import('../../workers/lifecycle.js').LifecycleState,
): 'ok' | 'warn' | 'crit' | 'idle' {
  switch (state) {
    case 'starting':
    case 'running':            return 'ok';
    case 'killed-by-operator': return 'warn'; // operator action — distinct from crit (failure)
    case 'killed-by-system':
    case 'crashed':            return 'crit';
    case 'stale':              return 'warn';
    case 'completed-clean':
    case 'completed-error':
    default:                   return 'idle';
  }
}

function systemHaloStatus(s: HelmSystem['health']): 'ok' | 'warn' | 'crit' {
  if (s === 'ok') return 'ok';
  if (s === 'degraded') return 'warn';
  return 'crit';
}

// ============================== L4 INTENT ==============================
function renderIntentBand(d: HelmData): string {
  const profile = PROFILE_PILL[d.health.profile_mode];
  const intent = d.intent.summary || 'Steward is idle.';
  // v0.6.11 Phase 6d (UX audit H3) — the L4 secondary row already renders
  // the profile name inline AND the .profile-X pill below; rendering the
  // label both places duplicates "balanced ... BALANCED". Default `sub`
  // now omits the profile and only carries the BOM count.
  const sub = d.intent.sub ?? `${d.boms.open} active BOM${d.boms.open === 1 ? '' : 's'}`;
  const recent = d.decisions.recent.slice(0, 4);
  const timeline = recent.length === 0
    ? `<div class="l4-intent-row"><span class="ts">—</span><span class="what" style="color:var(--ink-3);font-style:italic;">no recent intents</span><span class="stat"></span></div>`
    : recent.map((r) => {
        const ts = r.requested_at ? new Date(r.requested_at).toISOString().slice(11, 16) : '—';
        const what = escapeHtml(r.question ?? r.correlation_id ?? 'decision');
        const statCls = r.status === 'open' ? 'wait' : (r.status === 'responded' ? 'ok' : '');
        const statText = r.status === 'open' ? 'open' : r.status === 'responded' ? 'done ✓' : 'expired';
        return `<div class="l4-intent-row"><span class="ts">${ts}</span><span class="what">${what}</span><span class="stat ${statCls}">${statText}</span></div>`;
      }).join('');

  return [
    `<section class="band glass" data-level="L4" data-slot="intent" data-fi-open="intent" tabindex="0" role="button" aria-label="Open Steward intent">`,
    `<div class="band-head">`,
    `<div>`,
    levelTag('L4', 'INTENT'),
    `<div class="level-name">User intent · talk to Steward</div>`,
    `<div class="level-desc">What you've asked stavR to accomplish</div>`,
    `</div>`,
    `<div class="band-agg">`,
    `<div class="primary">${d.boms.open || 0} active goal${d.boms.open === 1 ? '' : 's'}</div>`,
    `<div class="secondary"><span class="ok">●</span> on track · ${escapeHtml(sub)} · ${renderPill({ text: profile.label, variant: profile.variant, title: 'Active profile mode' })}</div>`,
    `</div>`,
    `<div class="band-arrow">› STEWARD</div>`,
    `</div>`,
    `<div class="band-rich">`,
    `<div class="l4-composer">`,
    `<div class="label">Current intent</div>`,
    `<div class="input">${escapeHtml(intent)}</div>`,
    `<div class="meta">`,
    `<span>cmd+enter to send to steward · esc to dismiss</span>`,
    `<div class="chips">`,
    `<span class="chip-tiny">${escapeHtml(d.health.profile_mode)}</span>`,
    `<span class="chip-tiny">${d.health.active_scopes} scope${d.health.active_scopes === 1 ? '' : 's'}</span>`,
    `</div>`,
    `</div>`,
    `</div>`,
    `<div class="l4-timeline">`,
    `<div class="label">Recent decisions</div>`,
    timeline,
    renderDigestRow(d.digest),
    `</div>`,
    `</div>`,
    `</section>`,
  ].join('');
}

function renderDigestRow(state?: HelmDigestState): string {
  // v0.6 P5 — tiny row showing the daily digest schedule. [Edit] opens a
  // time prompt; [Disable]/[Enable] flips the cron entry. Only renders when
  // the notify fabric is enabled (state !== undefined).
  if (!state) return '';
  const hh = String(state.hour).padStart(2, '0');
  const mm = String(state.minute).padStart(2, '0');
  const lastFired = state.lastFiredAt
    ? new Date(state.lastFiredAt).toISOString().slice(11, 16)
    : 'never';
  const status = state.enabled
    ? `<span class="stat ok">on · ${hh}:${mm}</span>`
    : `<span class="stat" style="color:var(--ink-3);">off</span>`;
  const toggleLabel = state.enabled ? 'Disable' : 'Enable';
  return [
    `<div class="l4-intent-row helm-digest-row" data-role="helm-digest">`,
    `<span class="ts">digest</span>`,
    `<span class="what">Last fired ${escapeHtml(lastFired)} · ${state.enabled ? 'next ' + hh + ':' + mm : 'paused'}</span>`,
    status,
    `<span class="row-actions" style="margin-left:auto;display:flex;gap:6px;">`,
    `<button type="button" class="btn ghost" data-role="digest-edit" style="font-size:10px;padding:2px 8px;">Edit</button>`,
    `<button type="button" class="btn ghost" data-role="digest-toggle" data-enabled="${state.enabled}" style="font-size:10px;padding:2px 8px;">${toggleLabel}</button>`,
    `</span>`,
    `</div>`,
  ].join('');
}

// ============================== L3 PLANS ===============================
function renderPlansBand(d: HelmData): string {
  const recent = d.boms.recent.slice(0, 4);
  const cards = recent.length === 0
    ? `<div class="l3-card l3-card-empty">No active plans. <a href="/dashboard/plans">propose one →</a></div>`
    : recent.map((b) => {
        const sub = `step ${b.steps_done}/${b.steps_total} · ${escapeHtml(b.status)}`;
        return [
          `<div class="l3-card" data-bom="${escapeHtml(b.id)}">`,
          `<div class="lab">${escapeHtml(b.status)} BOM</div>`,
          `<div class="val">${escapeHtml(b.goal.slice(0, 32))}${b.goal.length > 32 ? '…' : ''}</div>`,
          `<div class="sub">${sub}</div>`,
          `<div class="link">open plan</div>`,
          `</div>`,
        ].join('');
      }).join('');

  // Pad to 4 cards visually with summary placeholders when boms < 4.
  const pad = Math.max(0, 4 - recent.length);
  const padCards = Array(pad).fill(0).map((_, i) => {
    if (i === 0 && pad >= 1 && recent.length > 0) {
      return [
        `<div class="l3-card">`,
        `<div class="lab">Spent today</div>`,
        `<div class="val">$${(d.boms.recent.reduce((s, b) => s + (b.cost_actual ?? 0), 0)).toFixed(2)}</div>`,
        `<div class="sub">across ${d.boms.total} BOM${d.boms.total === 1 ? '' : 's'}</div>`,
        `<div class="link">budget</div>`,
        `</div>`,
      ].join('');
    }
    return `<div class="l3-card l3-card-soft"><div class="lab">slot ${i + 1 + recent.length}</div><div class="val">—</div><div class="sub">propose a BOM</div><div class="link">go to plans</div></div>`;
  }).join('');

  // 24h gantt strip — bars derived from started_at/ended_at; the now-cursor
  // tracks Date.now(). When timestamps are missing, fall back to a single
  // "no recent activity" row.
  const now = Date.now();
  const windowMs = 24 * 3600 * 1000;
  const winStart = now - windowMs;
  const ganttBars = d.boms.recent.slice(0, 4).map((b) => {
    const start = b.started_at ? Date.parse(b.started_at) : (b.approved_at ? Date.parse(b.approved_at) : NaN);
    const end = b.ended_at ? Date.parse(b.ended_at) : now;
    if (!Number.isFinite(start)) return '';
    const left = Math.max(0, Math.min(100, ((start - winStart) / windowMs) * 100));
    const width = Math.max(2, Math.min(100 - left, ((end - start) / windowMs) * 100));
    const cls = b.status === 'approved' ? 'run' : b.status === 'done' ? 'done' : 'wait';
    return `<div class="gantt-row"><div class="gantt-bar ${cls}" style="left:${left.toFixed(1)}%;width:${width.toFixed(1)}%;"><span class="lbl">${escapeHtml(b.id.slice(-8))}</span></div></div>`;
  }).filter(Boolean).join('') || `<div class="gantt-row"><div class="gantt-empty">no BOM activity in last 24h</div></div>`;

  return [
    `<section class="band glass" data-level="L3" data-slot="plans">`,
    `<div class="band-head">`,
    `<div>`,
    levelTag('L3', 'PLANS'),
    `<div class="level-name">Bills of Materials</div>`,
    `<div class="level-desc">Approved workflows in execution · ${d.boms.total} total</div>`,
    `</div>`,
    `<div class="band-agg">`,
    `<div class="primary">${d.boms.total} BOM${d.boms.total === 1 ? '' : 's'}</div>`,
    `<div class="secondary">${d.boms.open} open · <a href="/dashboard/plans" style="color:var(--sky);">view all →</a></div>`,
    `</div>`,
    `<div class="band-arrow">› PLANS</div>`,
    `</div>`,
    `<div class="band-rich" style="flex-direction:column;">`,
    `<div class="l3-cards">${cards}${padCards}</div>`,
    `<div class="l3-gantt">`,
    `<div class="label"><span>BOMs · last 24h</span><span>now</span></div>`,
    `<div class="l3-gantt-grid">${ganttBars}<div class="gantt-now" style="left:100%;"></div></div>`,
    `</div>`,
    `</div>`,
    `</section>`,
  ].join('');
}

// ============================== L2 WORKERS =============================
function renderWorkersBand(d: HelmData): string {
  // BOM v0.6.6 hard rule #7: primary view shows ONLY currently-active
  // workers — never historic chips. If lifecycle_state is populated, we
  // filter on it; otherwise we fall back to the legacy status mapping
  // (running/cleanup are the active shapes there).
  const activeWorkers = d.workers.filter((w) => {
    if (w.lifecycle_state) {
      return w.lifecycle_state === 'starting' || w.lifecycle_state === 'running';
    }
    // Legacy path: status === 'running' is the only definite active marker.
    return w.status === 'running' || w.status === 'cleanup';
  });
  const workers = activeWorkers.slice(0, 6);
  const empty = workers.length === 0;

  // Per BOM hard rule #5: never display a single number that conflates
  // lifetime vs currently-active. The counters object (when populated by
  // transports.ts) carries both; fall back to deriving an "active" count
  // from the filtered list if missing.
  const counters: HelmWorkerCounters = d.worker_counters ?? {
    active: activeWorkers.length,
    completed: 0,
    crashed: 0,
    killed_by_operator: 0,
    stale: 0,
    total: d.workers.length,
  };

  // Compact summary line: "0 active · 7 completed · 1 crashed [· N stale]".
  const summaryParts: string[] = [`${counters.active} active`];
  if (counters.completed > 0)          summaryParts.push(`${counters.completed} completed`);
  if (counters.crashed > 0)            summaryParts.push(`${counters.crashed} crashed`);
  if (counters.killed_by_operator > 0) summaryParts.push(`${counters.killed_by_operator} terminated`);
  if (counters.stale > 0)              summaryParts.push(`${counters.stale} stale`);
  const summary = summaryParts.join(' · ');

  // Acceptance test expects "No workers running" string — render an empty
  // worker grid plus a footer note so the string survives.
  const cards = empty
    ? `<div class="l2-empty">No workers running.</div>`
    : workers.map((w) => {
        // Prefer lifecycle_state for the visual class so a force-killed
        // worker reads visually distinct from a clean exit (BOM rule #6).
        const sc = w.lifecycle_state
          ? workerLifecycleClass(w.lifecycle_state)
          : workerStatusClass(w.status);
        const stepText = w.current_step ?? (w.status === 'idle' ? 'idle · ready' : '—');
        const pct = w.status === 'running' ? 40 + ((w.uptime_sec ?? 0) % 50) : (w.status === 'idle' ? 0 : 70);
        // data-state remains for back-compat; data-lifecycle is the
        // forward-compatible attribute new tests should key off.
        const lifecycleAttr = w.lifecycle_state
          ? ` data-lifecycle="${escapeHtml(w.lifecycle_state)}"`
          : '';
        return [
          `<button type="button" class="l2-worker ${sc}" data-state="${escapeHtml(w.status)}"${lifecycleAttr}`,
          ` data-worker-id="${escapeHtml(w.id)}" data-worker-type="${escapeHtml(w.type)}"`,
          ` data-worker-step="${escapeHtml(w.current_step ?? '')}"`,
          ` data-fi-open="worker">`,
          `<div class="name"><span class="dot ${sc}"></span>${escapeHtml(w.id.slice(-10))} <span class="role">${escapeHtml(w.type)}</span></div>`,
          `<div class="progress"><div style="width:${pct}%;"></div></div>`,
          `<div class="step">${escapeHtml(stepText)}</div>`,
          `<div class="meta"><span>${fmtUptime(w.uptime_sec)}</span><span class="eta">${w.status === 'running' ? '·' : '—'}</span></div>`,
          `</button>`,
        ].join('');
      }).join('');

  // Pad to 6 visual slots with empty tiles.
  const pad = empty ? 0 : Math.max(0, 6 - workers.length);
  const padCards = Array(pad).fill(0).map(() =>
    `<div class="l2-worker idle"><div class="name"><span class="dot idle"></span>—</div><div class="progress"><div style="width:0%;"></div></div><div class="step">slot open</div><div class="meta"><span>—</span><span class="eta">—</span></div></div>`
  ).join('');

  const historyLink = counters.total > counters.active
    ? ` · <a href="/dashboard/streams?status=all" style="color:var(--sky);">view ${counters.total - counters.active} historic →</a>`
    : '';

  return [
    `<section class="band glass" data-level="L2" data-slot="workers">`,
    `<div class="band-head">`,
    `<div>`,
    levelTag('L2', 'WORKERS'),
    `<div class="level-name">Worker subprocesses</div>`,
    `<div class="level-desc" data-role="worker-summary">${summary} · click any worker to inspect</div>`,
    `</div>`,
    `<div class="band-agg">`,
    `<div class="primary">${counters.active} active</div>`,
    `<div class="secondary">${counters.crashed > 0 ? `<span class="crit">${counters.crashed} crashed</span> · ` : ''}<a href="/dashboard/streams" style="color:var(--sky);">streams →</a>${historyLink}</div>`,
    `</div>`,
    `<div class="band-arrow">› STREAMS</div>`,
    `</div>`,
    `<div class="band-rich"><div class="l2-workers" data-role="workers-row">${cards}${padCards}</div></div>`,
    `</section>`,
  ].join('');
}

// ============================ L1 TOOL CALLS ============================
function renderToolCallsBand(d: HelmData): string {
  const seed = d.health.event_count || 0;
  const bars = 20;
  const values = new Array(bars).fill(0).map((_, i) => {
    const noise = ((seed * (i + 7)) % 23) / 23;
    return Math.max(15, Math.min(95, 25 + noise * 70));
  });
  const histo = values.map((v, i) => `<span class="bar${(i + 1) % 7 === 0 ? ' spike' : ''}" style="height:${v}%"></span>`).join('');

  // Top tools — bound to /dashboard/api/top-tools by the page JS. The
  // initial server-rendered state is the loading placeholder; if the fetch
  // returns zero items we replace it with the explicit empty-state copy
  // ("No tool calls in last hour."). Operator-trust pass (F9): NEVER ship
  // hardcoded mockup numbers here, the dashboard must not lie.
  const topRows = `<div class="top-tools-loading" data-role="top-tools-loading">Loading top tools…</div>`;

  return [
    `<section class="band glass" data-level="L1" data-slot="tool-calls">`,
    `<div class="band-head">`,
    `<div>`,
    levelTag('L1', 'TOOL CALLS'),
    `<div class="level-name">MCP traffic · atomic ops</div>`,
    `<div class="level-desc">Read / write / exec across all connected MCPs</div>`,
    `</div>`,
    `<div class="band-agg">`,
    `<div class="primary" data-role="l1-qps">${d.health.event_count}</div>`,
    `<div class="secondary">events · <a href="/dashboard/diagnostics" style="color:var(--sky);">diagnostics →</a></div>`,
    `</div>`,
    `<div class="band-arrow">› DIAGNOSTICS</div>`,
    `</div>`,
    `<div class="band-rich">`,
    `<div class="l1-panel">`,
    `<div class="label"><span>Throughput · last 20m</span><span data-role="l1-rate">…</span></div>`,
    `<div class="histo">${histo}</div>`,
    `</div>`,
    `<div class="l1-panel">`,
    `<div class="label"><span>Top tools · last 1h</span><span>n calls</span></div>`,
    `<div class="top-tools" data-role="top-tools">${topRows}</div>`,
    `</div>`,
    `<div class="l1-panel">`,
    `<div class="label"><span>Trends · 1h</span><span>·</span></div>`,
    `<div class="l1-trends">`,
    `<div class="l1-trend-row"><span class="k">qps</span><svg viewBox="0 0 100 18" preserveAspectRatio="none"><polyline fill="none" stroke="var(--green)" stroke-width="1.4" points="0,12 10,11 20,12 30,10 40,11 50,9 60,10 70,8 80,9 90,7 100,8"/></svg><span class="v" data-role="l1-trend-qps">—</span></div>`,
    `<div class="l1-trend-row"><span class="k">p95 ms</span><svg viewBox="0 0 100 18" preserveAspectRatio="none"><polyline fill="none" stroke="var(--sky)" stroke-width="1.4" points="0,10 10,9 20,10 30,11 40,9 50,10 60,9 70,11 80,10 90,9 100,10"/></svg><span class="v" data-role="l1-trend-p95">—</span></div>`,
    `<div class="l1-trend-row"><span class="k">err %</span><svg viewBox="0 0 100 18" preserveAspectRatio="none"><polyline fill="none" stroke="var(--amber)" stroke-width="1.4" points="0,14 10,13 20,13 30,12 40,11 50,10 60,9 70,8 80,7 90,6 100,5"/></svg><span class="v warn" data-role="l1-trend-err">—</span></div>`,
    `</div>`,
    `</div>`,
    `</div>`,
    `</section>`,
  ].join('');
}

// ============================== L0 SYSTEMS =============================
function renderSystemsBand(d: HelmData): string {
  const tiles = d.systems.length === 0
    ? `<div class="l0-empty">No external systems registered.</div>`
    : d.systems.slice(0, 5).map((s) => {
        const halo = systemHaloStatus(s.health);
        const lat = (s.detail && /^\d/.test(s.detail)) ? s.detail : (s.health === 'ok' ? 'ok' : s.health);
        // Static spark — real per-system traffic series ships with the
        // Diagnostics page (Phase 4) over /metrics-keyed-by-system.
        const spark = `<svg viewBox="0 0 100 22" preserveAspectRatio="none"><polyline fill="none" stroke="var(--${halo === 'ok' ? 'green' : halo === 'warn' ? 'amber' : 'red'})" stroke-width="1.4" points="0,14 10,13 20,14 30,12 40,13 50,11 60,12 70,10 80,11 90,9 100,10"/></svg>`;
        return [
          `<button type="button" class="l0-sys ${halo === 'ok' ? '' : halo}" data-state="${escapeHtml(s.health)}"`,
          ` data-sys-id="${escapeHtml(s.id)}" data-sys-label="${escapeHtml(s.label)}"`,
          ` data-sys-detail="${escapeHtml(s.detail ?? '')}"`,
          ` data-fi-open="system">`,
          `<div class="nm"><span class="dot ${halo}"></span>${escapeHtml(s.label)} <span class="lat ${halo === 'warn' ? 'warn' : ''}">${escapeHtml(String(lat))}</span></div>`,
          spark,
          `<div class="last">last · ${escapeHtml(s.id)}</div>`,
          `</button>`,
        ].join('');
      }).join('');

  const degraded = d.systems.filter((s) => s.health !== 'ok').length;
  return [
    `<section class="band glass" data-level="L0" data-slot="systems">`,
    `<div class="band-head">`,
    `<div>`,
    levelTag('L0', 'SYSTEMS'),
    `<div class="level-name">External + local connectors</div>`,
    `<div class="level-desc">Things stavR ultimately touches · click chip to inspect</div>`,
    `</div>`,
    `<div class="band-agg">`,
    `<div class="primary">${d.systems.length} connected</div>`,
    `<div class="secondary">${degraded > 0 ? `<span class="warn">${degraded} degraded</span>` : 'all healthy'}</div>`,
    `</div>`,
    `<div class="band-arrow">› TOPOLOGY</div>`,
    `</div>`,
    `<div class="band-rich"><div class="l0-grid">${tiles}</div></div>`,
    `</section>`,
  ].join('');
}

// =================================== CSS ===================================
const HELM_CSS = `
body[data-active-page="helm"] > main.page { padding: 14px 18px 16px; overflow: hidden; }
.helm-page {
  display: grid;
  grid-template-rows: auto 1fr;
  gap: 12px;
  height: calc(100vh - 52px - 30px);
  min-height: 0;
}
.helm-stack {
  display: grid;
  /* v0.6.11 Phase 6d (UX audit H1) — rebalance L0-L4 tier bands to equal
   * visual weight (previous explicit row sizes made L3 dominate). The
   * .band-head big-numbers column is also locked to 200px (was 280px). */
  grid-template-rows: repeat(5, minmax(120px, 1fr));
  gap: 10px;
  overflow: hidden;
  min-height: 0;
}
.band {
  position: relative;
  background: linear-gradient(180deg, rgba(20,22,31,.55), rgba(15,16,24,.4));
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 12px 16px;
  cursor: pointer;
  transition: background .2s, border-color .2s, transform .2s;
  overflow: hidden;
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  display: flex; flex-direction: column; gap: 10px;
  min-height: 0;
}
.band:hover {
  background: linear-gradient(180deg, rgba(28,30,42,.6), rgba(20,22,31,.4));
  border-color: var(--line-2);
}
.band::before {
  content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px;
  background: linear-gradient(180deg, transparent, currentColor, transparent);
  opacity: .55;
}
.band[data-level="L4"] { color: var(--purple); }
.band[data-level="L3"] { color: var(--sky); }
.band[data-level="L2"] { color: var(--green); }
.band[data-level="L1"] { color: var(--amber); }
.band[data-level="L0"] { color: var(--ink-1); }

.band-head {
  display: grid; grid-template-columns: 200px 1fr auto;
  align-items: center; gap: 18px;
  flex-shrink: 0;
}
.level-tag {
  display: inline-flex; align-items: center; gap: 8px;
  font-family: var(--mono); font-size: 11px;
  letter-spacing: .18em; color: var(--ink-2);
  margin-bottom: 3px;
}
.level-tag .num {
  color: currentColor; font-weight: 600;
  padding: 2px 7px; border-radius: 4px;
  background: rgba(255,255,255,.06);
}
.level-tag .lt-vis {
  letter-spacing: .18em; color: var(--ink-2); font-size: 11px;
}
.level-tag .lt-sr {
  position: absolute; width: 1px; height: 1px;
  padding: 0; margin: -1px; overflow: hidden;
  clip: rect(0,0,0,0); white-space: nowrap; border: 0;
}
.level-name { font-size: 15px; color: var(--ink-0); font-weight: 450; }
.level-desc { font-size: 11px; color: var(--ink-3); margin-top: 2px; }

.band-agg .primary {
  font-size: 24px; font-weight: 350; font-variant-numeric: tabular-nums;
  letter-spacing: -.02em; color: var(--ink-0);
}
.band-agg .secondary { font-size: 11px; color: var(--ink-2); margin-top: 2px; }
.band-agg .secondary .ok   { color: var(--ok); }
.band-agg .secondary .warn { color: var(--warn); }
.band-agg .secondary .crit { color: var(--crit); }

.band-arrow {
  font-family: var(--mono); font-size: 11px; color: currentColor;
  opacity: .5; padding: 4px 10px; border-radius: 6px;
  border: 1px solid currentColor; letter-spacing: .1em;
}
.band:hover .band-arrow { opacity: 1; }

.band-rich { flex: 1; min-height: 0; display: flex; gap: 12px; }

/* ---------- L4 ---------- */
.l4-composer {
  flex: 1.6;
  background: rgba(0,0,0,.3);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 10px 14px;
  display: flex; flex-direction: column; justify-content: space-between;
  min-width: 0;
}
.l4-composer .label, .l4-timeline .label {
  font-family: var(--mono); font-size: 10px; letter-spacing: .14em;
  color: var(--ink-3); text-transform: uppercase;
}
.l4-composer .input {
  color: var(--ink-1); font-size: 14px; font-style: italic;
}
.l4-composer .input::before { content: "▸ "; color: var(--purple); }
.l4-composer .meta {
  display: flex; justify-content: space-between; align-items: center;
  font-family: var(--mono); font-size: 10px; color: var(--ink-3);
}
.l4-composer .meta .chips { display: flex; gap: 5px; }
.chip-tiny {
  padding: 2px 7px; border-radius: 999px;
  background: rgba(167,139,250,.12); color: var(--purple);
  font-size: 9.5px; letter-spacing: .04em;
  border: 1px solid rgba(167,139,250,.3);
}

.l4-timeline {
  flex: 1; background: rgba(0,0,0,.2);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 10px 14px;
  display: flex; flex-direction: column; gap: 6px;
  min-width: 0; overflow: hidden;
}
.l4-intent-row {
  display: grid; grid-template-columns: 56px 1fr auto;
  gap: 8px; align-items: center;
  font-family: var(--mono); font-size: 11px;
}
.l4-intent-row .ts { color: var(--ink-3); }
.l4-intent-row .what { color: var(--ink-1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.l4-intent-row .stat { color: var(--ok); font-size: 9.5px; }

/* ---------- L3 ---------- */
.l3-cards {
  flex: 1; display: grid;
  grid-template-columns: repeat(4, 1fr); gap: 8px;
}
.l3-card {
  background: rgba(0,0,0,.28);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 10px 12px;
  display: flex; flex-direction: column; gap: 3px;
  cursor: pointer;
  transition: background .15s, border-color .15s;
  min-width: 0;
}
.l3-card:hover { background: rgba(0,0,0,.45); border-color: var(--line-2); }
.l3-card .lab {
  font-family: var(--mono); font-size: 9.5px;
  letter-spacing: .14em; text-transform: uppercase;
  color: var(--ink-3);
}
.l3-card .val {
  font-size: 14px; color: var(--ink-0); margin: 2px 0;
  font-variant-numeric: tabular-nums;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.l3-card .sub { color: var(--ink-2); font-size: 10px; font-family: var(--mono); }
.l3-card .link {
  color: var(--sky); font-size: 10px; font-family: var(--mono);
  margin-top: auto; padding-top: 6px;
}
.l3-card .link::before { content: "▸ "; }
.l3-card-empty {
  grid-column: span 4;
  text-align: center; color: var(--ink-2); font-style: italic;
  padding: 20px;
}
.l3-card-empty a { color: var(--sky); text-decoration: underline; }
.l3-card-soft { opacity: .55; }

.l3-gantt {
  height: 60px;
  background: rgba(0,0,0,.25);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 8px 12px;
  display: flex; flex-direction: column; gap: 4px;
}
.l3-gantt .label {
  display: flex; justify-content: space-between;
  font-family: var(--mono); font-size: 9.5px;
  letter-spacing: .14em; text-transform: uppercase;
  color: var(--ink-3);
}
.l3-gantt-grid { position: relative; flex: 1; min-height: 0; }
.gantt-row {
  position: relative; height: 8px; margin: 2px 0;
  background: rgba(255,255,255,.04); border-radius: 2px;
}
.gantt-bar { position: absolute; top: 0; bottom: 0; border-radius: 2px; }
.gantt-bar.run  { background: linear-gradient(90deg, var(--sky), rgba(106,169,255,.3)); }
.gantt-bar.done { background: linear-gradient(90deg, var(--green), rgba(109,213,140,.3)); }
.gantt-bar.wait { background: linear-gradient(90deg, var(--amber), rgba(226,169,66,.3)); }
.gantt-bar .lbl {
  position: absolute; left: 6px; top: -1px;
  font-family: var(--mono); font-size: 8.5px; color: rgba(0,0,0,.8);
  font-weight: 600; white-space: nowrap;
}
.gantt-empty {
  font-family: var(--mono); font-size: 10px; color: var(--ink-3);
  text-align: center; padding-top: 4px;
}
.gantt-now {
  position: absolute; top: 0; bottom: 0; width: 1.5px;
  background: var(--rust); box-shadow: 0 0 4px var(--rust);
}

/* ---------- L2 ---------- */
.l2-workers {
  flex: 1; display: grid;
  grid-template-columns: repeat(6, 1fr); gap: 8px;
}
.l2-worker {
  background: rgba(0,0,0,.28);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 8px 10px;
  display: flex; flex-direction: column; gap: 4px;
  cursor: pointer;
  transition: background .15s, border-color .15s;
  min-width: 0;
  text-align: left;
  color: var(--ink-0);
  font: inherit;
}
.l2-worker:hover { background: rgba(0,0,0,.42); border-color: var(--line-2); }
.l2-worker .name {
  display: flex; align-items: center; gap: 6px;
  font-family: var(--mono); font-size: 11px; color: var(--ink-0);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.l2-worker .role { color: var(--ink-3); font-size: 9.5px; margin-left: auto; }
.l2-worker .dot {
  width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
  background: var(--ink-3);
}
.l2-worker .dot.ok   { background: var(--ok);   box-shadow: 0 0 6px var(--ok); }
.l2-worker .dot.warn { background: var(--warn); box-shadow: 0 0 6px var(--warn); }
.l2-worker .dot.crit { background: var(--crit); box-shadow: 0 0 6px var(--crit); animation: l2-pulse 1.4s ease-in-out infinite; }
.l2-worker .dot.idle { background: var(--ink-3); }
@keyframes l2-pulse { 0%,100% { opacity: 1; } 50% { opacity: .4; } }
.l2-worker .progress {
  height: 5px; background: rgba(255,255,255,.05); border-radius: 99px;
  overflow: hidden;
}
.l2-worker .progress > div {
  height: 100%; background: linear-gradient(90deg, var(--green), rgba(109,213,140,.3));
}
.l2-worker.warn .progress > div { background: linear-gradient(90deg, var(--amber), rgba(226,169,66,.3)); }
.l2-worker.crit .progress > div {
  background: repeating-linear-gradient(45deg, rgba(239,90,111,.55) 0 4px, rgba(239,90,111,.25) 4px 8px);
}
.l2-worker.idle .progress > div { background: var(--line-2); }
.l2-worker .step {
  font-family: var(--mono); font-size: 9.5px; color: var(--ink-2);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.l2-worker .meta {
  display: flex; justify-content: space-between;
  font-family: var(--mono); font-size: 9.5px; color: var(--ink-3);
}
.l2-worker .meta .eta { color: var(--ink-1); }
.l2-worker.crit .meta .eta { color: var(--crit); }
.l2-empty {
  grid-column: span 6; text-align: center;
  color: var(--ink-2); font-style: italic;
  padding: 24px; font-size: 12px;
}

/* ---------- L1 ---------- */
.l1-panel {
  flex: 1;
  background: rgba(0,0,0,.28);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 8px 12px;
  display: flex; flex-direction: column; gap: 4px;
  min-height: 0;
}
.l1-panel .label {
  display: flex; justify-content: space-between;
  font-family: var(--mono); font-size: 9.5px;
  letter-spacing: .14em; text-transform: uppercase;
  color: var(--ink-3);
}
.histo {
  display: flex; align-items: flex-end; gap: 2px;
  flex: 1; min-height: 0;
}
.histo .bar {
  flex: 1; background: linear-gradient(180deg, var(--amber), rgba(226,169,66,.25));
  border-radius: 1.5px 1.5px 0 0; min-height: 2px;
}
.histo .bar.spike { background: linear-gradient(180deg, var(--crit), rgba(239,90,111,.3)); }
.top-tools { display: flex; flex-direction: column; gap: 3px; overflow: hidden; }
.top-tool-row {
  display: grid; grid-template-columns: 1fr auto 56px;
  align-items: center; gap: 8px;
  font-family: var(--mono); font-size: 11px;
}
.top-tool-row .nm { color: var(--ink-1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.top-tool-row .ct { color: var(--ink-3); font-size: 10px; text-align: right; }
.top-tool-row .micro-bar {
  height: 5px; background: rgba(255,255,255,.05); border-radius: 99px;
  position: relative;
}
.top-tool-row .micro-bar > div { height: 100%; background: var(--amber); border-radius: 99px; }
.top-tools-loading, .top-tools-empty {
  font-family: var(--mono); font-size: 10.5px; color: var(--ink-3);
  font-style: italic; padding: 6px 2px; text-align: center;
}
.l1-trends { display: grid; grid-template-rows: 1fr 1fr 1fr; gap: 4px; min-height: 0; }
.l1-trend-row {
  display: grid; grid-template-columns: 70px 1fr auto;
  align-items: center; gap: 8px;
}
.l1-trend-row .k { font-family: var(--mono); font-size: 10px; color: var(--ink-3); letter-spacing: .04em; }
.l1-trend-row .v {
  font-family: var(--mono); font-size: 11px; color: var(--ink-1);
  text-align: right;
}
.l1-trend-row .v.warn { color: var(--warn); }
.l1-trend-row svg { height: 18px; width: 100%; }

/* ---------- L0 ---------- */
.l0-grid {
  flex: 1; display: grid;
  grid-template-columns: repeat(5, 1fr); gap: 8px;
}
.l0-sys {
  background: rgba(0,0,0,.28);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 8px 10px;
  display: flex; flex-direction: column; gap: 5px;
  cursor: pointer;
  transition: background .15s, border-color .15s;
  min-width: 0;
  text-align: left;
  color: var(--ink-0);
  font: inherit;
}
.l0-sys:hover { background: rgba(0,0,0,.45); border-color: var(--line-2); }
.l0-sys.warn { border-color: rgba(226,169,66,.35); }
.l0-sys.crit { border-color: rgba(239,90,111,.4); }
.l0-sys .nm {
  display: flex; align-items: center; gap: 6px;
  font-family: var(--mono); font-size: 11px; color: var(--ink-0);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.l0-sys .dot {
  width: 7px; height: 7px; border-radius: 50%; background: var(--ink-3);
}
.l0-sys .dot.ok   { background: var(--ok);   box-shadow: 0 0 6px var(--ok); }
.l0-sys .dot.warn { background: var(--warn); box-shadow: 0 0 6px var(--warn); }
.l0-sys .dot.crit { background: var(--crit); box-shadow: 0 0 6px var(--crit); }
.l0-sys .lat { margin-left: auto; color: var(--ink-3); font-size: 9.5px; }
.l0-sys .lat.warn { color: var(--warn); }
.l0-sys svg { height: 22px; width: 100%; opacity: .85; }
.l0-sys .last {
  font-family: var(--mono); font-size: 9.5px; color: var(--ink-3);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.l0-empty {
  grid-column: span 5; text-align: center;
  color: var(--ink-2); font-style: italic;
  padding: 24px; font-size: 12px;
}
`;

const HELM_JS = `
(function() {
  const fi = window.__stavrFloatingInspector;
  if (!fi) return;

  const intent = document.querySelector('[data-slot="intent"]');
  if (intent) {
    intent.addEventListener('click', function() {
      fi.openAt(intent, {
        icon: 'S',
        title: 'Steward',
        sub: 'Current intent (sheet ships in v0.5, ADR-032)',
        sections: [
          { label: 'Profile', value: document.body.getAttribute('data-active-page') || '—' },
        ],
        actions: [{ label: 'Capabilities', onClick: "location.href='/dashboard/capabilities'" }],
      });
    });
  }

  document.querySelectorAll('.l2-worker[data-fi-open="worker"]').forEach(function(btn) {
    btn.addEventListener('click', function(ev) {
      ev.stopPropagation();
      fi.openAt(btn, {
        icon: 'W',
        title: btn.getAttribute('data-worker-id') || 'worker',
        sub: btn.getAttribute('data-worker-type') || '',
        sections: [
          { label: 'Status', value: btn.getAttribute('data-state') || '—' },
          { label: 'Step',   value: btn.getAttribute('data-worker-step') || '—' },
        ],
        actions: [{ label: 'Open Streams', onClick: "location.href='/dashboard/streams'" }],
      });
    });
  });

  document.querySelectorAll('.l0-sys[data-fi-open="system"]').forEach(function(btn) {
    btn.addEventListener('click', function(ev) {
      ev.stopPropagation();
      fi.openAt(btn, {
        icon: '·',
        title: btn.getAttribute('data-sys-label') || 'system',
        sub: btn.getAttribute('data-state') || '',
        sections: [
          { label: 'Id',     value: btn.getAttribute('data-sys-id') || '—' },
          { label: 'Detail', value: btn.getAttribute('data-sys-detail') || '—' },
        ],
        actions: [{ label: 'Topology', onClick: "location.href='/dashboard/topology'" }],
      });
    });
  });

  // L3/L1 band-arrow click handlers — keep band-bodies clickable too
  document.querySelectorAll('.band[data-slot="plans"]   .band-arrow').forEach(function(b){ b.addEventListener('click', function(){ location.href='/dashboard/plans'; }); });
  document.querySelectorAll('.band[data-slot="workers"] .band-arrow').forEach(function(b){ b.addEventListener('click', function(){ location.href='/dashboard/streams'; }); });
  document.querySelectorAll('.band[data-slot="tool-calls"] .band-arrow').forEach(function(b){ b.addEventListener('click', function(){ location.href='/dashboard/diagnostics'; }); });
  document.querySelectorAll('.band[data-slot="systems"] .band-arrow').forEach(function(b){ b.addEventListener('click', function(){ location.href='/dashboard/topology'; }); });

  // Pull /metrics for the L1 throughput rate + trend numbers. Lightweight:
  // single GET, parse Prom text, set 3 spans. Falls back silently.
  async function pullMetrics() {
    try {
      const r = await fetch('/metrics', { headers: { accept: 'text/plain' } });
      if (!r.ok) return;
      const t = await r.text();
      const rate = (t.match(/^stavr_events_rate_1m\\s+(\\S+)/m) || [])[1];
      const p95  = (t.match(/^stavr_tool_latency_p95_ms\\s+(\\S+)/m) || [])[1];
      const err  = (t.match(/^stavr_tool_error_rate\\s+(\\S+)/m) || [])[1];
      if (rate) { const el = document.querySelector('[data-role="l1-rate"]'); if (el) el.textContent = Number(rate).toFixed(2) + '/s'; }
      if (rate) { const el = document.querySelector('[data-role="l1-trend-qps"]'); if (el) el.textContent = Number(rate).toFixed(2); }
      if (p95)  { const el = document.querySelector('[data-role="l1-trend-p95"]'); if (el) el.textContent = Math.round(Number(p95)).toString(); }
      if (err)  { const el = document.querySelector('[data-role="l1-trend-err"]'); if (el) el.textContent = (Number(err) * 100).toFixed(1); }
    } catch (_e) { /* swallow */ }
  }
  pullMetrics();
  setInterval(pullMetrics, 5000);

  // v0.6 — digest row buttons (Edit hour / Disable-Enable). Lightweight POSTs
  // to /dashboard/settings/digest; full reload on success so the row reflects.
  document.addEventListener('click', async function(ev) {
    const edit = ev.target.closest('[data-role="digest-edit"]');
    const tog  = ev.target.closest('[data-role="digest-toggle"]');
    if (edit) {
      ev.preventDefault();
      const t = prompt('Digest time (HH:MM, local TZ)', '09:00');
      if (!t) return;
      const m = /^([01]?\\d|2[0-3]):([0-5]\\d)$/.exec(t.trim());
      if (!m) { alert('Bad time — use HH:MM'); return; }
      try {
        await fetch('/dashboard/settings/digest', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ hour: Number(m[1]), minute: Number(m[2]) }),
        });
        location.reload();
      } catch (_e) { /* swallow */ }
    }
    if (tog) {
      ev.preventDefault();
      const enabled = tog.getAttribute('data-enabled') === 'true';
      try {
        await fetch('/dashboard/settings/digest', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: !enabled }),
        });
        location.reload();
      } catch (_e) { /* swallow */ }
    }
  });

  // F9 — Top tools (last 1h) bind to /dashboard/api/top-tools. The L1 panel
  // server-renders a "Loading…" placeholder; this swaps in real rows or
  // the explicit empty-state copy. No hardcoded mockup names allowed here.
  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  async function pullTopTools() {
    const slot = document.querySelector('[data-role="top-tools"]');
    if (!slot) return;
    try {
      const r = await fetch('/dashboard/api/top-tools?range=1h', { headers: { accept: 'application/json' } });
      if (!r.ok) return;
      const body = await r.json();
      const tools = Array.isArray(body && body.tools) ? body.tools : [];
      if (tools.length === 0) {
        slot.innerHTML = '<div class="top-tools-empty" data-role="top-tools-empty">No tool calls in last hour.</div>';
        return;
      }
      slot.innerHTML = tools.map(function(t) {
        return '<div class="top-tool-row">'
             + '<span class="nm">' + escapeHtml(t.name || '?') + '</span>'
             + '<span class="micro-bar"><div style="width:' + (Number(t.pct) || 0) + '%;"></div></span>'
             + '<span class="ct">' + (Number(t.count) || 0) + '</span>'
             + '</div>';
      }).join('');
    } catch (_e) {
      slot.innerHTML = '<div class="top-tools-empty">Could not load top tools.</div>';
    }
  }
  pullTopTools();
  setInterval(pullTopTools, 15000);
})();
`;

export function renderHelmPage(data?: HelmData): string {
  const snapshot: HelmData = data ?? {
    intent: { summary: 'Steward is idle.', sub: 'No active BOMs.' },
    health: {
      ok: true,
      version: 'unknown',
      port: 0,
      started_at: new Date().toISOString(),
      uptime_sec: 0,
      profile_mode: 'balanced',
      event_count: 0,
      active_scopes: 0,
    },
    boms: { recent: [], total: 0, open: 0 },
    decisions: { recent: [], open: 0 },
    workers: [],
    systems: [],
  };

  const body = [
    `<div class="helm-page">`,
    `<div class="page-head">`,
    `<div>`,
    `<h1 class="page-title">Helm</h1>`,
    `<div class="page-sub">Take the wheel · L4 down to L0 · click any tier to drill into its page</div>`,
    `</div>`,
    `<div style="display:flex;gap:10px;align-items:center;font-family:var(--mono);font-size:11px;color:var(--ink-2);">`,
    `<span>uptime · ${escapeHtml(fmtUptime(snapshot.health.uptime_sec))}</span>`,
    `<span style="color:var(--ink-3);">·</span>`,
    `<span>${snapshot.health.event_count} events</span>`,
    `<span style="color:var(--ink-3);">·</span>`,
    `<span>${snapshot.health.active_scopes} scope${snapshot.health.active_scopes === 1 ? '' : 's'}</span>`,
    `</div>`,
    `</div>`,
    `<div class="helm-stack">`,
    renderIntentBand(snapshot),
    renderPlansBand(snapshot),
    renderWorkersBand(snapshot),
    renderToolCallsBand(snapshot),
    renderSystemsBand(snapshot),
    `</div>`,
    `</div>`,
  ].join('');

  return renderShell({
    title: 'Stavr — Helm',
    activePage: 'helm',
    body,
    head: `<style>${HELM_CSS}</style>`,
    script: HELM_JS,
  });
}
