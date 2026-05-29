/**
 * src/dashboard/widgets/topology-flow-particles.ts
 *
 * v0.6.10 Task 4b — Decision 4 instruction-flow visualization, layer 2.
 *
 * Particles flow along edges between actor-nodes and stavR-internals.
 * Each particle:
 *   - Color encodes source class (operator/cc/cowork/peer/default), via
 *     the --actor-* tokens already in tokens.ts.
 *   - Icon embedded as a small inline SVG glyph inside the dot —
 *     person (operator), bot (cc), chat-bubble (cowork), globe (peer),
 *     clock (default switch-fallback).
 *   - Direction: source-actor → target-resource.
 *   - Speed: constant (the heatmap timeline already encodes density).
 *   - Lifetime: ~3 seconds, then a fade-out class adds 400ms of decay.
 *
 * Stream:
 *   - Driven by SSE `/dashboard/stream` events. Every event with a
 *     `source_agent` field emits at most one particle.
 *   - Filters: operator-visible kinds only. Specifically, skip
 *     `progress`, `tool_called` for `routine`-class sensitivity; those
 *     are too noisy on this view (the timeline gets the density).
 *
 * Performance:
 *   - Cap concurrent particles at 200; FIFO eviction.
 *   - requestAnimationFrame (rAF) drives a single animation loop for
 *     all particles. No per-particle setInterval.
 *   - CSS transform translate3d — GPU-composited path; no per-frame
 *     reflow.
 */

/**
 * Inline glyph SVGs for the five actor classes. Tiny so they read at
 * the 8-10px particle size; tokens.ts colors them via `currentColor`.
 */
export const ACTOR_ICON_SVGS: Record<string, string> = {
  operator:
    '<svg viewBox="0 0 12 12" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<circle cx="6" cy="3.4" r="1.7" fill="currentColor"/>' +
    '<path d="M2.5 10.5c.6-1.8 2-2.7 3.5-2.7s2.9.9 3.5 2.7" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round"/>' +
    '</svg>',
  cc:
    '<svg viewBox="0 0 12 12" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<rect x="2.2" y="3" width="7.6" height="5.5" rx="1.4" fill="currentColor" opacity=".85"/>' +
    '<circle cx="4.5" cy="5.6" r=".7" fill="#0b0c12"/>' +
    '<circle cx="7.5" cy="5.6" r=".7" fill="#0b0c12"/>' +
    '<line x1="6" y1="1.6" x2="6" y2="2.8" stroke="currentColor" stroke-width="1"/>' +
    '<circle cx="6" cy="1.4" r=".7" fill="currentColor"/>' +
    '</svg>',
  cowork:
    '<svg viewBox="0 0 12 12" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<path d="M2 3.6c0-.9.7-1.6 1.6-1.6h4.8c.9 0 1.6.7 1.6 1.6v3.4c0 .9-.7 1.6-1.6 1.6H6L3.2 10.4V8.6h-.6c-.3 0-.6-.3-.6-.6Z" fill="currentColor"/>' +
    '</svg>',
  peer:
    '<svg viewBox="0 0 12 12" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<circle cx="6" cy="6" r="4.4" fill="none" stroke="currentColor" stroke-width="1.1"/>' +
    '<path d="M1.6 6h8.8M6 1.6c1.8 2.2 1.8 6.6 0 8.8M6 1.6c-1.8 2.2-1.8 6.6 0 8.8" fill="none" stroke="currentColor" stroke-width=".9"/>' +
    '</svg>',
  default:
    '<svg viewBox="0 0 12 12" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<circle cx="6" cy="6" r="4.4" fill="none" stroke="currentColor" stroke-width="1.1"/>' +
    '<path d="M6 3.5v3l2 1.4" stroke="currentColor" stroke-width="1.1" fill="none" stroke-linecap="round"/>' +
    '</svg>',
};

/**
 * Configuration knobs the page JS reads via data-* attributes on the
 * mount container so they're tweakable without a recompile.
 */
export const FLOW_PARTICLE_CONFIG = {
  /** Concurrent particle cap (FIFO eviction beyond this). */
  maxConcurrent: 200,
  /** Travel duration along the edge, milliseconds. */
  travelMs: 1800,
  /** Post-arrival fade duration. */
  fadeMs: 400,
  /** Event kinds suppressed in routine view (too noisy). */
  noisyKinds: ['progress', 'tool_called'] as readonly string[],
};

