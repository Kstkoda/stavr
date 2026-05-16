/**
 * Capabilities page — Lego baseplate showing what each profile mode
 * unlocks. Read-only for v0.3; editing assignments lands in v0.4.
 *
 * One slot per CapabilityTag. The active profile toggle at the top
 * re-renders the slot grid to show that mode's preferred model.
 * Below the baseplate: budget summary per profile.
 */
import {
  CAPABILITY_TAGS,
  DEFAULT_PROFILES,
  type CapabilityTag,
  type ProfileMode,
  type ProfileConfig,
} from '../../types/stavr-bom.js';
import { renderShell } from '../shell.js';
import { renderPill, type PillVariant } from '../components/pill.js';

export interface CapabilitiesData {
  activeMode: ProfileMode;
  /** Per-mode routing + budgets; defaults to DEFAULT_PROFILES when omitted. */
  profiles?: Record<ProfileMode, ProfileConfig>;
}

const MODE_PILL: Record<ProfileMode, PillVariant> = {
  turbo:    'profile-turbo',
  balanced: 'profile-balanced',
  eco:      'profile-eco',
};

const CAPABILITY_LABEL: Record<CapabilityTag, string> = {
  reading:            'reading',
  'cheap-classifier': 'cheap classifier',
  'code-execution':   'code execution',
  'code-reasoning':   'code reasoning',
  'long-context':     'long context',
  'multimodal-vision': 'multimodal · vision',
  'multimodal-audio': 'multimodal · audio',
  'tool-use-heavy':   'tool-use-heavy',
  'simple-summary':   'simple summary',
  'no-model':         'no model',
  'local-classifier': 'local · classifier',
  'local-reasoning':  'local · reasoning',
  'local-summary':    'local · summary',
  'local-reading':    'local · reading',
};

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function modelTier(model: string): 'opus' | 'sonnet' | 'haiku' | 'other' {
  const m = model.toLowerCase();
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  return 'other';
}

function shortModel(model: string): string {
  const m = model.toLowerCase();
  if (m.includes('opus-4-7')) return 'opus 4.7';
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet-4-6')) return 'sonnet 4.6';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku-4-5')) return 'haiku 4.5';
  if (m.includes('haiku')) return 'haiku';
  return model;
}

function renderSlot(tag: CapabilityTag, profile: ProfileConfig): string {
  const models = profile.routing[tag] ?? [];
  const top = models[0] ?? '(no model)';
  const tier = modelTier(top);
  const fallback = models.slice(1, 3);
  return [
    `<div class="cap-slot" data-tag="${escapeHtml(tag)}" data-tier="${tier}">`,
    `<div class="cap-slot-studs">`,
    `<span class="stud"></span><span class="stud"></span><span class="stud"></span><span class="stud"></span>`,
    `</div>`,
    `<div class="cap-slot-body">`,
    `<div class="cap-tag">${escapeHtml(CAPABILITY_LABEL[tag])}</div>`,
    `<div class="cap-model">${escapeHtml(shortModel(top))}</div>`,
    fallback.length > 0
      ? `<div class="cap-fallback">→ ${fallback.map((m) => escapeHtml(shortModel(m))).join(' · ')}</div>`
      : '',
    `</div>`,
    `</div>`,
  ].join('');
}

function renderBaseplate(mode: ProfileMode, profile: ProfileConfig): string {
  return [
    `<div class="baseplate" data-mode="${mode}">`,
    CAPABILITY_TAGS.map((tag) => renderSlot(tag, profile)).join(''),
    `</div>`,
  ].join('');
}

function formatBudget(n: number): string {
  if (!Number.isFinite(n)) return 'no cap';
  return `$${n.toFixed(0)}`;
}

function renderBudgetCard(mode: ProfileMode, profile: ProfileConfig): string {
  return [
    `<article class="budget-card" data-mode="${mode}">`,
    `<header>`,
    renderPill({ text: profile.label, variant: MODE_PILL[mode] }),
    `</header>`,
    `<div class="budget-desc">${escapeHtml(profile.description)}</div>`,
    `<dl class="budget-kv">`,
    `<div class="kv-row"><dt>Daily soft</dt><dd>${formatBudget(profile.budget_daily_soft_usd)}</dd></div>`,
    `<div class="kv-row"><dt>Daily hard</dt><dd>${formatBudget(profile.budget_daily_hard_usd)}</dd></div>`,
    `<div class="kv-row"><dt>Per job soft</dt><dd>${formatBudget(profile.budget_per_job_soft_usd)}</dd></div>`,
    `<div class="kv-row"><dt>On miss</dt><dd>${escapeHtml(profile.on_capability_miss)}</dd></div>`,
    `<div class="kv-row"><dt>Approval</dt><dd>${escapeHtml(profile.approval_policy)}</dd></div>`,
    `<div class="kv-row"><dt>Steward brain</dt><dd>${escapeHtml(profile.steward_brain)}</dd></div>`,
    `</dl>`,
    `</article>`,
  ].join('');
}

