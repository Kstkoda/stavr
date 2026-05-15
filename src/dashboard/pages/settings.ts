/**
 * Settings page — three sections plus brick install. Every config that
 * lives in the daemon's DB has a UI control here.
 *
 *   Profile        switcher Turbo / Balanced / Eco
 *   Trust scopes   list active scopes; extend / revoke each
 *   No-go list     enumerate rules; defaults read-only, user rules
 *                  toggle + delete + add
 *   Bricks         lightweight install/uninstall mirroring Toolkit's
 *                  installer (ops-flavoured)
 */
import type { ProfileMode } from '../../types/stavr-bom.js';
import type { InstalledBrickLite } from '../adapters/topology.js';
import { renderShell } from '../shell.js';
import { renderPill, type PillVariant } from '../components/pill.js';

export interface SettingsScope {
  id: string;
  title: string;
  status: string;
  expires_at?: string;
  actions_executed?: number;
  expires_after_actions?: number;
}

export interface NoGoRow {
  id: string;
  action_pattern: string;
  risk_class: string;
  reason: string;
  source: 'default' | 'user' | 'organization';
  enabled: boolean;
}

export interface SettingsData {
  activeMode: ProfileMode;
  scopes: SettingsScope[];
  noGo: NoGoRow[];
  bricks: InstalledBrickLite[];
}

const MODE_PILL: Record<ProfileMode, PillVariant> = {
  turbo:    'profile-turbo',
  balanced: 'profile-balanced',
  eco:      'profile-eco',
};

const RISK_PILL: Record<string, PillVariant> = {
  destructive:   'danger',
  financial:     'danger',
  credential:    'danger',
  'external-comm': 'warning',
  'write-remote':  'warning',
  execute:       'info',
  'write-local': 'info',
  'read-only':   'success',
};

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderProfileSection(active: ProfileMode): string {
  const modes: { id: ProfileMode; label: string; desc: string }[] = [
    { id: 'turbo',    label: 'Turbo',    desc: 'Best model every step. No cost cap. Re-plans up on failure.' },
    { id: 'balanced', label: 'Balanced', desc: 'Sonnet by default, Opus for hard steps. Cost-aware.' },
    { id: 'eco',      label: 'Eco',      desc: 'Haiku / Sonnet only. Fails fast on capability miss.' },
  ];
  const cards = modes.map((m) => [
    `<label class="mode-card${m.id === active ? ' active' : ''}" data-mode="${m.id}">`,
    `<input type="radio" name="profile-mode" value="${m.id}"${m.id === active ? ' checked' : ''} />`,
    `<div class="mode-head">`,
    renderPill({ text: m.label, variant: MODE_PILL[m.id] }),
    m.id === active ? `<span class="mode-active-flag">active</span>` : '',
    `</div>`,
    `<div class="mode-desc">${escapeHtml(m.desc)}</div>`,
    `</label>`,
  ].join('')).join('');
  return [
    `<section class="settings-section" data-section="profile">`,
    `<h2 class="card-title">Profile mode</h2>`,
    `<div class="mode-grid">${cards}</div>`,
    `<div class="section-status" data-role="profile-status"></div>`,
    `</section>`,
  ].join('');
}