/**
 * Render the SVG container for in-flight particles. The page JS picks
 * this up via data-role="topo-particles" and appends/evicts particles
 * inside it. Sits underneath the node layer (z-index between the SVG
 * edge layer and the node DOM) so particles read as flowing under the
 * nodes.
 */
export function renderFlowParticleSurface(): string {
  return [
    `<div class="topo-particles" data-role="topo-particles" aria-hidden="true">`,
    `<!-- particles injected at runtime; each: <span class="tp-dot" style="..."> -->`,
    `</div>`,
  ].join('');
}

export const TOPOLOGY_FLOW_PARTICLES_CSS = `
.topo-particles {
  position: absolute; inset: 0;
  pointer-events: none;
  z-index: 3;
  overflow: hidden;
}
.tp-dot {
  position: absolute;
  width: 14px; height: 14px;
  left: 0; top: 0;
  display: grid; place-items: center;
  border-radius: 50%;
  background:
    radial-gradient(circle at 35% 30%, rgba(255,255,255,0.85), rgba(255,255,255,0.05) 60%),
    currentColor;
  box-shadow: 0 0 8px currentColor;
  transform: translate3d(0,0,0);
  transition: opacity ${FLOW_PARTICLE_CONFIG.fadeMs}ms ease-out;
  will-change: transform, opacity;
}
.tp-dot[data-actor-class="operator"] { color: var(--actor-operator); }
.tp-dot[data-actor-class="cc"]       { color: var(--actor-cc); }
.tp-dot[data-actor-class="cowork"]   { color: var(--actor-cowork); }
.tp-dot[data-actor-class="peer"]     { color: var(--actor-peer); }
.tp-dot[data-actor-class="default"]  { color: var(--actor-default); }
.tp-dot.fading { opacity: 0; }
.tp-dot svg {
  width: 9px; height: 9px;
  color: #0a0b10;
}
/* When LIVE is paused, freeze particles in place rather than letting
   them fly off; matches the existing edge-flow stop behavior. */
.topo-canvas[data-live="off"] .topo-particles { display: none; }
`;

