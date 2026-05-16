/**
 * Smooth timeline component — fixed-bottom strip showing recent activity as
 * a cubic-bezier-smoothed SVG path with rust gradient, multi-color stroke,
 * event dots at significant moments, and a pulsing "now" cursor.
 *
 * Drop the rendered shell once per page; the inline JS polls
 * /dashboard/home/data and reshapes the path.
 */

export const TIMELINE_CSS = `
.smooth-timeline {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  height: 44px;
  background: linear-gradient(to top, var(--bg-surface), transparent);
  border-top: 1px solid var(--border);
  pointer-events: none;
  z-index: 40;
}
.smooth-timeline svg { width: 100%; height: 100%; display: block; }
.smooth-timeline .tl-fill { fill: url(#tl-rust); opacity: 0.45; }
.smooth-timeline .tl-stroke {
  fill: none;
  stroke: url(#tl-stroke);
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.smooth-timeline .tl-dot {
  fill: var(--rust-soft);
  filter: drop-shadow(0 0 4px var(--rust-glow));
}
.smooth-timeline .tl-now {
  fill: var(--rust);
}
.smooth-timeline .tl-now-ring {
  fill: none;
  stroke: var(--rust);
  stroke-width: 1.5;
  opacity: 0.6;
  animation: tl-pulse 1.6s ease-in-out infinite;
  transform-origin: center;
  transform-box: fill-box;
}
@keyframes tl-pulse {
  0%   { transform: scale(0.7); opacity: 0.6; }
  100% { transform: scale(2.6); opacity: 0; }
}
`;

export function renderTimeline(): string {
  return [
    '<div class="smooth-timeline" data-role="smooth-timeline" aria-hidden="true">',
    '<svg viewBox="0 0 1000 44" preserveAspectRatio="none">',
    '<defs>',
    '<linearGradient id="tl-rust" x1="0" y1="0" x2="0" y2="1">',
    '<stop offset="0%" stop-color="var(--rust)" stop-opacity="0.7" />',
    '<stop offset="100%" stop-color="var(--rust)" stop-opacity="0" />',
    '</linearGradient>',
    '<linearGradient id="tl-stroke" x1="0" y1="0" x2="1" y2="0">',
    '<stop offset="0%"   stop-color="#4ade80" />',
    '<stop offset="50%"  stop-color="#facc15" />',
    '<stop offset="100%" stop-color="var(--rust)" />',
    '</linearGradient>',
    '</defs>',
    '<path class="tl-fill"   d="" data-role="tl-fill" />',
    '<path class="tl-stroke" d="" data-role="tl-stroke" />',
    '<g data-role="tl-dots"></g>',
    '<circle class="tl-now"      cx="990" cy="22" r="3" />',
    '<circle class="tl-now-ring" cx="990" cy="22" r="3" />',
    '</svg>',
    '</div>',
  ].join('');
}

export const TIMELINE_JS = `
(function() {
  const root = document.querySelector('[data-role="smooth-timeline"]');
  if (!root) return;
  const fillPath   = root.querySelector('[data-role="tl-fill"]');
  const strokePath = root.querySelector('[data-role="tl-stroke"]');
  const dotsG      = root.querySelector('[data-role="tl-dots"]');

  // Sample ring — last 60 buckets, each a small noise value seeded from event_count.
  const N = 60;
  let buckets = new Array(N).fill(20);
  let lastEventCount = -1;

  function buildPath(values) {
    if (!values.length) return { fill: '', stroke: '' };
    const W = 1000, H = 44;
    const step = W / (values.length - 1);
    const toY = function(v) { return H - 4 - (v / 40) * (H - 10); };
    let d = 'M 0,' + toY(values[0]);
    for (let i = 1; i < values.length; i++) {
      const x0 = (i - 1) * step;
      const x1 = i * step;
      const mx = (x0 + x1) / 2;
      d += ' Q ' + mx + ',' + toY(values[i - 1]) + ' ' + x1 + ',' + toY(values[i]);
    }
    const fill = d + ' L ' + W + ',' + H + ' L 0,' + H + ' Z';
    return { fill: fill, stroke: d };
  }

  function renderDots() {
    const W = 1000;
    const step = W / (buckets.length - 1);
    const html = buckets
      .map(function(v, i) {
        if (v < 30) return '';
        const x = i * step;
        const y = 44 - 4 - (v / 40) * (44 - 10);
        return '<circle class="tl-dot" cx="' + x + '" cy="' + y + '" r="2" />';
      })
      .join('');
    dotsG.innerHTML = html;
  }

  function repaint() {
    const p = buildPath(buckets);
    fillPath.setAttribute('d', p.fill);
    strokePath.setAttribute('d', p.stroke);
    renderDots();
  }

  function tick(eventCount) {
    if (lastEventCount < 0) lastEventCount = eventCount;
    const delta = Math.max(0, eventCount - lastEventCount);
    lastEventCount = eventCount;
    // Map delta into 0..40 with light noise so a flat daemon still wiggles gently.
    const next = Math.min(40, 8 + delta * 4 + (Math.random() * 6));
    buckets = buckets.slice(1).concat([next]);
    repaint();
  }

  async function poll() {
    try {
      const r = await fetch('/dashboard/home/data', { headers: { accept: 'application/json' } });
      if (!r.ok) return;
      const j = await r.json();
      tick(j && j.health && typeof j.health.event_count === 'number' ? j.health.event_count : 0);
    } catch (_e) { /* swallow */ }
  }

  repaint();
  poll();
  setInterval(poll, 5000);
})();
`;
