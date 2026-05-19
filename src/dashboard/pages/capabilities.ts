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
  /**
   * v0.4 — Ollama models currently available to the daemon (from
   * `OllamaProvider.listAvailableModels()` at page-render time). Empty
   * array means Ollama is unreachable or has no models pulled; the
   * matrix view shows a hint when this is empty AND a local-friendly
   * row is selected.
   */
  ollamaModels?: string[];
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

// ============================================================
// v0.4 — Steward pinned card + per-profile capability matrix
// ============================================================

function renderStewardCard(activeMode: ProfileMode, profiles: Record<ProfileMode, ProfileConfig>, ollamaModels: string[]): string {
  const brain = profiles[activeMode].steward_brain;
  const candidates = [
    'claude-opus-4-7',
    'claude-sonnet-4-6',
    'claude-haiku-4-5',
    ...ollamaModels,
  ];
  const options = candidates
    .map((m) => `<option value="${escapeHtml(m)}"${m === brain ? ' selected' : ''}>${escapeHtml(shortModel(m))}</option>`)
    .join('');
  return [
    `<section class="steward-pinned" data-role="steward-card">`,
    `<div class="steward-rune" aria-hidden="true">ᛋ</div>`,
    `<div class="steward-info">`,
    `<div class="steward-name">Steward</div>`,
    `<div class="steward-sub">Brain · <code>${escapeHtml(brain)}</code></div>`,
    `</div>`,
    `<label class="steward-pick">Model`,
    `<select data-role="steward-model" aria-label="Steward brain model">${options}</select>`,
    `</label>`,
    `<label class="steward-pin"><input type="checkbox" data-role="steward-pin" /> 🔒 Pin across profiles</label>`,
    `</section>`,
  ].join('');
}

function renderCapMatrix(profiles: Record<ProfileMode, ProfileConfig>, ollamaModels: string[]): string {
  const modes: ProfileMode[] = ['turbo', 'balanced', 'eco'];
  const cells = CAPABILITY_TAGS.map((tag) => {
    const tds = modes.map((mode) => {
      const list = profiles[mode].routing[tag] ?? [];
      const top = list[0] ?? '(no model)';
      const tier = modelTier(top);
      const isLocal = top !== '(no model)' && !top.startsWith('claude-');
      const hasModelAvailable = isLocal ? ollamaModels.includes(top) : true;
      const warn = isLocal && !hasModelAvailable;
      return [
        `<td class="cm-cell" data-mode="${mode}" data-tag="${escapeHtml(tag)}" data-tier="${tier}"${warn ? ' data-warn="missing"' : ''}>`,
        `<button type="button" class="cm-pick" data-cell="${escapeHtml(tag)}|${mode}" aria-label="Pick model for ${escapeHtml(tag)} on ${mode}">`,
        `<span class="cm-model">${escapeHtml(shortModel(top))}</span>`,
        warn ? `<span class="cm-warn" title="Local model not pulled — falls back to next entry on dispatch">!</span>` : '',
        `</button>`,
        `</td>`,
      ].join('');
    }).join('');
    return `<tr><th scope="row">${escapeHtml(CAPABILITY_LABEL[tag])}</th>${tds}</tr>`;
  }).join('');
  return [
    `<section class="cm-matrix">`,
    `<table class="cm-table">`,
    `<thead><tr><th></th>`,
    modes.map((m) => `<th class="cm-h" data-mode="${m}">${escapeHtml(profiles[m].label)}</th>`).join(''),
    `</tr></thead>`,
    `<tbody>${cells}</tbody>`,
    `</table>`,
    `</section>`,
  ].join('');
}