export const TOPOLOGY_FLOW_PARTICLES_JS = `
(function() {
  const canvas = document.querySelector('[data-role="topo-canvas"]');
  if (!canvas) return;
  const layer = canvas.querySelector('[data-role="topo-particles"]');
  const stage = canvas.querySelector('.topo-stage');
  if (!layer || !stage) return;

  const CONFIG = ${JSON.stringify(FLOW_PARTICLE_CONFIG)};
  const ICONS = ${JSON.stringify(ACTOR_ICON_SVGS)};

  const live = [];
  let raf = null;

  // ---------- actor-class derivation from source_agent ----------
  // Mirrors classifyActor() in topology-actor-nodes.ts. Inlined here
  // so the client doesn't have to bundle the TS function.
  function classifyClass(agent) {
    if (!agent) return null;
    const s = String(agent).toLowerCase();
    if (s.indexOf('operator') >= 0) return 'operator';
    if (s.indexOf('cowork') >= 0) return 'cowork';
    if (s.indexOf('claude-code') >= 0 || s.indexOf('cc-') === 0 || s === 'cc') return 'cc';
    if (s.indexOf('peer-') === 0 || s.indexOf('stavr-peer') >= 0 || s.indexOf('federated') >= 0) return 'peer';
    return 'default';
  }

  // ---------- locate source + target nodes ----------
  function findActorNode(agent) {
    if (!agent) return null;
    // Prefer the exact source_agent match the page injected as data-* on
    // the actor-node; fall back to the first actor-node of the right
    // class so we still draw flow even for an unbinned agent.
    const exact = canvas.querySelector('.gnode[data-type="actor"][data-id="actor-' + classifyClass(agent) + '-' + cssEscape(String(agent)) + '"]');
    if (exact) return exact;
    const cls = classifyClass(agent);
    if (!cls) return null;
    return canvas.querySelector('.gnode[data-type="actor"][data-actor-class="' + cls + '"]');
  }
  function findTargetNode(evt) {
    // Job events go to the job (worker-typed) node; tool calls go to the
    // matching MCP-category node; everything else lands on the core.
    // payload.job_id is the new job_log slot; payload.worker_id still
    // populated by dual-emit during the deprecation window.
    const pid = (evt.payload && (evt.payload.id || evt.payload.job_id || evt.payload.worker_id)) || evt.correlation_id;
    if (pid) {
      const w = canvas.querySelector('.gnode[data-id="' + cssEscape(String(pid)) + '"]');
      if (w) return w;
    }
    const k = String(evt.kind || '');
    if (k.indexOf('tool_') === 0 || k.indexOf('mcp_') === 0) {
      const m = canvas.querySelector('.gnode[data-type="mcp-local"]');
      if (m) return m;
    }
    return canvas.querySelector('.gnode.core') || canvas.querySelector('.gnode[data-id="stavr-core"]');
  }
  function cssEscape(s) {
    // Minimal CSS.escape polyfill for older browsers — only the chars
    // that appear in our generated ids matter.
    return String(s).replace(/[^a-zA-Z0-9_-]/g, function(c) { return '\\\\' + c; });
  }

  // ---------- particle emission ----------
  function nodePosCenter(el) {
    return {
      x: parseFloat(el.style.left) || 0,
      y: parseFloat(el.style.top) || 0,
    };
  }
  function viewboxToPixel(p) {
    // Stage uses px coords already (left/top from layoutGraph), so we
    // can read them directly. Convert stage-px → canvas-relative px by
    // composing with the stage's bounding rect — but since particles
    // are absolutely positioned inside the same stage, the same px
    // coords work directly.
    return p;
  }

  function emit(evt) {
    if (!evt || !evt.source_agent) return;
    const cls = classifyClass(evt.source_agent);
    if (!cls) return;
    if (CONFIG.noisyKinds.indexOf(String(evt.kind || '')) >= 0) return;
    const src = findActorNode(evt.source_agent);
    const dst = findTargetNode(evt);
    if (!src || !dst) return;

    const a = viewboxToPixel(nodePosCenter(src));
    const b = viewboxToPixel(nodePosCenter(dst));
    const dot = document.createElement('span');
    dot.className = 'tp-dot';
    dot.setAttribute('data-actor-class', cls);
    dot.setAttribute('data-correlation-id', evt.correlation_id || '');
    dot.setAttribute('data-kind', String(evt.kind || ''));
    dot.setAttribute('data-source-agent', String(evt.source_agent || ''));
    dot.setAttribute('data-at', String(evt.at || new Date().toISOString()));
    // Stash payload for the click-inspector (Task 4c).
    try {
      dot.setAttribute('data-payload', JSON.stringify(evt.payload ?? {}));
    } catch (_) {}
    dot.innerHTML = ICONS[cls] || ICONS['default'];
    dot.style.left = (a.x - 7) + 'px';
    dot.style.top  = (a.y - 7) + 'px';
    dot.style.opacity = '0.95';
    layer.appendChild(dot);

    const particle = {
      el: dot,
      from: a,
      to: b,
      startTime: performance.now(),
      duration: CONFIG.travelMs,
      arrived: false,
    };
    live.push(particle);
    // FIFO evict if we're over the cap.
    while (live.length > CONFIG.maxConcurrent) {
      const old = live.shift();
      if (old && old.el && old.el.parentNode) old.el.parentNode.removeChild(old.el);
    }
    if (!raf) raf = requestAnimationFrame(tick);
  }

  function tick(now) {
    const N = live.length;
    for (let i = N - 1; i >= 0; i--) {
      const p = live[i];
      const t = (now - p.startTime) / p.duration;
      if (t >= 1) {
        if (!p.arrived) {
          p.arrived = true;
          p.el.style.left = (p.to.x - 7) + 'px';
          p.el.style.top  = (p.to.y - 7) + 'px';
          p.el.classList.add('fading');
          setTimeout(function() {
            if (p.el.parentNode) p.el.parentNode.removeChild(p.el);
          }, CONFIG.fadeMs);
          // Splice out — kept in 'live' until fade completes so the
          // click-inspector can still pick it up.
          live.splice(i, 1);
        }
        continue;
      }
      const x = p.from.x + (p.to.x - p.from.x) * t;
      const y = p.from.y + (p.to.y - p.from.y) * t;
      p.el.style.left = (x - 7) + 'px';
      p.el.style.top  = (y - 7) + 'px';
    }
    if (live.length > 0) {
      raf = requestAnimationFrame(tick);
    } else {
      raf = null;
    }
  }

  // ---------- SSE hookup ----------
  if (window.__stavrStream) {
    window.__stavrStream.on('event', function(ev) {
      try {
        const data = JSON.parse(ev.data || '{}');
        emit(data);
      } catch (_) { /* ignore */ }
    });
  }

  // Expose to the click-inspector (Task 4c).
  window.__stavrFlowParticles = { emit: emit, live: live };
})();
`;