const CAP_CSS = `
.cap-toggle {
  display: flex;
  gap: 4px;
  margin-bottom: 18px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 4px;
  width: max-content;
}
.cap-toggle button {
  padding: 6px 14px;
  background: transparent;
  border: 0;
  color: var(--text-secondary);
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.04em;
}
.cap-toggle button[data-active="true"] {
  background: var(--bg-surface);
  color: var(--text-primary);
}
.cap-toggle button[data-mode="turbo"][data-active="true"]    { color: var(--profile-turbo); }
.cap-toggle button[data-mode="balanced"][data-active="true"] { color: var(--profile-balanced); }
.cap-toggle button[data-mode="eco"][data-active="true"]      { color: var(--profile-eco); }

.baseplate {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 14px;
  padding: 18px;
  background:
    linear-gradient(var(--bg-elevated), var(--bg-elevated)),
    repeating-linear-gradient(0deg,
      rgba(255,255,255,0.03) 0,
      rgba(255,255,255,0.03) 1px,
      transparent 1px,
      transparent 22px),
    repeating-linear-gradient(90deg,
      rgba(255,255,255,0.03) 0,
      rgba(255,255,255,0.03) 1px,
      transparent 1px,
      transparent 22px);
  background-blend-mode: normal, normal, normal;
  border: 1px solid var(--border-strong);
  border-radius: 12px;
  position: relative;
}
.cap-slot {
  background: var(--bg-surface);
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  position: relative;
  transition: transform 0.12s ease;
}
.cap-slot::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 10px;
  border: 1px solid transparent;
  pointer-events: none;
}
.cap-slot[data-tier="opus"]   { border-color: var(--accent-ai-external); }
.cap-slot[data-tier="sonnet"] { border-color: var(--accent-mcp); }
.cap-slot[data-tier="haiku"]  { border-color: var(--accent-ai-internal); }
.cap-slot[data-tier="other"]  { border-color: var(--border-strong); }
.cap-slot:hover { transform: translateY(-2px); }
.cap-slot-studs {
  display: flex;
  gap: 6px;
  position: absolute;
  top: -8px;
  left: 14px;
}
.cap-slot-studs .stud {
  width: 14px;
  height: 8px;
  border-radius: 3px 3px 0 0;
  background: inherit;
}
.cap-slot[data-tier="opus"]   .cap-slot-studs .stud { background: var(--accent-ai-external); }
.cap-slot[data-tier="sonnet"] .cap-slot-studs .stud { background: var(--accent-mcp); }
.cap-slot[data-tier="haiku"]  .cap-slot-studs .stud { background: var(--accent-ai-internal); }
.cap-slot[data-tier="other"]  .cap-slot-studs .stud { background: var(--border-strong); }
.cap-slot-body { display: flex; flex-direction: column; gap: 6px; }
.cap-tag {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-secondary);
}
.cap-model {
  font-size: 14px;
  font-weight: 700;
  color: var(--text-primary);
  font-family: ui-monospace, Menlo, Consolas, monospace;
}
.cap-fallback {
  font-size: 11px;
  color: var(--text-dim);
  font-family: ui-monospace, Menlo, Consolas, monospace;
}

.budgets {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 14px;
  margin-top: 22px;
}
.budget-card {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px;
}
.budget-card[data-mode="turbo"]    { border-top: 3px solid var(--profile-turbo); }
.budget-card[data-mode="balanced"] { border-top: 3px solid var(--profile-balanced); }
.budget-card[data-mode="eco"]      { border-top: 3px solid var(--profile-eco); }
.budget-card header { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.budget-desc { color: var(--text-secondary); font-size: 12px; margin-bottom: 10px; }
.budget-kv { margin: 0; display: grid; grid-template-columns: max-content 1fr; row-gap: 4px; column-gap: 14px; }
.budget-kv .kv-row { display: contents; }
.budget-kv dt { font-size: 11px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.05em; }
.budget-kv dd { margin: 0; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; color: var(--text-primary); }

.read-only-note {
  margin-top: 22px;
  padding: 10px 14px;
  background: var(--bg-surface);
  border-left: 3px solid var(--accent-mcp);
  border-radius: 4px;
  color: var(--text-secondary);
  font-size: 12px;
}
`;

