/**
 * Floating inspector — single global popover used across Helm, Topology, and
 * any page that wants a click-to-inspect surface for a small entity (worker
 * dot, sys-chip, ribbon endpoint). Differs from the existing fixed-position
 * `Inspector` panel (right rail): this one is anchored to the click target
 * via `getBoundingClientRect`, glass-blurred, and dismisses on outside-click.
 *
 * Pages drive it imperatively via the `window.__stavrFloatingInspector` API
 * (see FLOATING_INSPECTOR_JS). Server-rendered content is escape-safe — the
 * caller passes a sections / actions object and the renderer composes the
 * markup.
 */

export interface FloatingInspectorSection {
  label: string;
  /** Plain text; the renderer escapes. Multi-line via \n. */
  value: string;
}

export interface FloatingInspectorAction {
  label: string;
  /** Inline JS expression executed on click (e.g. "location.href='/x'"). */
  onClick: string;
}

export interface FloatingInspectorPayload {
  icon: string; // emoji or single char
  title: string;
  sub?: string;
  sections: FloatingInspectorSection[];
  actions?: FloatingInspectorAction[];
}

export const FLOATING_INSPECTOR_CSS = `
.float-inspector {
  position: fixed;
  z-index: 80;
  min-width: 240px;
  max-width: 320px;
  background: var(--bg-popover);
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  padding: 12px 14px;
  color: var(--text-primary);
  font-size: 12px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.55), 0 0 0 1px var(--rust-glow);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  display: none;
}
.float-inspector[data-open="1"] { display: block; }
.float-inspector .fi-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.float-inspector .fi-icon {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  display: grid;
  place-items: center;
  background: var(--rust-glow);
  color: var(--text-primary);
  font-size: 14px;
  font-weight: 500;
}
.float-inspector .fi-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
}
.float-inspector .fi-sub {
  font-size: 11px;
  color: var(--text-secondary);
  margin-top: 1px;
}
.float-inspector .fi-section {
  display: grid;
  grid-template-columns: max-content 1fr;
  column-gap: 12px;
  row-gap: 4px;
  margin-top: 8px;
}
.float-inspector .fi-section dt {
  color: var(--text-secondary);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.float-inspector .fi-section dd {
  margin: 0;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 12px;
  color: var(--text-primary);
  white-space: pre-wrap;
  word-break: break-word;
}
.float-inspector .fi-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
}
.float-inspector .fi-action {
  border: 1px solid var(--border-strong);
  background: var(--bg-elevated);
  color: var(--text-primary);
  padding: 4px 10px;
  border-radius: 6px;
  font-size: 11px;
  cursor: pointer;
}
.float-inspector .fi-action:hover {
  border-color: var(--rust);
  color: var(--rust-soft);
}
`;

/**
 * Server-rendered shell. The pages embed an empty `<div>` once; the
 * client-side API mutates innerHTML when opening. This keeps the markup
 * footprint zero until a user actually clicks something.
 */
export function renderFloatingInspectorShell(): string {
  return '<div class="float-inspector" data-role="float-inspector" role="dialog" aria-modal="false" aria-hidden="true"></div>';
}

/**
 * Client-side API. Exposes:
 *   window.__stavrFloatingInspector.openAt(targetEl, payload)
 *   window.__stavrFloatingInspector.close()
 *
 * Positioning: anchored below-right of the target's bounding box, clamped
 * to viewport. Outside-click + Escape dismiss. Multiple opens on different
 * targets replace the content.
 */
export const FLOATING_INSPECTOR_JS = `
(function() {
  const root = document.querySelector('[data-role="float-inspector"]');
  if (!root) return;

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function render(payload) {
    const sections = (payload.sections || []).map(function(s) {
      return '<dt>' + esc(s.label) + '</dt><dd>' + esc(s.value) + '</dd>';
    }).join('');
    const actions = (payload.actions || []).map(function(a, i) {
      return '<button type="button" class="fi-action" data-fi-action="' + i + '">' + esc(a.label) + '</button>';
    }).join('');
    const sub = payload.sub ? '<div class="fi-sub">' + esc(payload.sub) + '</div>' : '';
    root.innerHTML =
      '<div class="fi-head">' +
        '<span class="fi-icon" aria-hidden="true">' + esc(payload.icon || '?') + '</span>' +
        '<div><div class="fi-title">' + esc(payload.title) + '</div>' + sub + '</div>' +
      '</div>' +
      '<dl class="fi-section">' + sections + '</dl>' +
      (actions ? '<div class="fi-actions">' + actions + '</div>' : '');
    if (payload.actions) {
      root.querySelectorAll('[data-fi-action]').forEach(function(btn) {
        const idx = Number(btn.getAttribute('data-fi-action'));
        const handler = payload.actions[idx] && payload.actions[idx].onClick;
        if (handler) {
          btn.addEventListener('click', function() {
            try { (new Function(handler))(); }
            catch (e) { /* swallow */ }
          });
        }
      });
    }
  }

  function position(targetEl) {
    const rect = targetEl.getBoundingClientRect();
    root.style.left = '0px';
    root.style.top = '0px';
    root.setAttribute('data-open', '1');
    root.setAttribute('aria-hidden', 'false');
    const popRect = root.getBoundingClientRect();
    let left = rect.right + 8;
    let top  = rect.top;
    if (left + popRect.width > window.innerWidth - 8) {
      left = Math.max(8, rect.left - popRect.width - 8);
    }
    if (top + popRect.height > window.innerHeight - 8) {
      top = Math.max(8, window.innerHeight - popRect.height - 8);
    }
    root.style.left = left + 'px';
    root.style.top  = top  + 'px';
  }

  function close() {
    root.removeAttribute('data-open');
    root.setAttribute('aria-hidden', 'true');
    root.innerHTML = '';
  }

  document.addEventListener('click', function(ev) {
    const target = ev.target;
    if (root.getAttribute('data-open') === '1' && !root.contains(target) && !target.closest('[data-fi-open]')) {
      close();
    }
  });
  document.addEventListener('keydown', function(ev) {
    if (ev.key === 'Escape') close();
  });

  window.__stavrFloatingInspector = {
    openAt: function(targetEl, payload) {
      render(payload);
      position(targetEl);
    },
    close: close,
  };
})();
`;
