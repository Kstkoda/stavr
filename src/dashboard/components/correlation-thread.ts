/**
 * Correlation thread component. Lives alongside the history drawer
 * (P3) and reuses its shell + close affordances; the difference is the
 * body content (rendered server-side via renderTraceHtml in the
 * walker module) and the "Switch direction" header button.
 *
 * The CSS adds tree-row styling for the trace-list emitted by
 * renderTraceHtml. The trace-origin row gets a halo so the operator
 * can spot where they started.
 */
export const CORRELATION_THREAD_CSS = `
.trace-list {
  list-style: none;
  margin: 8px 0 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.trace-node {
  display: grid;
  grid-template-columns: 60px 90px 1fr auto;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 6px;
  background: rgba(255,255,255,0.02);
  border: 1px solid var(--line);
}
.trace-node.trace-origin {
  background: var(--rust-soft);
  border-color: rgba(184, 84, 42, 0.5);
}
.trace-time {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--ink-3);
  font-variant-numeric: tabular-nums;
}
.trace-kind {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--ink-3);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.trace-title {
  color: var(--ink-0);
  font-size: 12.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.trace-actor {
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--ink-2);
}
.trace-switch {
  background: transparent;
  border: 1px solid var(--line-2);
  color: var(--ink-2);
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 4px;
  cursor: pointer;
  margin-left: 8px;
}
.trace-switch:hover { color: var(--ink-0); border-color: var(--line); }
`;

/**
 * Extra drawer JS — wires the trace-button to the trace endpoint and
 * the "Switch direction" header button. Loaded alongside HISTORY_DRAWER_JS;
 * relies on `window.__historyDrawer` being already initialised.
 */
export const CORRELATION_THREAD_JS = `
(function() {
  if (!window.__historyDrawer) return;
  const drawer = document.querySelector('[data-role="history-drawer"]');
  const title = drawer.querySelector('[data-role="history-drawer-title"]');
  const body  = drawer.querySelector('[data-role="history-drawer-body"]');
  const head  = drawer.querySelector('.hist-drawer-head');

  let currentTrace = null;

  function openTrace(kind, id, direction) {
    currentTrace = { kind: kind, id: id, direction: direction };
    title.textContent = 'TRACE · ' + kind + ' · ' + id;
    body.innerHTML = '<p class="hist-drawer-loading">Walking correlation…</p>';
    drawer.removeAttribute('hidden');
    drawer.setAttribute('aria-hidden', 'false');
    fetch('/dashboard/api/history/' + encodeURIComponent(kind) + '/' + encodeURIComponent(id) + '/trace?direction=' + encodeURIComponent(direction))
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) {
        if (!data) { body.innerHTML = '<p class="hist-drawer-missing">Trace unavailable.</p>'; return; }
        let switchBtn = head.querySelector('[data-role="trace-switch"]');
        if (!switchBtn) {
          switchBtn = document.createElement('button');
          switchBtn.type = 'button';
          switchBtn.className = 'trace-switch';
          switchBtn.setAttribute('data-role', 'trace-switch');
          switchBtn.addEventListener('click', function() {
            if (!currentTrace) return;
            const nextDir = currentTrace.direction === 'forward' ? 'backward' : 'forward';
            openTrace(currentTrace.kind, currentTrace.id, nextDir);
          });
          head.insertBefore(switchBtn, head.lastElementChild);
        }
        switchBtn.textContent = data.direction === 'forward' ? 'Switch ← backward' : 'Switch → forward';
        body.innerHTML = data.html;
      })
      .catch(function() { body.innerHTML = '<p class="hist-drawer-missing">Network error.</p>'; });
  }

  // Re-bind the trace button so it opens the trace drawer (overriding the
  // P3 fallback that opened the detail drawer).
  document.addEventListener('click', function(ev) {
    const btn = ev.target.closest('[data-role="open-trace"]');
    if (!btn) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    const kind = btn.getAttribute('data-kind');
    const id = btn.getAttribute('data-id');
    if (!kind || !id) return;
    const defaultDir = kind === 'notification' ? 'backward' : 'forward';
    openTrace(kind, id, defaultDir);
  }, true);

  // Trace-depth chip hover loads the hop count for that row.
  document.addEventListener('mouseenter', function(ev) {
    const chip = ev.target && ev.target.closest && ev.target.closest('[data-role="trace-depth"]');
    if (!chip || chip.dataset.loaded === 'true') return;
    const row = chip.closest('[data-role="history-row"]');
    if (!row) return;
    const kind = row.getAttribute('data-kind');
    const id = row.getAttribute('data-id');
    const dir = kind === 'notification' ? 'backward' : 'forward';
    chip.dataset.loaded = 'true';
    fetch('/dashboard/api/history/' + encodeURIComponent(kind) + '/' + encodeURIComponent(id) + '/trace?direction=' + dir)
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) {
        if (!data) return;
        chip.textContent = '↩ ' + data.hop_depth + ' hop' + (data.hop_depth === 1 ? '' : 's');
      })
      .catch(function() {});
  }, true);
})();
`;
