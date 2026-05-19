/**
 * src/dashboard/widgets/topology-particle-inspector.ts
 *
 * v0.6.10 Task 4c — Decision 4 instruction-flow visualization, layer 3.
 *
 * Click any flow particle (Task 4b's `.tp-dot`) and a side inspector
 * slides in from the right showing forensic detail about the event:
 *
 *   - source_agent (full string, copy-on-click)
 *   - signed_by    (v0.7 passkey placeholder — "unsigned — v0.7…")
 *   - correlation_id (truncated, copy affordance)
 *   - payload      (JSON, collapsed by default for large blobs)
 *   - at           (ISO + relative "3s ago" renderer)
 *   - cross-link   ("View in event log" → /dashboard/events?correlation_id=)
 *
 * Lifecycle:
 *   - Particles fade ~3s after arrival (Task 4b). The inspector lifts
 *     the particle's frozen data-* snapshot at click time, so it
 *     remains inspectable for as long as the drawer stays open.
 *   - Closing the drawer doesn't dispose the snapshot; reopening
 *     restores the last-viewed particle until a new click arrives.
 *
 * Sits on the OPPOSITE edge of the canvas from the existing palette-door
 * FAB and inspector drawer, per the dispatch direction ("right side of
 * Topology page, similar pattern to existing palette-door FAB but on
 * the opposite edge"). The existing topo-drawer slides in from the
 * right too, so we share the slide-in chassis but use a distinct
 * data-role + animation track to avoid collision.
 */

export function renderParticleInspector(): string {
  return [
    `<aside class="topo-particle-inspector" data-role="topo-particle-inspector" aria-hidden="true">`,
    `<header class="tpi-head">`,
    `<div class="tpi-mark" data-role="tpi-mark"><span class="tpi-glyph" data-role="tpi-glyph"></span></div>`,
    `<div class="tpi-id">`,
    `<div class="tpi-row1">`,
    `<span class="tpi-kind" data-role="tpi-kind">—</span>`,
    `<span class="tpi-class" data-role="tpi-class">—</span>`,
    `</div>`,
    `<div class="tpi-row2" data-role="tpi-when">—</div>`,
    `</div>`,
    `<button type="button" class="tpi-close" data-role="tpi-close" aria-label="Close inspector">×</button>`,
    `</header>`,
    `<div class="tpi-body">`,
    `<section class="tpi-field">`,
    `<div class="tpi-k">source_agent</div>`,
    `<div class="tpi-v" data-role="tpi-source-agent" data-copy>—</div>`,
    `</section>`,
    `<section class="tpi-field">`,
    `<div class="tpi-k">signed_by</div>`,
    `<div class="tpi-v tpi-placeholder" data-role="tpi-signed-by">(unsigned — v0.7 will add operator passkey signature here)</div>`,
    `</section>`,
    `<section class="tpi-field">`,
    `<div class="tpi-k">correlation_id</div>`,
    `<div class="tpi-v" data-role="tpi-corr" data-copy>—</div>`,
    `</section>`,
    `<section class="tpi-field tpi-payload-field">`,
    `<div class="tpi-k">payload</div>`,
    `<details class="tpi-payload">`,
    `<summary>expand</summary>`,
    `<pre class="tpi-payload-pre" data-role="tpi-payload">{}</pre>`,
    `</details>`,
    `</section>`,
    `<a class="tpi-deeplink" data-role="tpi-eventlog" href="/dashboard/events">View in event log →</a>`,
    `</div>`,
    `</aside>`,
  ].join('');
}

