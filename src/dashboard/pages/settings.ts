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
import type { ChannelStatusView } from '../data/channels.js';

export interface SettingsScope {
  id: string;
  title: string;
  status: string;
  description?: string;
  allowed_actions?: Array<{ tool: string; param_constraints?: Record<string, unknown> }>;
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
  /** v0.4 — runtime toggles for /debug/* endpoints. */
  runtimeToggles?: Array<{
    key: string;
    value: string;
    set_by: string;
    set_at: number;
    expires_at: number | null;
  }>;
  /** v0.4 — recent diagnostic captures (heap/cpu/report). */
  recentDiagnostics?: Array<{ kind: string; at: string; payload: Record<string, unknown> }>;
  /** v0.6 — notification channels (undefined when STAVR_NOTIFY_SECRET not set). */
  channels?: ChannelStatusView[];
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

function renderPendingScopesSection(scopes: SettingsScope[]): string {
  // Storm F2 — operator-approval surface for trust_scope_propose calls
  // from the MCP side. Without this panel, scopes proposed by e.g.
  // host_exec sit at status='proposed' forever and the MCP grant tool's
  // await_decision times out.
  const cards = scopes.length === 0
    ? `<div class="empty">No pending scope proposals.</div>`
    : scopes.map((s) => {
      const actionsList = (s.allowed_actions ?? []).map((a) => {
        const constraints = a.param_constraints
          ? ` <span class="muted small">(${escapeHtml(JSON.stringify(a.param_constraints))})</span>`
          : '';
        return `<li><code>${escapeHtml(a.tool)}</code>${constraints}</li>`;
      }).join('');
      const expires = s.expires_at ? escapeHtml(s.expires_at) : '—';
      const cap = s.expires_after_actions !== undefined
        ? `${s.expires_after_actions} action${s.expires_after_actions === 1 ? '' : 's'}`
        : '∞';
      return [
        `<div class="pending-scope-card" data-scope-id="${escapeHtml(s.id)}">`,
        `<div class="pending-scope-head">`,
        `<div>`,
        `<div class="pending-scope-title">${escapeHtml(s.title)}</div>`,
        `<div class="pending-scope-id muted small"><code>${escapeHtml(s.id)}</code></div>`,
        `</div>`,
        `<button type="button" class="btn primary" data-role="grant" data-id="${escapeHtml(s.id)}">Grant</button>`,
        `</div>`,
        s.description ? `<div class="pending-scope-desc">${escapeHtml(s.description)}</div>` : '',
        actionsList ? `<ul class="pending-scope-actions">${actionsList}</ul>` : '',
        `<div class="pending-scope-meta muted small">`,
        `Expires: ${expires} · Cap: ${cap}`,
        `</div>`,
        `</div>`,
      ].join('');
    }).join('');
  return [
    `<section class="settings-section" data-section="pending-scopes">`,
    `<h2 class="card-title">Pending scopes · ${scopes.length}</h2>`,
    `<div class="pending-scope-grid" data-role="pending-scope-grid">${cards}</div>`,
    `<div class="section-status" data-role="pending-scopes-status"></div>`,
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

/* Pending scope cards — Storm F2 */
.pending-scope-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
  gap: 12px;
}
.pending-scope-card {
  background: var(--bg-surface);
  border: 1px solid var(--accent-mcp);
  border-left: 3px solid var(--accent-mcp);
  border-radius: 10px;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.pending-scope-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.pending-scope-title { font-weight: 600; font-size: 13px; color: var(--text-primary); }
.pending-scope-id { margin-top: 2px; }
.pending-scope-desc { font-size: 12px; color: var(--text-secondary); }
.pending-scope-actions {
  list-style: none;
  padding: 0;
  margin: 0;
  font-size: 11px;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  color: var(--text-secondary);
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.pending-scope-meta { font-size: 10px; }

/* v0.6 notification channels */
.channel-label { font-weight: 500; }
.channel-error { margin-top: 4px; color: var(--risk-high); }
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

  // ---------- pending scope approvals (Storm F2) ----------
  document.addEventListener('click', async function(ev) {
    const grant = ev.target.closest('[data-role="grant"]');
    if (!grant) return;
    ev.preventDefault();
    const id = grant.getAttribute('data-id');
    if (!confirm('Grant trust scope ' + id + '?')) return;
    grant.disabled = true;
    setStatus('pending-scopes-status', 'Granting…');
    try {
      await postJson('/dashboard/settings/scopes/' + encodeURIComponent(id) + '/grant', {});
      setStatus('pending-scopes-status', 'Granted ' + id, 'ok');
      // Full reload — SSE will land us in the same place, but reloading
      // also reflects the new row in the active-scopes table.
      setTimeout(function() { window.location.reload(); }, 350);
    } catch (err) {
      grant.disabled = false;
      setStatus('pending-scopes-status', 'Failed: ' + (err.message || err), 'error');
    }
  });

  // ---------- live refresh on trust scope events (Storm F2) ----------
  try {
    var es = new EventSource('/dashboard/stream');
    var refreshTimer = null;
    function scheduleScopeRefresh() {
      if (refreshTimer) return;
      refreshTimer = setTimeout(function() {
        refreshTimer = null;
        window.location.reload();
      }, 400);
    }
    es.addEventListener('event', function(msg) {
      try {
        var data = JSON.parse(msg.data || '{}');
        if (data && typeof data.kind === 'string'
            && (data.kind === 'trust_scope_proposed'
                || data.kind === 'trust_scope_granted'
                || data.kind === 'trust_scope_revoked')) {
          scheduleScopeRefresh();
        }
      } catch (_) { /* ignore */ }
    });
  } catch (_) { /* no live updates if SSE unavailable */ }

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

  // ---------- v0.6 notification channels ----------
  document.addEventListener('click', async function(ev) {
    const test = ev.target.closest('[data-role="channel-test"]');
    if (!test) return;
    ev.preventDefault();
    const id = test.getAttribute('data-id');
    test.disabled = true;
    setStatus('channels-status', 'Sending test to ' + id + '…');
    try {
      const out = await postJson('/dashboard/settings/channels/' + encodeURIComponent(id) + '/test', {});
      const ok = out && out.delivered === true;
      setStatus('channels-status', ok ? 'Test delivered via ' + id : 'Test queued (no 2xx yet — check phone)', ok ? 'ok' : 'error');
    } catch (err) {
      setStatus('channels-status', 'Failed: ' + (err.message || err), 'error');
    } finally {
      test.disabled = false;
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

function renderChannelsSection(channels: ChannelStatusView[] | undefined): string {
  // v0.6 — Notification channels. Mirrors the F2 pending-scopes panel:
  // .glass section, one row per channel, [Test] / [Help] actions. NO secret
  // display in UI (BOM hard rule #7); secrets are env-only.
  if (channels === undefined) {
    return [
      `<section class="settings-section" data-section="channels">`,
      `<h2 class="card-title">Notification channels</h2>`,
      `<div class="empty">Notification fabric disabled. Set <code>STAVR_NOTIFY_SECRET</code> and restart the daemon to enable.</div>`,
      `</section>`,
    ].join('');
  }
  const rows = channels.length === 0
    ? `<div class="empty">No channels registered.</div>`
    : channels.map((c) => {
      const statusVariant: PillVariant =
        c.effectiveStatus === 'configured' ? 'success'
        : c.effectiveStatus === 'configured_stale' ? 'warning'
        : 'neutral';
      const statusLabel =
        c.effectiveStatus === 'configured' ? 'CONFIGURED'
        : c.effectiveStatus === 'configured_stale' ? 'CONFIGURED · STALE'
        : 'NOT SET';
      const lastSuccess = c.lastSuccessAt
        ? `<span class="muted small" title="last success">${escapeHtml(timeAgo(c.lastSuccessAt))}</span>`
        : `<span class="muted small">—</span>`;
      const lastError = c.lastError
        ? `<div class="channel-error muted small" title="${escapeHtml(c.lastError)}">${escapeHtml(c.lastError.slice(0, 80))}${c.lastError.length > 80 ? '…' : ''}</div>`
        : '';
      const actions = c.effectiveStatus === 'not_set'
        ? `<a class="btn ghost" href="/dashboard/settings/notifications-help${escapeHtml(c.docAnchor)}" data-role="channel-help">Help</a>`
        : `<button type="button" class="btn ghost" data-role="channel-test" data-id="${escapeHtml(c.id)}">Test</button>`;
      return [
        `<tr data-channel-id="${escapeHtml(c.id)}" data-status="${c.effectiveStatus}">`,
        `<td class="channel-label">${escapeHtml(c.label)}</td>`,
        `<td>${renderPill({ text: statusLabel, variant: statusVariant })}</td>`,
        `<td>${lastSuccess}${lastError}</td>`,
        `<td class="row-actions">${actions}</td>`,
        `</tr>`,
      ].join('');
    }).join('');
  return [
    `<section class="settings-section" data-section="channels">`,
    `<h2 class="card-title">Notification channels · ${channels.length}</h2>`,
    `<table class="settings-table">`,
    `<thead><tr><th>Channel</th><th>Status</th><th>Last activity</th><th></th></tr></thead>`,
    `<tbody>${rows}</tbody>`,
    `</table>`,
    `<p class="empty" style="font-style:normal;margin:8px 0 0;">Channel secrets live in env vars only. The UI shows status + last-success + last-error; tokens never appear here.</p>`,
    `<div class="section-status" data-role="channels-status"></div>`,
    `</section>`,
  ].join('');
}

function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function renderCapturesSection(): string {
  // v0.4 — captures route config. For v0.4 every type routes to the local
  // `~/.stavr/captures/<type>.jsonl` file. The Steward will overlay
  // GitHub/Linear routing in v0.6+ (ADR-035 phase 1); the "Change" button
  // is wired but inert.
  const rows: Array<[string, string]> = [
    ['bug',         '~/.stavr/captures/bug.jsonl'],
    ['feature',     '~/.stavr/captures/feature.jsonl'],
    ['investigate', '~/.stavr/captures/investigate.jsonl'],
    ['todo',        '~/.stavr/captures/todo.jsonl'],
  ];
  const body = rows.map(([type, dest]) => `
    <tr>
      <td>${escapeHtml(type)}</td>
      <td><code>${escapeHtml(dest)}</code></td>
      <td class="row-actions"><button type="button" class="btn ghost" data-role="capture-route-change" data-type="${escapeHtml(type)}" disabled title="v0.6 — Steward routing">Change</button></td>
    </tr>
  `).join('');
  return [
    `<section class="settings-section" data-section="captures">`,
    `<h2 class="card-title">Captures · route config</h2>`,
    `<table class="settings-table">`,
    `<thead><tr><th>Type</th><th>Destination</th><th></th></tr></thead>`,
    `<tbody>${body}</tbody>`,
    `</table>`,
    `<p class="empty" style="font-style:normal;margin-top:8px;">v0.4 writes captures to a local jsonl. Steward routing to GitHub / Linear is v0.6+ (ADR-035 phase 1).</p>`,
    `</section>`,
  ].join('');
}

function renderDiagnosticsSection(
  toggles: NonNullable<SettingsData['runtimeToggles']>,
  recent: NonNullable<SettingsData['recentDiagnostics']>,
): string {
  // v0.4 runtime toggles — see memory/project_stavr_runtime_toggles.md.
  // Three /debug/* endpoints, each with a switch + countdown + take-now
  // action. Default TTL on enable = 60 min.
  const byKey = new Map(toggles.map((t) => [t.key, t]));
  const rows = [
    { key: 'STAVR_DEBUG_HEAP',   label: 'Heap snapshot',     endpoint: '/debug/heap-snapshot' },
    { key: 'STAVR_DEBUG_CPU',    label: 'CPU profile',       endpoint: '/debug/cpu-profile' },
    { key: 'STAVR_DEBUG_REPORT', label: 'Diagnostic report', endpoint: '/debug/diagnostic-report' },
  ];
  const rowsHtml = rows.map((row) => {
    const t = byKey.get(row.key);
    const on = t?.value === '1' || t?.value === 'true';
    const expiresAt = t?.expires_at ?? null;
    return `
      <tr data-role="diag-row" data-key="${escapeHtml(row.key)}">
        <td>${escapeHtml(row.label)} <code style="margin-left:6px;font-size:10px;color:var(--text-dim);">${escapeHtml(row.endpoint)}</code></td>
        <td>
          <label class="diag-switch">
            <input type="checkbox" data-role="diag-toggle" data-key="${escapeHtml(row.key)}"${on ? ' checked' : ''} />
            <span class="diag-switch-track"><span class="diag-switch-knob"></span></span>
          </label>
        </td>
        <td><span class="diag-countdown" data-role="diag-countdown" data-expires-at="${expiresAt ?? ''}">${expiresAt ? '' : '—'}</span></td>
        <td class="row-actions">
          <button type="button" class="btn" data-role="diag-extend" data-key="${escapeHtml(row.key)}">+1 h</button>
          <button type="button" class="btn primary" data-role="diag-take-now" data-endpoint="${escapeHtml(row.endpoint)}">Take now</button>
        </td>
      </tr>`;
  }).join('');

  const recentHtml = recent.length === 0
    ? '<p class="empty">Nothing in the last 24h.</p>'
    : '<ul style="list-style:none;padding:0;margin:0;font-size:11px;font-family:ui-monospace, Menlo, Consolas, monospace;">'
      + recent.slice(0, 10).map((e) => {
        const file = typeof e.payload?.file === 'string' ? e.payload.file : '(no file)';
        return `<li><span style="color:var(--rust-soft);">${escapeHtml(e.kind)}</span> <span style="color:var(--text-dim);">${escapeHtml(e.at.slice(11, 19))}</span> ${escapeHtml(file)}</li>`;
      }).join('') + '</ul>';

  return [
    `<section class="settings-section" data-section="diagnostics">`,
    `<h2 class="card-title">Diagnostics · runtime toggles</h2>`,
    `<table class="settings-table">`,
    `<thead><tr><th>Endpoint</th><th style="width:80px;">On</th><th style="width:120px;">Expires</th><th></th></tr></thead>`,
    `<tbody>${rowsHtml}</tbody>`,
    `</table>`,
    `<p class="empty" style="font-style:normal;margin:8px 0 0;">Default TTL 60 minutes; eviction is audit-logged. Endpoints stay loopback-only regardless (ADR-006).</p>`,
    `<h3 class="card-title" style="margin-top:18px;">Recent diagnostics (last 24h)</h3>`,
    recentHtml,
    `<div class="section-status" data-role="diagnostics-status"></div>`,
    `</section>`,
  ].join('');
}

const SETTINGS_DIAG_CSS = `
.diag-switch { position: relative; display: inline-block; width: 36px; height: 18px; cursor: pointer; }
.diag-switch input { opacity: 0; width: 0; height: 0; }
.diag-switch-track {
  position: absolute; inset: 0;
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  border-radius: 999px;
  transition: background 0.15s ease, border-color 0.15s ease;
}
.diag-switch-knob {
  position: absolute; top: 1px; left: 1px;
  width: 14px; height: 14px;
  background: var(--text-secondary);
  border-radius: 50%;
  transition: transform 0.15s ease, background 0.15s ease;
}
.diag-switch input:checked + .diag-switch-track {
  background: var(--rust-glow);
  border-color: var(--rust);
}
.diag-switch input:checked + .diag-switch-track .diag-switch-knob {
  transform: translateX(18px);
  background: var(--rust-soft);
}
.diag-countdown {
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 11px;
  color: var(--text-dim);
}
`;

const SETTINGS_DIAG_JS = `
(function() {
  // Countdown ticker — formats expires_at as "MM:SS left".
  function fmt(msLeft) {
    if (msLeft <= 0) return 'expired';
    const s = Math.floor(msLeft / 1000);
    const m = Math.floor(s / 60);
    const r = s % 60;
    return m + ':' + (r < 10 ? '0' : '') + r + ' left';
  }
  function tickCountdowns() {
    document.querySelectorAll('[data-role="diag-countdown"]').forEach(function(el) {
      const exp = Number(el.getAttribute('data-expires-at'));
      if (!exp) { el.textContent = '—'; return; }
      el.textContent = fmt(exp - Date.now());
    });
  }
  setInterval(tickCountdowns, 1000);
  tickCountdowns();

  async function setToggle(key, on, ttlMinutes) {
    const r = await fetch('/dashboard/settings/runtime-toggles', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: key, value: on ? '1' : '0', ttl_minutes: ttlMinutes }),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  document.querySelectorAll('[data-role="diag-toggle"]').forEach(function(input) {
    input.addEventListener('change', async function() {
      const key = input.getAttribute('data-key');
      const ttl = input.checked ? 60 : 0;
      try {
        const j = await setToggle(key, input.checked, ttl);
        const row = input.closest('[data-role="diag-row"]');
        const cd = row && row.querySelector('[data-role="diag-countdown"]');
        if (cd) {
          if (j.expires_at) {
            cd.setAttribute('data-expires-at', String(j.expires_at));
          } else {
            cd.setAttribute('data-expires-at', '');
            cd.textContent = input.checked ? 'no expiry' : '—';
          }
        }
        tickCountdowns();
      } catch (err) {
        input.checked = !input.checked;
        const status = document.querySelector('[data-role="diagnostics-status"]');
        if (status) { status.textContent = 'Toggle failed: ' + err.message; status.className = 'section-status error'; }
      }
    });
  });

  document.querySelectorAll('[data-role="diag-extend"]').forEach(function(b) {
    b.addEventListener('click', async function() {
      const key = b.getAttribute('data-key');
      try {
        const j = await setToggle(key, true, 60);
        const row = b.closest('[data-role="diag-row"]');
        const cd = row && row.querySelector('[data-role="diag-countdown"]');
        if (cd && j.expires_at) cd.setAttribute('data-expires-at', String(j.expires_at));
        tickCountdowns();
      } catch (err) { /* swallow */ }
    });
  });

  document.querySelectorAll('[data-role="diag-take-now"]').forEach(function(b) {
    b.addEventListener('click', async function() {
      const endpoint = b.getAttribute('data-endpoint');
      const status = document.querySelector('[data-role="diagnostics-status"]');
      if (status) { status.textContent = 'Triggering ' + endpoint + '…'; status.className = 'section-status'; }
      try {
        const r = await fetch(endpoint, { method: 'POST' });
        const j = r.headers.get('content-type') && r.headers.get('content-type').indexOf('json') >= 0
          ? await r.json()
          : { ok: r.ok };
        if (!r.ok || !j.ok) throw new Error(j.error || ('HTTP ' + r.status));
        if (status) { status.textContent = 'Wrote ' + (j.file || 'ok'); status.className = 'section-status ok'; }
      } catch (err) {
        if (status) { status.textContent = 'Failed: ' + err.message; status.className = 'section-status error'; }
      }
    });
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
  const toggles = snapshot.runtimeToggles ?? [];
  const recent = snapshot.recentDiagnostics ?? [];
  const pendingScopes = snapshot.scopes.filter((s) => s.status === 'proposed');
  const activeScopes = snapshot.scopes.filter((s) => s.status !== 'proposed');
  const body = [
    `<div class="page-head">`,
    `<h1 class="page-title">Settings</h1>`,
    `<span class="page-sub">Profile · trust scopes · no-go list · channels · captures · diagnostics · bricks</span>`,
    `</div>`,
    renderProfileSection(snapshot.activeMode),
    renderPendingScopesSection(pendingScopes),
    renderScopesSection(activeScopes),
    renderNoGoSection(snapshot.noGo),
    renderChannelsSection(snapshot.channels),
    renderCapturesSection(),
    renderDiagnosticsSection(toggles, recent),
    renderBricksSection(snapshot.bricks),
  ].join('');
  return renderShell({
    title: 'Stavr — Settings',
    activePage: 'settings',
    body,
    head: `<style>${SETTINGS_CSS}\n${SETTINGS_DIAG_CSS}</style>`,
    script: `${SETTINGS_JS}\n${SETTINGS_DIAG_JS}`,
  });
}