function renderScopesSection(scopes: SettingsScope[]): string {
  const rows = scopes.length === 0
    ? `<div class="empty">No active trust scopes.</div>`
    : scopes.map((s) => {
      const expires = s.expires_at ? escapeHtml(s.expires_at) : '—';
      const actions = s.expires_after_actions !== undefined
        ? `${s.actions_executed ?? 0} / ${s.expires_after_actions}`
        : `${s.actions_executed ?? 0} / ∞`;
      return [
        `<tr data-scope-id="${escapeHtml(s.id)}">`,
        `<td class="scope-id">${escapeHtml(s.id.slice(0, 14))}…</td>`,
        `<td>${escapeHtml(s.title)}</td>`,
        `<td>${renderPill({ text: s.status, variant: s.status === 'active' ? 'success' : 'neutral' })}</td>`,
        `<td class="muted">${expires}</td>`,
        `<td class="muted">${actions}</td>`,
        `<td class="row-actions">`,
        `<button type="button" class="btn ghost" data-role="extend" data-id="${escapeHtml(s.id)}">Extend</button>`,
        `<button type="button" class="btn danger" data-role="revoke" data-id="${escapeHtml(s.id)}">Revoke</button>`,
        `</td>`,
        `</tr>`,
      ].join('');
    }).join('');
  return [
    `<section class="settings-section" data-section="scopes">`,
    `<h2 class="card-title">Trust scopes · ${scopes.length} active</h2>`,
    `<table class="settings-table">`,
    `<thead><tr><th>ID</th><th>Title</th><th>Status</th><th>Expires</th><th>Actions</th><th></th></tr></thead>`,
    `<tbody>${rows}</tbody>`,
    `</table>`,
    `<div class="section-status" data-role="scopes-status"></div>`,
    `</section>`,
  ].join('');
}

function renderNoGoSection(rules: NoGoRow[]): string {
  const rows = rules.map((r) => {
    const riskVariant = RISK_PILL[r.risk_class] ?? 'neutral';
    const sourceTag = r.source === 'user'
      ? '<span class="source-tag source-user">user</span>'
      : r.source === 'organization'
      ? '<span class="source-tag source-org">org</span>'
      : '<span class="source-tag source-default">default</span>';
    return [
      `<tr data-rule-id="${escapeHtml(r.id)}" data-source="${r.source}" data-enabled="${r.enabled}">`,
      `<td class="rule-id">${sourceTag} <code>${escapeHtml(r.id)}</code></td>`,
      `<td class="rule-pattern"><code>${escapeHtml(r.action_pattern)}</code></td>`,
      `<td>${renderPill({ text: r.risk_class, variant: riskVariant })}</td>`,
      `<td class="muted">${escapeHtml(r.reason)}</td>`,
      `<td class="row-actions">`,
      r.source === 'user'
        ? [
          `<button type="button" class="btn ghost" data-role="toggle-rule" data-id="${escapeHtml(r.id)}" data-now="${r.enabled}">${r.enabled ? 'Disable' : 'Enable'}</button>`,
          `<button type="button" class="btn danger" data-role="delete-rule" data-id="${escapeHtml(r.id)}">Delete</button>`,
        ].join('')
        : `<span class="muted small">read-only</span>`,
      `</td>`,
      `</tr>`,
    ].join('');
  }).join('');
  return [
    `<section class="settings-section" data-section="nogo">`,
    `<h2 class="card-title">No-go list · ${rules.length} rule${rules.length === 1 ? '' : 's'}</h2>`,
    `<table class="settings-table nogo-table">`,
    `<thead><tr><th>ID</th><th>Pattern</th><th>Risk</th><th>Reason</th><th></th></tr></thead>`,
    `<tbody>${rows}</tbody>`,
    `</table>`,
    `<form class="add-nogo-form" data-role="add-nogo">`,
    `<div class="add-row">`,
    `<input class="nogo-input" name="id" placeholder="rule.id (e.g. fs.write_etc)" required pattern="[A-Za-z0-9._-]+" />`,
    `<input class="nogo-input" name="action_pattern" placeholder='action pattern (regex or "tool.name")' required />`,
    `<select class="nogo-input" name="risk_class" required>`,
    `<option value="read-only">read-only</option>`,
    `<option value="write-local">write-local</option>`,
    `<option value="execute">execute</option>`,
    `<option value="write-remote">write-remote</option>`,
    `<option value="external-comm">external-comm</option>`,
    `<option value="credential">credential</option>`,
    `<option value="financial">financial</option>`,
    `<option value="destructive" selected>destructive</option>`,
    `</select>`,
    `<input class="nogo-input" name="reason" placeholder="reason (why it's a no-go)" required />`,
    `<button type="submit" class="btn primary">Add</button>`,
    `</div>`,
    `</form>`,
    `<div class="section-status" data-role="nogo-status"></div>`,
    `</section>`,
  ].join('');
}