const CAP_V8_CSS = `
.steward-pinned {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px;
  background: linear-gradient(135deg, var(--bg-surface), var(--bg-elevated));
  border: 1px solid var(--rust-glow);
  border-radius: 12px;
  margin-bottom: 18px;
  box-shadow: 0 0 0 1px var(--rust-glow);
}
.steward-rune {
  width: 44px;
  height: 44px;
  border-radius: 12px;
  background: var(--rust);
  display: grid;
  place-items: center;
  font-size: 22px;
  font-weight: 800;
  color: #fff8f0;
}
.steward-info { flex: 1; }
.steward-name { font-size: 14px; font-weight: 700; }
.steward-sub  { font-size: 11px; color: var(--text-secondary); }
.steward-pick {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-secondary);
}
.steward-pick select {
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  color: var(--text-primary);
  border-radius: 6px;
  padding: 5px 10px;
  font-size: 12px;
  font-family: ui-monospace, Menlo, Consolas, monospace;
}
.steward-pin { font-size: 11px; color: var(--text-secondary); }

.cm-matrix { margin-bottom: 22px; }
.cm-table {
  width: 100%;
  border-collapse: collapse;
}
.cm-table th, .cm-table td {
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  text-align: left;
}
.cm-h {
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-secondary);
}
.cm-h[data-mode="turbo"]    { color: var(--profile-turbo); }
.cm-h[data-mode="balanced"] { color: var(--profile-balanced); }
.cm-h[data-mode="eco"]      { color: var(--profile-eco); }
.cm-cell { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11px; }
.cm-pick {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 4px 10px;
  cursor: pointer;
  color: var(--text-primary);
  font-family: inherit;
  font-size: 11px;
}
.cm-pick:hover { border-color: var(--rust); }
.cm-cell[data-tier="opus"]   .cm-pick { border-left: 3px solid var(--accent-ai-external); }
.cm-cell[data-tier="sonnet"] .cm-pick { border-left: 3px solid var(--accent-mcp); }
.cm-cell[data-tier="haiku"]  .cm-pick { border-left: 3px solid var(--accent-ai-internal); }
.cm-cell[data-tier="other"]  .cm-pick { border-left: 3px solid var(--text-dim); }
.cm-warn {
  color: var(--health-warn);
  font-weight: 700;
}
`;

const CAP_V8_JS = `
(function() {
  // v0.4: pick button opens the floating inspector with a model-list and
  // "pick" actions. Real save endpoint is v0.5 — for now we show the
  // candidate list and the user picks; the choice is logged for the
  // operator's awareness. This is the visual surface for the matrix.
  const fi = window.__stavrFloatingInspector;
  if (!fi) return;
  const ollamaModels = (function() {
    try {
      const el = document.getElementById('cap-ollama');
      return el ? JSON.parse(el.textContent || '[]') : [];
    } catch (_) { return []; }
  })();
  const FRONTIER = ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5'];
  const candidates = FRONTIER.concat(ollamaModels);

  document.querySelectorAll('.cm-pick').forEach(function(b) {
    b.addEventListener('click', function(ev) {
      ev.stopPropagation();
      const cell = b.getAttribute('data-cell') || '';
      const parts = cell.split('|');
      fi.openAt(b, {
        icon: 'C',
        title: parts[0] + ' · ' + parts[1],
        sub: 'Pick model · v0.4 read-only (save flow is v0.5)',
        sections: [
          { label: 'Current', value: b.textContent.trim() },
          { label: 'Available', value: candidates.join('\\n') },
        ],
      });
    });
  });
})();
`;

export function renderCapabilitiesPage(data?: CapabilitiesData): string {
  const snapshot: CapabilitiesData = data ?? { activeMode: 'balanced' };
  const profiles = snapshot.profiles ?? DEFAULT_PROFILES;
  const active = snapshot.activeMode;
  const ollamaModels = snapshot.ollamaModels ?? [];
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
    renderStewardCard(active, profiles, ollamaModels),
    renderCapMatrix(profiles, ollamaModels),
    `<h2 class="card-title" style="margin-top:18px;">Active profile baseplate</h2>`,
    toggle,
    baseplate,
    budgets,
    `<div class="read-only-note">v0.4 surfaces the matrix view + Ollama model list; persisting picks lands in v0.5 (ADR-032). Swap the active profile from <a href="/dashboard/settings" style="color:var(--accent-mcp);">Settings</a>.</div>`,
    `<script id="cap-profiles" type="application/json">${JSON.stringify(profiles)}</script>`,
    `<script id="cap-ollama"   type="application/json">${JSON.stringify(ollamaModels)}</script>`,
  ].join('');

  return renderShell({
    title: 'Stavr — Capabilities',
    activePage: 'capabilities',
    body,
    head: `<style>${CAP_CSS}\n${CAP_V8_CSS}</style>`,
    script: `${CAP_JS}\n${CAP_V8_JS}`,
  });
}
