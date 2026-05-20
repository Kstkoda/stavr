/**
 * Inspector — right-side floating panel that slides in when an item is
 * clicked. Renders a form from the item's `config_schema`. Owned by
 * Toolkit (brick config) and Topology (worker actions) for now.
 *
 * C1 lands the skeleton: empty panel HTML + open/close JS. Field
 * rendering per schema kind (password / oauth / url / select / headers /
 * schedule) is filled out in C7 (Toolkit).
 */

export function renderInspectorPanel(): string {
  return [
    `<aside id="inspector" class="inspector" aria-hidden="true" aria-label="Inspector panel">`,
    `<div class="inspector-head">`,
    `<div class="inspector-title" data-role="title">Inspector</div>`,
    `<button type="button" class="inspector-close" data-role="close" aria-label="Close inspector">×</button>`,
    `</div>`,
    `<div class="inspector-body" data-role="body">`,
    `<div class="inspector-empty">Select a brick or worker to inspect.</div>`,
    `</div>`,
    `<div class="inspector-foot" data-role="foot"></div>`,
    `</aside>`,
  ].join('');
}

export const INSPECTOR_CSS = `
.inspector {
  position: fixed;
  top: 56px;
  right: 0;
  bottom: 0;
  width: 380px;
  background: var(--bg-surface);
  border-left: 1px solid var(--border);
  display: grid;
  grid-template-rows: auto 1fr auto;
  transform: translateX(100%);
  transition: transform 0.18s ease;
  z-index: 50;
}
.inspector[data-open="true"] { transform: translateX(0); }
.inspector-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border);
}
.inspector-title {
  font-size: 13px;
  font-weight: 500;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--text-secondary);
}
.inspector-close {
  background: none;
  border: 0;
  color: var(--text-secondary);
  font-size: 22px;
  line-height: 1;
  cursor: pointer;
}
.inspector-close:hover { color: var(--text-primary); }
.inspector-body {
  overflow-y: auto;
  padding: 14px 18px;
}
.inspector-empty {
  color: var(--text-dim);
  font-size: 13px;
  font-style: italic;
}
.inspector-foot {
  border-top: 1px solid var(--border);
  padding: 12px 18px;
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
.inspector-foot:empty { display: none; }
`;

export const INSPECTOR_JS = `
(function() {
  const panel = document.getElementById('inspector');
  if (!panel) return;
  const close = panel.querySelector('[data-role="close"]');
  if (close) {
    close.addEventListener('click', function() {
      panel.setAttribute('aria-hidden', 'true');
      panel.removeAttribute('data-open');
    });
  }
  window.openInspector = function(title, bodyHtml, footHtml) {
    panel.querySelector('[data-role="title"]').textContent = title || 'Inspector';
    panel.querySelector('[data-role="body"]').innerHTML = bodyHtml || '';
    panel.querySelector('[data-role="foot"]').innerHTML = footHtml || '';
    panel.setAttribute('aria-hidden', 'false');
    panel.setAttribute('data-open', 'true');
  };
  window.closeInspector = function() {
    panel.setAttribute('aria-hidden', 'true');
    panel.removeAttribute('data-open');
  };
})();
`;