export const TOPOLOGY_PARTICLE_INSPECTOR_CSS = `
.tp-dot { cursor: pointer; pointer-events: auto; }
.topo-particles { pointer-events: none; }
.topo-particles .tp-dot { pointer-events: auto; }

.topo-particle-inspector {
  position: fixed;
  top: 70px; bottom: 18px; right: -480px;
  width: 380px; max-width: 92vw;
  background: linear-gradient(180deg, rgba(20,22,31,.96), rgba(15,16,24,.96));
  border: 1px solid var(--line-2);
  border-radius: 14px;
  backdrop-filter: blur(28px);
  -webkit-backdrop-filter: blur(28px);
  box-shadow: -18px 0 44px rgba(0,0,0,.55);
  display: flex; flex-direction: column;
  overflow: hidden;
  transition: right .25s cubic-bezier(.2,.7,.2,1);
  z-index: 95;
  font-family: var(--mono);
}
.topo-particle-inspector[data-open="true"] { right: 18px; }
.tpi-head {
  display: flex; gap: 10px; align-items: center;
  padding: 12px 14px;
  border-bottom: 1px solid var(--line);
}
.tpi-mark {
  width: 32px; height: 32px;
  display: grid; place-items: center;
  background: var(--surface-2);
  color: var(--actor-default);
  border-radius: 9px;
  border: 1px solid currentColor;
}
.topo-particle-inspector[data-actor-class="operator"] .tpi-mark { color: var(--actor-operator); }
.topo-particle-inspector[data-actor-class="cc"]       .tpi-mark { color: var(--actor-cc); }
.topo-particle-inspector[data-actor-class="cowork"]   .tpi-mark { color: var(--actor-cowork); }
.topo-particle-inspector[data-actor-class="peer"]     .tpi-mark { color: var(--actor-peer); }
.tpi-glyph svg { width: 18px; height: 18px; }
.tpi-id { flex: 1; min-width: 0; }
.tpi-row1 { display: flex; gap: 8px; align-items: center; font-size: 12px; color: var(--ink-0); }
.tpi-class {
  font-size: 9.5px;
  padding: 1px 7px; border-radius: 999px;
  background: var(--surface-2); color: var(--ink-1);
  border: 1px solid var(--line-2);
  letter-spacing: .04em; text-transform: uppercase;
}
.tpi-row2 { font-size: 10.5px; color: var(--ink-3); margin-top: 3px; }
.tpi-close {
  background: transparent; color: var(--ink-2);
  border: 1px solid var(--line-2);
  width: 26px; height: 26px; border-radius: 6px;
  font-size: 14px; cursor: pointer;
}
.tpi-body { flex: 1; overflow: auto; padding: 12px 14px; }
.tpi-field { margin-bottom: 12px; }
.tpi-k {
  font-size: 9.5px;
  letter-spacing: .12em; text-transform: uppercase;
  color: var(--ink-3); margin-bottom: 4px;
}
.tpi-v {
  font-size: 11.5px; color: var(--ink-1);
  word-break: break-all;
  padding: 5px 8px;
  background: var(--bg-0, rgba(0,0,0,0.2));
  border: 1px solid var(--line);
  border-radius: 6px;
}
.tpi-v[data-copy] { cursor: pointer; transition: background .12s ease; }
.tpi-v[data-copy]:hover { background: rgba(184,84,42,0.10); }
.tpi-v.tpi-placeholder { color: var(--ink-3); font-style: italic; }
.tpi-payload { font-size: 11px; color: var(--ink-2); }
.tpi-payload summary {
  cursor: pointer; padding: 4px 0;
  color: var(--ink-2); letter-spacing: .04em;
}
.tpi-payload-pre {
  background: var(--bg-0, rgba(0,0,0,0.25));
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 8px 10px; margin: 4px 0 0 0;
  font-size: 10.5px; color: var(--ink-1);
  white-space: pre-wrap; word-break: break-all;
  max-height: 280px; overflow: auto;
}
.tpi-deeplink {
  display: inline-block;
  margin-top: 6px;
  font-size: 11px;
  color: var(--sky);
  text-decoration: none;
}
.tpi-deeplink:hover { text-decoration: underline; }
`;

