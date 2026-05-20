/**
 * Capture ⊕ button — floating bottom-right action. Click opens a small
 * modal with: comment textarea, type radio (bug/feature/investigate/todo),
 * priority radio, and a Send-to-Steward submit. The snapshot is built
 * client-side from the current page state + a fresh `/healthz` + `/metrics`
 * scrape, then POSTed to `/dashboard/capture`. The daemon writes
 * `~/.stavr/captures/<type>.jsonl` and emits a `capture_filed` audit event.
 */

export const CAPTURE_BUTTON_CSS = `
.capture-fab {
  position: fixed;
  right: 22px;
  bottom: 60px; /* clears the smooth timeline */
  z-index: 60;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--rust), var(--rust-soft));
  color: #fff8f0;
  border: 1px solid var(--rust);
  box-shadow: 0 6px 16px var(--rust-glow), 0 0 0 1px rgba(0,0,0,0.4);
  font-size: 22px;
  font-weight: 500;
  cursor: pointer;
  display: grid;
  place-items: center;
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}
.capture-fab:hover {
  transform: translateY(-2px) scale(1.03);
  box-shadow: 0 8px 24px var(--rust-glow);
}
.capture-fab:focus { outline: 2px solid var(--rust-soft); outline-offset: 3px; }

.capture-modal {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(4px);
  z-index: 90;
  display: none;
  align-items: center;
  justify-content: center;
}
.capture-modal[data-open="1"] { display: flex; }
.capture-card {
  width: min(440px, 92vw);
  background: var(--bg-surface);
  border: 1px solid var(--border-strong);
  border-radius: 12px;
  padding: 18px;
  box-shadow: 0 12px 40px rgba(0,0,0,0.55);
}
.capture-card h2 {
  margin: 0 0 8px;
  font-size: 14px;
  letter-spacing: 0.04em;
}
.capture-card textarea {
  width: 100%;
  min-height: 92px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  color: var(--text-primary);
  border-radius: 6px;
  padding: 8px 10px;
  font-family: inherit;
  font-size: 13px;
  resize: vertical;
  margin-bottom: 10px;
}
.capture-radios {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 4px 0 12px;
}
.capture-radio {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  color: var(--text-secondary);
  font-size: 11px;
  cursor: pointer;
}
.capture-radio input { display: none; }
.capture-radio[data-checked="1"] {
  border-color: var(--rust);
  color: var(--rust-soft);
}
.capture-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 8px;
}
.capture-action {
  padding: 6px 14px;
  border-radius: 6px;
  border: 1px solid var(--border-strong);
  background: var(--bg-elevated);
  color: var(--text-primary);
  font-size: 12px;
  cursor: pointer;
}
.capture-action.primary {
  border-color: var(--rust);
  background: var(--rust-glow);
  color: var(--text-primary);
}
.capture-status {
  font-size: 11px;
  color: var(--text-dim);
  min-height: 14px;
  margin-top: 6px;
}
`;

export function renderCaptureButton(): string {
  return [
    '<button type="button" class="capture-fab" data-role="capture-fab"',
    ' aria-label="Capture this — send to Steward" title="Capture ⊕">⊕</button>',
    '<div class="capture-modal" data-role="capture-modal" aria-hidden="true">',
    '<div class="capture-card" role="dialog" aria-modal="true" aria-labelledby="capture-title">',
    '<h2 id="capture-title">Capture this</h2>',
    '<textarea data-role="capture-comment" placeholder="What did you notice?"></textarea>',
    '<div class="capture-radios" data-role="capture-type" role="radiogroup" aria-label="Type">',
    '<label class="capture-radio" data-checked="1"><input type="radio" name="cap-type" value="bug" checked /> bug</label>',
    '<label class="capture-radio"                ><input type="radio" name="cap-type" value="feature" /> feature</label>',
    '<label class="capture-radio"                ><input type="radio" name="cap-type" value="investigate" /> investigate</label>',
    '<label class="capture-radio"                ><input type="radio" name="cap-type" value="todo" /> todo</label>',
    '</div>',
    '<div class="capture-radios" data-role="capture-priority" role="radiogroup" aria-label="Priority">',
    '<label class="capture-radio"               ><input type="radio" name="cap-priority" value="low" /> low</label>',
    '<label class="capture-radio" data-checked="1"><input type="radio" name="cap-priority" value="normal" checked /> normal</label>',
    '<label class="capture-radio"               ><input type="radio" name="cap-priority" value="high" /> high</label>',
    '</div>',
    '<div class="capture-actions">',
    '<button type="button" class="capture-action" data-role="capture-cancel">Cancel</button>',
    '<button type="button" class="capture-action primary" data-role="capture-send">Send to Steward</button>',
    '</div>',
    '<div class="capture-status" data-role="capture-status"></div>',
    '</div>',
    '</div>',
  ].join('');
}