function renderBricksSection(bricks: InstalledBrickLite[]): string {
  const rows = bricks.length === 0
    ? `<div class="empty">No bricks installed. Add one below or via Toolkit.</div>`
    : `<table class="settings-table"><thead><tr><th>ID</th><th>Kind</th><th>Display</th><th></th></tr></thead><tbody>`
      + bricks.map((b) => [
        `<tr data-brick-id="${escapeHtml(b.id)}">`,
        `<td><code>${escapeHtml(b.id)}</code></td>`,
        `<td class="muted">${escapeHtml(b.kind)}</td>`,
        `<td>${escapeHtml(b.display_name)}</td>`,
        `<td class="row-actions">`,
        `<a class="btn ghost" href="/dashboard/toolkit#${encodeURIComponent(b.id)}">Configure</a>`,
        `<button type="button" class="btn danger" data-role="uninstall-brick" data-id="${escapeHtml(b.id)}">Uninstall</button>`,
        `</td>`,
        `</tr>`,
      ].join('')).join('')
      + `</tbody></table>`;
  return [
    `<section class="settings-section" data-section="bricks">`,
    `<h2 class="card-title">Bricks · ${bricks.length} installed</h2>`,
    rows,
    `<div class="add-row">`,
    `<input class="nogo-input" data-role="brick-install-path" placeholder="/abs/path/to/brick (or github URL)" />`,
    `<button type="button" class="btn primary" data-role="brick-install-go">Install</button>`,
    `</div>`,
    `<div class="section-status" data-role="bricks-status"></div>`,
    `</section>`,
  ].join('');
}

const SETTINGS_CSS = `
.settings-section + .settings-section { margin-top: 28px; }
.settings-section h2.card-title { margin-bottom: 12px; }

.mode-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
}
.mode-card {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 6px;
  transition: border-color 0.12s ease, background 0.12s ease;
}
.mode-card:hover { border-color: var(--border-strong); }
.mode-card.active { border-color: var(--accent-mcp); background: rgba(96,165,250,0.06); }
.mode-card input[type="radio"] { display: none; }
.mode-head { display: flex; align-items: center; gap: 10px; }
.mode-active-flag {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--accent-mcp);
  font-weight: 700;
}
.mode-desc { color: var(--text-secondary); font-size: 12px; }

.settings-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.settings-table th {
  text-align: left;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-dim);
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
}
.settings-table td {
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}
.settings-table tr[data-enabled="false"] { opacity: 0.55; }
.settings-table .muted { color: var(--text-dim); }
.settings-table .muted.small { font-size: 10px; }
.scope-id, .rule-id code, .rule-pattern code {
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 11px;
}
.row-actions { white-space: nowrap; }
.row-actions .btn { padding: 4px 9px; font-size: 11px; margin-right: 4px; }
.row-actions .btn:last-child { margin-right: 0; }

.add-row {
  display: grid;
  grid-template-columns: 1fr 1.5fr 1fr 2fr auto;
  gap: 8px;
  margin-top: 12px;
}
.add-row > .btn { white-space: nowrap; }
.nogo-input {
  padding: 7px 11px;
  font-size: 12px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  color: var(--text-primary);
  font-family: inherit;
  min-width: 0;
}
.nogo-input:focus { outline: 2px solid var(--accent-mcp); outline-offset: 1px; }

.btn {
  padding: 7px 14px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  border: 1px solid var(--border-strong);
  background: var(--bg-elevated);
  color: var(--text-primary);
  cursor: pointer;
}
.btn.primary { background: rgba(96,165,250,0.15); border-color: var(--accent-mcp); color: var(--accent-mcp); }
.btn.primary:hover { background: rgba(96,165,250,0.30); }
.btn.danger  { background: rgba(239,68,68,0.10);  border-color: var(--risk-high); color: var(--risk-high); }
.btn.danger:hover { background: rgba(239,68,68,0.25); }
.btn.ghost { background: transparent; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
a.btn { display: inline-block; text-decoration: none; line-height: 1.3; }

.section-status { font-size: 11px; min-height: 14px; margin-top: 8px; color: var(--text-dim); }
.section-status.ok    { color: var(--risk-low); }
.section-status.error { color: var(--risk-high); }
.empty { color: var(--text-dim); font-style: italic; padding: 12px 0; }

.source-tag {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin-right: 6px;
  vertical-align: middle;
}
.source-user    { background: rgba(96,165,250,0.12);  color: var(--accent-mcp);          border: 1px solid var(--accent-mcp); }
.source-default { background: var(--bg-elevated);     color: var(--text-dim);            border: 1px solid var(--border); }
.source-org     { background: rgba(167,139,250,0.12); color: var(--accent-ai-external);  border: 1px solid var(--accent-ai-external); }
`;