const CAP_JS = `
(function() {
  const toggleButtons = document.querySelectorAll('.cap-toggle button');
  const profilesNode = document.getElementById('cap-profiles');
  let profiles = {};
  try { profiles = profilesNode ? JSON.parse(profilesNode.textContent || '{}') : {}; }
  catch (_) { profiles = {}; }
  const baseplate = document.querySelector('.baseplate');

  const TAGS = ${JSON.stringify(CAPABILITY_TAGS)};
  const LABELS = ${JSON.stringify(CAPABILITY_LABEL)};

  function modelTier(m) {
    m = String(m || '').toLowerCase();
    if (m.indexOf('opus') !== -1) return 'opus';
    if (m.indexOf('sonnet') !== -1) return 'sonnet';
    if (m.indexOf('haiku') !== -1) return 'haiku';
    return 'other';
  }
  function shortModel(m) {
    m = String(m || '');
    const ml = m.toLowerCase();
    if (ml.indexOf('opus-4-7') !== -1) return 'opus 4.7';
    if (ml.indexOf('opus') !== -1) return 'opus';
    if (ml.indexOf('sonnet-4-6') !== -1) return 'sonnet 4.6';
    if (ml.indexOf('sonnet') !== -1) return 'sonnet';
    if (ml.indexOf('haiku-4-5') !== -1) return 'haiku 4.5';
    if (ml.indexOf('haiku') !== -1) return 'haiku';
    return m;
  }
  function escapeHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function renderBaseplate(mode) {
    const profile = profiles[mode];
    if (!profile || !baseplate) return;
    const slots = TAGS.map(function(tag) {
      const models = (profile.routing && profile.routing[tag]) || [];
      const top = models[0] || '(no model)';
      const tier = modelTier(top);
      const fallback = models.slice(1, 3);
      const fbHtml = fallback.length === 0 ? '' :
        '<div class="cap-fallback">→ ' + fallback.map(function(m) { return escapeHtml(shortModel(m)); }).join(' · ') + '</div>';
      return ''
        + '<div class="cap-slot" data-tag="' + escapeHtml(tag) + '" data-tier="' + tier + '">'
        +   '<div class="cap-slot-studs">'
        +     '<span class="stud"></span><span class="stud"></span><span class="stud"></span><span class="stud"></span>'
        +   '</div>'
        +   '<div class="cap-slot-body">'
        +     '<div class="cap-tag">' + escapeHtml(LABELS[tag] || tag) + '</div>'
        +     '<div class="cap-model">' + escapeHtml(shortModel(top)) + '</div>'
        +     fbHtml
        +   '</div>'
        + '</div>';
    }).join('');
    baseplate.innerHTML = slots;
    baseplate.setAttribute('data-mode', mode);
  }

  toggleButtons.forEach(function(btn) {
    btn.addEventListener('click', function() {
      const mode = btn.getAttribute('data-mode');
      toggleButtons.forEach(function(b) { b.setAttribute('data-active', b === btn ? 'true' : 'false'); });
      renderBaseplate(mode);
    });
  });
})();
`;

export function renderCapabilitiesPage(data?: CapabilitiesData): string {
  const snapshot: CapabilitiesData = data ?? { activeMode: 'balanced' };
  const profiles = snapshot.profiles ?? DEFAULT_PROFILES;
  const active = snapshot.activeMode;
  const modes: ProfileMode[] = ['turbo', 'balanced', 'eco'];

  const toggle = [
    `<div class="cap-toggle" role="tablist" aria-label="Profile mode">`,
    modes.map((m) => `<button type="button" data-mode="${m}" data-active="${m === active ? 'true' : 'false'}">${profiles[m].label}</button>`).join(''),
    `</div>`,
  ].join('');

  const baseplate = renderBaseplate(active, profiles[active]);
  const budgets = [
    `<div class="budgets">`,
    modes.map((m) => renderBudgetCard(m, profiles[m])).join(''),
    `</div>`,
  ].join('');

  const body = [
    `<div class="page-head">`,
    `<h1 class="page-title">Capabilities</h1>`,
    `<span class="page-sub">${CAPABILITY_TAGS.length} capability slot${CAPABILITY_TAGS.length === 1 ? '' : 's'} · 3 profile modes</span>`,
    `</div>`,
    toggle,
    baseplate,
    budgets,
    `<div class="read-only-note">Read-only in v0.3. Editing assignments lands in v0.4 — for now, swap the active profile from <a href="/dashboard/settings" style="color:var(--accent-mcp);">Settings</a>.</div>`,
    `<script id="cap-profiles" type="application/json">${JSON.stringify(profiles)}</script>`,
  ].join('');

  return renderShell({
    title: 'Stavr — Capabilities',
    activePage: 'capabilities',
    body,
    head: `<style>${CAP_CSS}</style>`,
    script: CAP_JS,
  });
}