export const TOPOLOGY_PARTICLE_INSPECTOR_JS = `
(function() {
  const inspector = document.querySelector('[data-role="topo-particle-inspector"]');
  if (!inspector) return;
  const layer = document.querySelector('[data-role="topo-particles"]');
  if (!layer) return;

  const kindEl   = inspector.querySelector('[data-role="tpi-kind"]');
  const classEl  = inspector.querySelector('[data-role="tpi-class"]');
  const whenEl   = inspector.querySelector('[data-role="tpi-when"]');
  const sourceEl = inspector.querySelector('[data-role="tpi-source-agent"]');
  const corrEl   = inspector.querySelector('[data-role="tpi-corr"]');
  const payloadEl = inspector.querySelector('[data-role="tpi-payload"]');
  const eventlogEl = inspector.querySelector('[data-role="tpi-eventlog"]');
  const glyphEl  = inspector.querySelector('[data-role="tpi-glyph"]');
  const closeEl  = inspector.querySelector('[data-role="tpi-close"]');

  function relative(at) {
    const t = Date.parse(at);
    if (!Number.isFinite(t)) return '';
    const delta = Date.now() - t;
    if (delta < 1500) return 'just now';
    if (delta < 60_000) return Math.round(delta / 1000) + 's ago';
    if (delta < 3_600_000) return Math.round(delta / 60_000) + 'm ago';
    if (delta < 86_400_000) return Math.round(delta / 3_600_000) + 'h ago';
    return at;
  }

  function prettyPayload(s) {
    try {
      const v = JSON.parse(s || '{}');
      return JSON.stringify(v, null, 2);
    } catch (_) {
      return String(s || '');
    }
  }

  function showFor(dot) {
    if (!dot) return;
    const actorClass = dot.getAttribute('data-actor-class') || 'default';
    const kind = dot.getAttribute('data-kind') || '—';
    const source = dot.getAttribute('data-source-agent') || '—';
    const corr = dot.getAttribute('data-correlation-id') || '';
    const at = dot.getAttribute('data-at') || new Date().toISOString();
    const payload = dot.getAttribute('data-payload') || '{}';

    inspector.setAttribute('data-actor-class', actorClass);
    kindEl.textContent = kind;
    classEl.textContent = actorClass;
    whenEl.textContent = at + '  (' + relative(at) + ')';
    sourceEl.textContent = source;
    corrEl.textContent = corr ? (corr.length > 28 ? corr.slice(0, 26) + '…' : corr) : '(none)';
    corrEl.setAttribute('data-full', corr);
    payloadEl.textContent = prettyPayload(payload);
    if (eventlogEl) {
      const href = corr ? '/dashboard/events?correlation_id=' + encodeURIComponent(corr) : '/dashboard/events';
      eventlogEl.setAttribute('href', href);
    }
    // Lift the icon glyph for the inspector mark from the source dot.
    glyphEl.innerHTML = dot.innerHTML;

    inspector.setAttribute('data-open', 'true');
    inspector.setAttribute('aria-hidden', 'false');
  }

  function hide() {
    inspector.removeAttribute('data-open');
    inspector.setAttribute('aria-hidden', 'true');
  }

  // Event delegation — particles come and go, hooking the layer keeps
  // the listener count constant.
  layer.addEventListener('click', function(ev) {
    const dot = ev.target.closest && ev.target.closest('.tp-dot');
    if (!dot) return;
    showFor(dot);
  });
  closeEl.addEventListener('click', hide);

  // Copy-on-click for source_agent + correlation_id chips.
  inspector.querySelectorAll('[data-copy]').forEach(function(el) {
    el.addEventListener('click', function() {
      const text = el.getAttribute('data-full') || el.textContent || '';
      if (!text) return;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text);
          const original = el.style.background;
          el.style.background = 'rgba(184,84,42,0.25)';
          setTimeout(function() { el.style.background = original; }, 300);
        }
      } catch (_) { /* no-clipboard fallback: no-op */ }
    });
  });

  // Esc closes the drawer (matches the existing topo-drawer behavior).
  document.addEventListener('keydown', function(ev) {
    if (ev.key === 'Escape' && inspector.getAttribute('data-open') === 'true') hide();
  });
})();
`;
