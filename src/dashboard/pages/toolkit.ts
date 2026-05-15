/**
 * Toolkit page — ESB bus visualisation with brick editor.
 *
 * Horizontal red bar across the middle = steward. Bricks float above
 * (external — purple / orange / blue) or below (internal — yellow /
 * green / blue). Click a brick → inspector slides in with a form
 * rendered from its `configSchema()`. Save / Test wire to /dashboard/bricks/*.
 *
 * Drag-to-install is deferred (C10 polish). C7 lands the click-to-edit
 * surface + the install-from-path sidebar.
 */
import type {
  ConfigFieldSchema,
  ConnectorStatusKind,
} from '../../connectors/index.js';
import { renderShell } from '../shell.js';
import { renderBrick, type BrickKind } from '../components/brick.js';
import { renderPill, type PillVariant } from '../components/pill.js';

export interface ToolkitBrick {
  id: string;
  kind: string;
  displayName: string;
  position: 'above' | 'below';
  configSchema: ConfigFieldSchema[];
  status: { kind: ConnectorStatusKind; detail: string; lastChecked?: string };
}

export interface ToolkitData {
  bricks: ToolkitBrick[];
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STATUS_PILL: Record<ConnectorStatusKind, PillVariant> = {
  ok:          'success',
  needs_setup: 'warning',
  error:       'danger',
  disabled:    'neutral',
};

function mapBrickKind(kind: string): BrickKind {
  const k = kind.toLowerCase();
  if (k.includes('ai') && k.includes('ext')) return 'ai-external';
  if (k.includes('ai') && k.includes('int')) return 'ai-internal';
  if (k.includes('llm')) return 'ai-external';
  if (k === 'mcp' || k.includes('mcp')) return 'mcp';
  if (k.includes('webhook') || k.includes('http')) return 'connector-above';
  return 'connector-above';
}

function renderBrickTile(b: ToolkitBrick): string {
  const visualKind = b.position === 'below' ? 'connector-below' as BrickKind : mapBrickKind(b.kind);
  const svg = renderBrick({
    id: b.id,
    kind: visualKind,
    displayName: b.displayName.length > 14 ? b.displayName.slice(0, 13) + '…' : b.displayName,
    position: b.position,
    status: b.status.kind === 'ok' ? 'idle' : b.status.kind === 'error' ? 'error' : b.status.kind === 'needs_setup' ? 'running' : 'disabled',
  });
  return [
    `<div class="brick-tile" data-id="${escapeHtml(b.id)}" data-position="${b.position}">`,
    svg,
    `<div class="brick-tile-label">`,
    `<span class="brick-tile-name">${escapeHtml(b.displayName)}</span>`,
    renderPill({ text: b.status.kind, variant: STATUS_PILL[b.status.kind] }),
    `</div>`,
    `</div>`,
  ].join('');
}

const TOOLKIT_CSS = `
.toolkit-frame {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  gap: 18px;
  align-items: start;
}
@media (max-width: 1100px) {
  .toolkit-frame { grid-template-columns: 1fr; }
}
.toolkit-canvas {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 24px;
  min-height: 480px;
  display: grid;
  grid-template-rows: 1fr auto 1fr;
  gap: 18px;
  position: relative;
}
.brick-zone {
  display: flex;
  flex-wrap: wrap;
  align-content: flex-start;
  gap: 18px;
  min-height: 120px;
  padding: 10px;
  border-radius: 8px;
  border: 1px dashed transparent;
}
.brick-zone.above { align-items: flex-end; }
.brick-zone.below { align-items: flex-start; }
.brick-zone:empty::after {
  content: attr(data-empty);
  color: var(--text-dim);
  font-size: 12px;
  font-style: italic;
  margin: auto;
}
.bus {
  height: 3px;
  background: var(--accent-steward);
  border-radius: 3px;
  position: relative;
}
.bus::before, .bus::after {
  content: '';
  position: absolute;
  top: 50%;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--accent-steward);
  transform: translateY(-50%);
}
.bus::before { left: -6px; }
.bus::after  { right: -6px; }
.bus-label {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  background: var(--bg-surface);
  padding: 4px 14px;
  font-size: 10px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--accent-steward);
  font-family: ui-monospace, Menlo, Consolas, monospace;
  border: 1px solid var(--accent-steward);
  border-radius: 14px;
}
.brick-tile {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  padding: 6px;
  border-radius: 8px;
  transition: background 0.12s ease;
}
.brick-tile:hover { background: var(--bg-elevated); }
.brick-tile-label {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  text-align: center;
}
.brick-tile-name { font-size: 11px; color: var(--text-primary); font-weight: 600; }

.toolkit-side {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.installer-input {
  width: 100%;
  padding: 8px 12px;
  font-size: 12px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  color: var(--text-primary);
  font-family: ui-monospace, Menlo, Consolas, monospace;
}
.installer-input:focus { outline: 2px solid var(--accent-mcp); outline-offset: 1px; }
.installer-row { display: flex; flex-direction: column; gap: 8px; }
.installer-status {
  font-size: 11px;
  color: var(--text-dim);
  min-height: 14px;
}
.installer-status.ok    { color: var(--risk-low); }
.installer-status.error { color: var(--risk-high); }

/* Inspector form fields rendered dynamically. */
.cfg-form { display: flex; flex-direction: column; gap: 12px; }
.cfg-field { display: flex; flex-direction: column; gap: 4px; }
.cfg-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-secondary); }
.cfg-hint  { font-size: 11px; color: var(--text-dim); }
.cfg-input {
  padding: 7px 10px;
  font-size: 12px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  color: var(--text-primary);
  font-family: inherit;
  width: 100%;
}
.cfg-input:focus { outline: 2px solid var(--accent-mcp); outline-offset: 1px; }
.cfg-secret-note { font-size: 10px; color: var(--text-dim); }
.cfg-headers-row { display: grid; grid-template-columns: 1fr 1fr auto; gap: 6px; align-items: center; }
.btn { padding: 7px 14px; border-radius: 6px; font-size: 12px; font-weight: 600; border: 1px solid var(--border-strong); background: var(--bg-elevated); color: var(--text-primary); cursor: pointer; }
.btn.primary { background: rgba(96,165,250,0.15); border-color: var(--accent-mcp); color: var(--accent-mcp); }
.btn.primary:hover { background: rgba(96,165,250,0.30); }
.btn.ghost   { background: transparent; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.inspector-status { font-size: 11px; margin: 8px 0 0 0; min-height: 14px; }
.inspector-status.ok    { color: var(--risk-low); }
.inspector-status.error { color: var(--risk-high); }
`;

// The schemas array is serialised into the page so the client can render
// the form on click without round-tripping for the spec.
const TOOLKIT_JS = `
(function() {
  const canvas = document.querySelector('[data-role="toolkit-canvas"]');
  if (!canvas) return;
  const schemaNode = document.getElementById('toolkit-schemas');
  let schemas = {};
  if (schemaNode) {
    try { schemas = JSON.parse(schemaNode.textContent || '{}'); } catch (_) { schemas = {}; }
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function renderField(field) {
    const key = escapeHtml(field.key);
    const label = escapeHtml(field.label || field.key);
    const hint = field.hint ? '<div class="cfg-hint">' + escapeHtml(field.hint) + '</div>' : '';
    const req = field.required ? ' required' : '';
    const def = field.default == null ? '' : ' value="' + escapeHtml(String(field.default)) + '"';
    let input;
    switch (field.kind) {
      case 'password':
        input = '<input type="password" class="cfg-input" name="' + key + '"'
          + (field.secret ? ' placeholder="(secret — type to overwrite)"' : '') + req + '/>';
        break;
      case 'url':
        input = '<input type="url" class="cfg-input" name="' + key + '"' + def + req + '/>';
        break;
      case 'number':
        input = '<input type="number" class="cfg-input" name="' + key + '"' + def + req + '/>';
        break;
      case 'toggle':
        input = '<label style="display:flex;align-items:center;gap:8px;">'
              + '<input type="checkbox" name="' + key + '"' + (field.default ? ' checked' : '') + '/> '
              + '<span class="cfg-hint">enabled</span></label>';
        break;
      case 'select':
        var opts = (field.options || []).map(function(o) {
          return '<option value="' + escapeHtml(o.value) + '">' + escapeHtml(o.label) + '</option>';
        }).join('');
        input = '<select class="cfg-input" name="' + key + '"' + req + '>' + opts + '</select>';
        break;
      case 'headers':
        input = '<div data-role="kv-list">'
              + '<div class="cfg-headers-row">'
              +   '<input type="text" class="cfg-input" placeholder="name" />'
              +   '<input type="text" class="cfg-input" placeholder="value" />'
              +   '<button type="button" class="btn ghost" data-role="kv-add">+</button>'
              + '</div></div>'
              + '<input type="hidden" name="' + key + '" data-role="kv-json" value="{}"/>';
        break;
      case 'schedule':
        input = '<input type="text" class="cfg-input" name="' + key + '" placeholder="0 */15 * * *"'
              + def + ' pattern="[0-9*/, -]+"' + req + '/>';
        break;
      case 'oauth':
        input = '<button type="button" class="btn" data-role="oauth" data-key="' + key + '">Connect</button>'
              + '<input type="hidden" name="' + key + '" value="" data-role="oauth-value"/>';
        break;
      case 'json':
        input = '<textarea class="cfg-input" rows="4" name="' + key + '"' + req + '>'
              + (field.default ? escapeHtml(JSON.stringify(field.default, null, 2)) : '') + '</textarea>';
        break;
      case 'path':
      case 'text':
      default:
        input = '<input type="text" class="cfg-input" name="' + key + '"' + def + req + '/>';
    }
    const secretNote = field.secret ? '<div class="cfg-secret-note">stored encrypted; never echoed in API responses</div>' : '';
    return '<div class="cfg-field">'
      + '<label class="cfg-label" for="' + key + '">' + label + '</label>'
      + input
      + hint + secretNote
      + '</div>';
  }

  function formToConfig(form) {
    const out = {};
    new FormData(form).forEach(function(v, k) { out[k] = v; });
    return out;
  }

  function openBrick(id) {
    const schema = schemas[id] || [];
    const fields = schema.map(renderField).join('');
    const body =
        '<form class="cfg-form" data-role="cfg-form" data-id="' + escapeHtml(id) + '" onsubmit="return false;">'
        + (schema.length === 0
            ? '<div class="cfg-hint" style="padding:14px 0;">No config fields declared for this brick.</div>'
            : fields)
      + '</form>'
      + '<div class="inspector-status" data-role="inspector-status"></div>';
    const foot =
        '<button type="button" class="btn" data-role="test" data-id="' + escapeHtml(id) + '">Test connection</button>'
      + '<button type="button" class="btn primary" data-role="save" data-id="' + escapeHtml(id) + '">Save</button>';
    if (typeof window.openInspector === 'function') {
      window.openInspector('Brick · ' + id, body, foot);
    }
  }

  canvas.addEventListener('click', function(ev) {
    const tile = ev.target.closest('.brick-tile');
    if (tile) {
      ev.preventDefault();
      openBrick(tile.getAttribute('data-id'));
    }
  });

  // Inspector buttons are delegated on the document — the inspector panel
  // is part of the shell DOM, not this page's body.
  document.addEventListener('click', async function(ev) {
    const test = ev.target.closest('[data-role="test"]');
    const save = ev.target.closest('[data-role="save"]');
    if (!test && !save) return;
    ev.preventDefault();
    const id = (test || save).getAttribute('data-id');
    const status = document.querySelector('[data-role="inspector-status"]');
    if (status) { status.textContent = (test ? 'Testing…' : 'Saving…'); status.className = 'inspector-status'; }
    try {
      if (test) {
        const r = await fetch('/dashboard/bricks/' + encodeURIComponent(id) + '/test', { method: 'POST' });
        const data = await r.json();
        if (status) {
          status.textContent = (data.detail || data.kind || 'unknown');
          status.className = 'inspector-status ' + (r.ok && data.kind === 'ok' ? 'ok' : 'error');
        }
      } else {
        const form = document.querySelector('[data-role="cfg-form"]');
        const cfg = form ? formToConfig(form) : {};
        const r = await fetch('/dashboard/bricks/' + encodeURIComponent(id) + '/apply', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ config: cfg }),
        });
        const data = await r.json();
        if (status) {
          status.textContent = r.ok ? ('Saved — ' + (data.detail || 'ok')) : ('Failed: ' + (data.error || r.status));
          status.className = 'inspector-status ' + (r.ok ? 'ok' : 'error');
        }
      }
    } catch (err) {
      if (status) { status.textContent = 'Failed: ' + String(err); status.className = 'inspector-status error'; }
    }
  });

  // ---------- installer ----------
  const installerBtn = document.querySelector('[data-role="installer-go"]');
  const installerPath = document.querySelector('[data-role="installer-path"]');
  const installerStatus = document.querySelector('[data-role="installer-status"]');
  if (installerBtn && installerPath) {
    installerBtn.addEventListener('click', async function() {
      const path = installerPath.value.trim();
      if (!path) return;
      installerBtn.setAttribute('disabled', '');
      if (installerStatus) { installerStatus.textContent = 'Installing…'; installerStatus.className = 'installer-status'; }
      try {
        const r = await fetch('/dashboard/bricks/install', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ source_path: path }),
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
        if (installerStatus) {
          installerStatus.textContent = 'Installed ' + (data.brick && data.brick.id ? data.brick.id : 'brick');
          installerStatus.className = 'installer-status ok';
        }
        setTimeout(function() { window.location.reload(); }, 600);
      } catch (err) {
        if (installerStatus) {
          installerStatus.textContent = 'Failed: ' + String(err.message || err);
          installerStatus.className = 'installer-status error';
        }
      } finally {
        installerBtn.removeAttribute('disabled');
      }
    });
  }

  // ---------- deep-link hash → open inspector ----------
  if (location.hash) {
    const id = decodeURIComponent(location.hash.slice(1));
    if (schemas[id] !== undefined) openBrick(id);
  }
})();
`;

export function renderToolkitPage(data?: ToolkitData): string {
  const snapshot: ToolkitData = data ?? { bricks: [] };

  const above = snapshot.bricks.filter((b) => b.position === 'above');
  const below = snapshot.bricks.filter((b) => b.position === 'below');

  // Serialise schemas for the client.
  const schemaMap: Record<string, ConfigFieldSchema[]> = {};
  for (const b of snapshot.bricks) {
    // Strip out the "default" value for secret fields so a saved password
    // never leaks back into the rendered form's default state.
    schemaMap[b.id] = b.configSchema.map((f) => f.secret ? { ...f, default: undefined } : f);
  }

  const body = [
    `<div class="page-head">`,
    `<h1 class="page-title">Toolkit</h1>`,
    `<span class="page-sub">${snapshot.bricks.length} brick${snapshot.bricks.length === 1 ? '' : 's'} · ${above.length} external · ${below.length} internal</span>`,
    `</div>`,
    `<div class="toolkit-frame">`,
    `<div class="toolkit-canvas" data-role="toolkit-canvas">`,
    `<div class="brick-zone above" data-position="above" data-empty="No external bricks installed yet.">`,
    above.map(renderBrickTile).join(''),
    `</div>`,
    `<div class="bus"><span class="bus-label">enterprise bus · steward</span></div>`,
    `<div class="brick-zone below" data-position="below" data-empty="No internal bricks registered.">`,
    below.map(renderBrickTile).join(''),
    `</div>`,
    `</div>`,
    `<aside class="toolkit-side">`,
    `<h2 class="card-title">Install a brick</h2>`,
    `<div class="installer-row">`,
    `<input class="installer-input" data-role="installer-path" placeholder="/abs/path/to/brick or github URL" aria-label="Brick source path" />`,
    `<button type="button" class="btn primary" data-role="installer-go">Install</button>`,
    `<div class="installer-status" data-role="installer-status"></div>`,
    `</div>`,
    `<h2 class="card-title" style="margin-top:6px;">Colour key</h2>`,
    `<ul style="list-style:none;padding:0;margin:0;font-size:12px;display:flex;flex-direction:column;gap:6px;">`,
    `<li><span style="display:inline-block;width:10px;height:10px;background:var(--accent-ai-external);border-radius:2px;margin-right:6px;"></span> external AI</li>`,
    `<li><span style="display:inline-block;width:10px;height:10px;background:var(--accent-ai-internal);border-radius:2px;margin-right:6px;"></span> internal AI</li>`,
    `<li><span style="display:inline-block;width:10px;height:10px;background:var(--accent-mcp);border-radius:2px;margin-right:6px;"></span> MCP utility</li>`,
    `<li><span style="display:inline-block;width:10px;height:10px;background:var(--accent-connector-above);border-radius:2px;margin-right:6px;"></span> connector (above bus)</li>`,
    `<li><span style="display:inline-block;width:10px;height:10px;background:var(--accent-connector-below);border-radius:2px;margin-right:6px;"></span> connector (below bus)</li>`,
    `</ul>`,
    `</aside>`,
    `</div>`,
    `<script id="toolkit-schemas" type="application/json">${JSON.stringify(schemaMap)}</script>`,
  ].join('');

  return renderShell({
    title: 'Stavr — Toolkit',
    activePage: 'toolkit',
    body,
    head: `<style>${TOOLKIT_CSS}</style>`,
    script: TOOLKIT_JS,
  });
}