const SETTINGS_JS = `
(function() {
  async function postJson(url, body) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    let data = null;
    try { data = await r.json(); } catch (_) { /* ignore */ }
    if (!r.ok) throw new Error((data && data.error) || ('HTTP ' + r.status));
    return data;
  }
  function setStatus(role, msg, cls) {
    const el = document.querySelector('[data-role="' + role + '"]');
    if (!el) return;
    el.textContent = msg;
    el.className = 'section-status' + (cls ? ' ' + cls : '');
  }

  // ---------- profile ----------
  document.querySelectorAll('input[name="profile-mode"]').forEach(function(input) {
    input.addEventListener('change', async function() {
      const mode = input.value;
      setStatus('profile-status', 'Switching…');
      try {
        await postJson('/dashboard/settings/profile', { mode: mode });
        setStatus('profile-status', 'Active mode: ' + mode, 'ok');
        document.querySelectorAll('.mode-card').forEach(function(card) {
          card.classList.toggle('active', card.getAttribute('data-mode') === mode);
        });
      } catch (err) {
        setStatus('profile-status', 'Failed: ' + (err.message || err), 'error');
      }
    });
  });

  // ---------- trust scopes ----------
  document.addEventListener('click', async function(ev) {
    const revoke = ev.target.closest('[data-role="revoke"]');
    const extend = ev.target.closest('[data-role="extend"]');
    if (revoke) {
      ev.preventDefault();
      const id = revoke.getAttribute('data-id');
      if (!confirm('Revoke trust scope ' + id + '?')) return;
      setStatus('scopes-status', 'Revoking…');
      try {
        await postJson('/dashboard/settings/scopes/' + encodeURIComponent(id) + '/revoke', {});
        setStatus('scopes-status', 'Revoked ' + id, 'ok');
        const row = revoke.closest('tr');
        if (row) row.parentNode.removeChild(row);
      } catch (err) {
        setStatus('scopes-status', 'Failed: ' + (err.message || err), 'error');
      }
    }
    if (extend) {
      ev.preventDefault();
      const id = extend.getAttribute('data-id');
      const hrs = prompt('Extend scope ' + id + ' by how many hours?', '4');
      if (!hrs) return;
      const newExpiresAt = new Date(Date.now() + Number(hrs) * 3600_000).toISOString();
      setStatus('scopes-status', 'Extending…');
      try {
        await postJson('/dashboard/settings/scopes/' + encodeURIComponent(id) + '/extend', { new_expires_at: newExpiresAt });
        setStatus('scopes-status', 'Extended ' + id + ' → ' + newExpiresAt, 'ok');
        setTimeout(function() { window.location.reload(); }, 400);
      } catch (err) {
        setStatus('scopes-status', 'Failed: ' + (err.message || err), 'error');
      }
    }
  });

  // ---------- no-go list ----------
  const addForm = document.querySelector('[data-role="add-nogo"]');
  if (addForm) {
    addForm.addEventListener('submit', async function(ev) {
      ev.preventDefault();
      const data = Object.fromEntries(new FormData(addForm));
      setStatus('nogo-status', 'Adding…');
      try {
        await postJson('/dashboard/settings/nogo', { rule: data });
        setStatus('nogo-status', 'Added ' + data.id, 'ok');
        addForm.reset();
        setTimeout(function() { window.location.reload(); }, 400);
      } catch (err) {
        setStatus('nogo-status', 'Failed: ' + (err.message || err), 'error');
      }
    });
  }
  document.addEventListener('click', async function(ev) {
    const toggle = ev.target.closest('[data-role="toggle-rule"]');
    const del = ev.target.closest('[data-role="delete-rule"]');
    if (toggle) {
      ev.preventDefault();
      const id = toggle.getAttribute('data-id');
      const now = toggle.getAttribute('data-now') === 'true';
      setStatus('nogo-status', 'Updating…');
      try {
        await postJson('/dashboard/settings/nogo/' + encodeURIComponent(id) + '/toggle', { enabled: !now });
        setStatus('nogo-status', 'Toggled ' + id, 'ok');
        setTimeout(function() { window.location.reload(); }, 300);
      } catch (err) {
        setStatus('nogo-status', 'Failed: ' + (err.message || err), 'error');
      }
    }
    if (del) {
      ev.preventDefault();
      const id = del.getAttribute('data-id');
      if (!confirm('Delete rule ' + id + '?')) return;
      setStatus('nogo-status', 'Deleting…');
      try {
        await postJson('/dashboard/settings/nogo/' + encodeURIComponent(id) + '/delete', {});
        setStatus('nogo-status', 'Deleted ' + id, 'ok');
        setTimeout(function() { window.location.reload(); }, 300);
      } catch (err) {
        setStatus('nogo-status', 'Failed: ' + (err.message || err), 'error');
      }
    }
  });

  // ---------- bricks ----------
  const brickGo = document.querySelector('[data-role="brick-install-go"]');
  const brickPath = document.querySelector('[data-role="brick-install-path"]');
  if (brickGo && brickPath) {
    brickGo.addEventListener('click', async function() {
      const path = brickPath.value.trim();
      if (!path) return;
      setStatus('bricks-status', 'Installing…');
      try {
        const out = await postJson('/dashboard/bricks/install', { source_path: path });
        setStatus('bricks-status', 'Installed ' + (out.brick && out.brick.id ? out.brick.id : 'brick'), 'ok');
        setTimeout(function() { window.location.reload(); }, 400);
      } catch (err) {
        setStatus('bricks-status', 'Failed: ' + (err.message || err), 'error');
      }
    });
  }
  document.addEventListener('click', async function(ev) {
    const un = ev.target.closest('[data-role="uninstall-brick"]');
    if (!un) return;
    ev.preventDefault();
    const id = un.getAttribute('data-id');
    if (!confirm('Uninstall brick ' + id + '?')) return;
    setStatus('bricks-status', 'Uninstalling…');
    try {
      await postJson('/dashboard/bricks/' + encodeURIComponent(id) + '/uninstall', {});
      setStatus('bricks-status', 'Uninstalled ' + id, 'ok');
      setTimeout(function() { window.location.reload(); }, 400);
    } catch (err) {
      setStatus('bricks-status', 'Failed: ' + (err.message || err), 'error');
    }
  });
})();
`;

export function renderSettingsPage(data?: SettingsData): string {
  const snapshot: SettingsData = data ?? {
    activeMode: 'balanced',
    scopes: [],
    noGo: [],
    bricks: [],
  };
  const body = [
    `<div class="page-head">`,
    `<h1 class="page-title">Settings</h1>`,
    `<span class="page-sub">Profile · trust scopes · no-go list · bricks</span>`,
    `</div>`,
    renderProfileSection(snapshot.activeMode),
    renderScopesSection(snapshot.scopes),
    renderNoGoSection(snapshot.noGo),
    renderBricksSection(snapshot.bricks),
  ].join('');
  return renderShell({
    title: 'Stavr — Settings',
    activePage: 'settings',
    body,
    head: `<style>${SETTINGS_CSS}</style>`,
    script: SETTINGS_JS,
  });
}