export const CAPTURE_BUTTON_JS = `
(function() {
  const fab     = document.querySelector('[data-role="capture-fab"]');
  const modal   = document.querySelector('[data-role="capture-modal"]');
  const comment = document.querySelector('[data-role="capture-comment"]');
  const status  = document.querySelector('[data-role="capture-status"]');
  if (!fab || !modal) return;

  function openModal() {
    modal.setAttribute('data-open', '1');
    modal.setAttribute('aria-hidden', 'false');
    if (status) status.textContent = '';
    if (comment) comment.focus();
  }
  function closeModal() {
    modal.removeAttribute('data-open');
    modal.setAttribute('aria-hidden', 'true');
  }
  fab.addEventListener('click', openModal);
  modal.addEventListener('click', function(ev) {
    if (ev.target === modal) closeModal();
  });
  document.addEventListener('keydown', function(ev) {
    if (ev.key === 'Escape' && modal.getAttribute('data-open') === '1') closeModal();
  });
  document.querySelectorAll('[data-role="capture-cancel"]').forEach(function(b) {
    b.addEventListener('click', closeModal);
  });

  // Radio chip styling
  document.querySelectorAll('.capture-radios').forEach(function(group) {
    group.addEventListener('change', function() {
      group.querySelectorAll('.capture-radio').forEach(function(label) {
        const inp = label.querySelector('input');
        label.setAttribute('data-checked', inp && inp.checked ? '1' : '0');
      });
    });
  });

  async function gatherSnapshot() {
    const out = {
      page: document.body.getAttribute('data-active-page') || 'unknown',
      url:  location.href,
      in_flight_bom_ids: [],
      recent_event_kinds: [],
      daemon_health: { ok: true },
    };
    try {
      const r = await fetch('/healthz');
      out.daemon_health.ok = r.ok;
    } catch (_) { out.daemon_health.ok = false; }
    try {
      const r = await fetch('/metrics');
      if (r.ok) {
        const text = await r.text();
        const rss = text.match(/^process_resident_memory_bytes\\s+(\\S+)/m);
        if (rss) out.daemon_health.rss_mb = Math.round(Number(rss[1]) / (1024 * 1024));
        const p99 = text.match(/^nodejs_eventloop_lag_p99_seconds\\s+(\\S+)/m);
        if (p99) out.daemon_health.eventloop_lag_p99_ms = Math.round(Number(p99[1]) * 1000);
      }
    } catch (_) { /* swallow */ }
    return out;
  }

  document.querySelectorAll('[data-role="capture-send"]').forEach(function(b) {
    b.addEventListener('click', async function() {
      const text = (comment && comment.value || '').trim();
      if (!text) { if (status) { status.textContent = 'Comment is required.'; } return; }
      const type = (document.querySelector('[data-role="capture-type"] input:checked') || {}).value || 'bug';
      const priority = (document.querySelector('[data-role="capture-priority"] input:checked') || {}).value || 'normal';
      if (status) status.textContent = 'Sending…';
      try {
        const snapshot = await gatherSnapshot();
        const r = await fetch('/dashboard/capture', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ comment: text, type: type, priority: priority, snapshot: snapshot }),
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        if (status) status.textContent = 'Filed · ' + j.id + ' → ' + j.destination;
        if (comment) comment.value = '';
        setTimeout(closeModal, 1000);
      } catch (err) {
        if (status) status.textContent = 'Failed: ' + err.message;
      }
    });
  });
})();
`;
