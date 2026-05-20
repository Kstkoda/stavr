/**
 * src/dashboard/widgets/topology-timeline.ts
 *
 * YouTube-style heatmap scrubber for the Topology page. Replaces the
 * flat blue range-slider polyline with a horizontal SVG ribbon whose
 * vertical thickness encodes recent event density.
 *
 * Visual contract (CLAUDE.md §5 — rust accent, glass surface):
 *   - Thickness ∝ sqrt(count_i / peak), clamped to [MIN_THICK, MAX_THICK]
 *     so a single-event bucket still reads against the baseline.
 *   - Fill = monochrome rust gradient. Per-bucket opacity rises with
 *     density so a heavy region reads "darker" without the renderer
 *     having to allocate per-bucket gradient stops.
 *   - Path is symmetric around the centerline → reads as a continuous
 *     activity waveform, the same way YouTube renders "most replayed".
 *   - A transparent range input sits on top of the ribbon, preserving
 *     the existing scrubber JS contract (input event idx → page hook).
 *
 * Configurable buckets:
 *   - 5s / 1m / 5m via the zoom chip row above the ribbon. Default 1m.
 *   - The fetcher (topology-data.ts) hands buckets in at one granularity;
 *     the zoom chips re-request via ?bucket= so the daemon stays the
 *     source of truth for aggregation.
 *
 * Hover tooltip shows the per-kind breakdown the fetcher condensed
 * (top-6 + 'other' rollup), the timestamp, and the total count.
 */
import type { EventDensitySnapshot } from '../data/topology-data.js';

const VIEW_HEIGHT = 36;
const CENTER_Y = VIEW_HEIGHT / 2;
const MIN_THICK = 4;
const MAX_THICK = 32;

/**
 * Map a bucket's count to a thickness in viewport units. Square-root
 * scaling so a bucket with 100 events doesn't drown out 1-event buckets
 * the way linear scaling would.
 */
function thicknessFor(count: number, peak: number): number {
  if (peak <= 0 || count <= 0) return MIN_THICK;
  const t = Math.sqrt(count / peak); // 0..1
  return MIN_THICK + (MAX_THICK - MIN_THICK) * t;
}

/**
 * Map density → fill opacity. Pure power law (^0.6) so the upper end of
 * the dynamic range doesn't saturate too quickly — operators want to
 * see the difference between "warm" and "hot" buckets even when both
 * are well above zero.
 */
function fillOpacityFor(count: number, peak: number): number {
  if (peak <= 0 || count <= 0) return 0.06;
  const t = Math.min(1, count / peak);
  return 0.22 + 0.62 * Math.pow(t, 0.6);
}

function escapeAttr(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export interface RenderTopologyTimelineInput {
  density: EventDensitySnapshot;
  /** When provided, current zoom is reflected on the chip row. */
  bucketMs?: number;
}

export function renderTopologyTimeline(input: RenderTopologyTimelineInput): string {
  const { density } = input;
  const N = density.buckets.length;
  const peak = density.peak;

  // Empty-bucket fallback — still emit the widget shell so the page JS
  // hooks fire and the zoom chips remain reachable, but skip the SVG
  // body until buckets land.
  if (N === 0) {
    return [
      `<div class="topo-timeline" data-role="topo-timeline" data-bucket-ms="${density.bucketMs}" data-empty="true">`,
      `<div class="topo-tl-head">`,
      `<span class="topo-tl-label">Event density</span>`,
      `<span class="topo-tl-range">no events yet</span>`,
      `</div>`,
      `<div class="topo-tl-ribbon-wrap" data-role="topo-tl-ribbon-wrap">`,
      `<input type="range" class="topo-tl-slider" data-role="topo-tl-slider" min="0" max="0" step="1" value="0" disabled aria-label="Scrub event timeline" />`,
      `<div class="topo-tl-tooltip" data-role="topo-tl-tooltip" aria-hidden="true"></div>`,
      `<div class="topo-tl-readout"><span data-role="topo-tl-value">live</span><span data-role="topo-tl-time"></span></div>`,
      `</div>`,
      `</div>`,
    ].join('');
  }

  // Each bucket is a vertical band. Width is computed at render time in
  // CSS via viewBox math; here we just emit the SVG inside a 1000-wide
  // viewBox + preserveAspectRatio=none so the container stretches.
  const colW = 1000 / N;

  // Build the symmetric polygon path: walk top edge left→right, then
  // bottom edge right→left, then close. Coarse but matches YouTube's
  // "most replayed" treatment exactly.
  let top = '';
  let bottom = '';
  for (let i = 0; i < N; i++) {
    const b = density.buckets[i];
    const x = i * colW + colW / 2;
    const half = thicknessFor(b.count, peak) / 2;
    top += `${x.toFixed(2)},${(CENTER_Y - half).toFixed(2)} `;
    // Build bottom in reverse below.
    bottom = `${x.toFixed(2)},${(CENTER_Y + half).toFixed(2)} ` + bottom;
  }
  const polyPoints = `${top}${bottom}`;

  // Per-bucket rects with variable opacity provide the heat-darkness
  // signal independent of the silhouette. Same coords, rendered under
  // the polygon at full canvas height with low alpha so the darkness
  // only reads inside the silhouette (the polygon clips visually).
  const heatRects = density.buckets.map((b, i) => {
    const x = i * colW;
    const opacity = fillOpacityFor(b.count, peak);
    return `<rect class="topo-tl-heat" x="${x.toFixed(2)}" y="0" width="${colW.toFixed(2)}" height="${VIEW_HEIGHT}" fill="var(--rust)" fill-opacity="${opacity.toFixed(3)}" />`;
  }).join('');

  // Hover hit-zones: invisible rects with title/data attributes; the
  // page JS reads data-* and surfaces a tooltip. Kept separate from
  // the heat rects so opacity tweaks don't affect hit testing.
  const hitZones = density.buckets.map((b, i) => {
    const x = i * colW;
    const kindBreakdown = Object.entries(b.kinds)
      .map(([k, n]) => `${k}=${n}`)
      .join(', ');
    return [
      `<rect class="topo-tl-hit" `,
      `x="${x.toFixed(2)}" y="0" width="${colW.toFixed(2)}" height="${VIEW_HEIGHT}" `,
      `fill="transparent" `,
      `data-at="${escapeAttr(b.at)}" `,
      `data-count="${b.count}" `,
      `data-kinds="${escapeAttr(kindBreakdown)}" `,
      `data-idx="${i}" `,
      `/>`,
    ].join('');
  }).join('');

  const bucketSeconds = Math.round((input.bucketMs ?? density.bucketMs) / 1000);
  const zoomChip = (label: string, seconds: number) => {
    const pressed = seconds === bucketSeconds ? 'true' : 'false';
    return `<button type="button" class="topo-tl-zoom" data-zoom="${seconds}" aria-pressed="${pressed}">${label}</button>`;
  };

  return [
    `<div class="topo-timeline" data-role="topo-timeline" data-bucket-ms="${density.bucketMs}" data-from="${escapeAttr(density.from)}" data-to="${escapeAttr(density.to)}">`,
    `<div class="topo-tl-head">`,
    `<span class="topo-tl-label">Event density</span>`,
    `<span class="topo-tl-range">${escapeAttr(density.from.slice(11, 19))} → ${escapeAttr(density.to.slice(11, 19))} UTC</span>`,
    `<span class="topo-tl-zoom-row" role="toolbar" aria-label="Timeline bucket size">`,
    zoomChip('5s', 5),
    zoomChip('1m', 60),
    zoomChip('5m', 300),
    `</span>`,
    `</div>`,
    `<div class="topo-tl-ribbon-wrap">`,
    `<svg class="topo-tl-ribbon" viewBox="0 0 1000 ${VIEW_HEIGHT}" preserveAspectRatio="none" aria-hidden="true">`,
    `<defs>`,
    `<linearGradient id="topo-tl-grad" x1="0" x2="0" y1="0" y2="1">`,
    `<stop offset="0%" stop-color="var(--rust)" stop-opacity="0.85"/>`,
    `<stop offset="100%" stop-color="var(--rust)" stop-opacity="0.55"/>`,
    `</linearGradient>`,
    `</defs>`,
    heatRects,
    `<polygon class="topo-tl-poly" fill="url(#topo-tl-grad)" stroke="var(--rust)" stroke-width="0.6" stroke-opacity="0.7" points="${polyPoints}" />`,
    hitZones,
    `</svg>`,
    `<input type="range" class="topo-tl-slider" data-role="topo-tl-slider" min="0" max="${N}" step="1" value="${N}" aria-label="Scrub event timeline" />`,
    `<div class="topo-tl-tooltip" data-role="topo-tl-tooltip" aria-hidden="true"></div>`,
    `<div class="topo-tl-readout"><span data-role="topo-tl-value">live</span><span data-role="topo-tl-time"></span></div>`,
    `</div>`,
    `</div>`,
  ].join('');
}

/**
 * CSS for the timeline widget. Pinned to the rust accent + glass surface
 * tokens so it falls in with the rest of the dashboard automatically.
 */
export const TOPOLOGY_TIMELINE_CSS = `
.topo-timeline {
  display: flex; flex-direction: column;
  gap: 6px;
  margin-top: 10px;
  padding: 10px 12px 8px;
  background: var(--bg-glass);
  border: 1px solid var(--line);
  border-radius: 10px;
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
}
.topo-tl-head {
  display: flex; align-items: center; gap: 12px;
  font-family: var(--mono); font-size: 11px;
  color: var(--ink-2);
}
.topo-tl-label { letter-spacing: .12em; text-transform: uppercase; color: var(--ink-1); }
.topo-tl-range { color: var(--ink-3); }
.topo-tl-zoom-row { margin-left: auto; display: inline-flex; gap: 4px; }
.topo-tl-zoom {
  background: transparent; color: var(--ink-2);
  border: 1px solid var(--line-2);
  padding: 2px 8px; border-radius: 999px;
  font-family: var(--mono); font-size: 11px;
  cursor: pointer; line-height: 1.2;
}
.topo-tl-zoom[aria-pressed="true"] {
  background: var(--rust-soft); color: #ffd9c4; border-color: var(--rust);
}
.topo-tl-ribbon-wrap {
  position: relative; width: 100%; height: 44px;
}
.topo-tl-ribbon {
  position: absolute; inset: 4px 0 4px 0;
  width: 100%; height: 36px;
  display: block;
}
.topo-tl-hit { pointer-events: all; cursor: pointer; }
.topo-tl-hit:hover { fill: rgba(184, 84, 42, 0.18); }
.topo-tl-poly { transition: opacity .15s ease; }
.topo-tl-ribbon:hover .topo-tl-poly { opacity: .92; }
.topo-tl-slider {
  position: absolute; inset: 0;
  width: 100%; height: 100%;
  margin: 0; padding: 0;
  appearance: none;
  background: transparent;
  cursor: ew-resize;
  -webkit-appearance: none;
}
.topo-tl-slider::-webkit-slider-runnable-track {
  background: transparent; height: 100%;
}
.topo-tl-slider::-moz-range-track {
  background: transparent; height: 100%;
}
.topo-tl-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 4px; height: 44px; border-radius: 0;
  background: var(--rust); box-shadow: 0 0 8px var(--rust-glow);
  cursor: ew-resize; border: 0;
}
.topo-tl-slider::-moz-range-thumb {
  width: 4px; height: 44px; border-radius: 0;
  background: var(--rust); box-shadow: 0 0 8px var(--rust-glow);
  cursor: ew-resize; border: 0;
}
.topo-tl-tooltip {
  position: absolute;
  bottom: calc(100% + 6px);
  background: var(--bg-popover, rgba(20, 22, 31, 0.96));
  color: var(--ink-0);
  border: 1px solid var(--line-2);
  border-radius: 6px;
  padding: 6px 10px;
  font-family: var(--mono); font-size: 11px;
  white-space: nowrap;
  opacity: 0; pointer-events: none;
  transform: translateX(-50%);
  transition: opacity .12s ease;
  z-index: 8;
}
.topo-tl-tooltip[data-open="true"] { opacity: 1; }
.topo-tl-tooltip .tl-tip-h {
  color: var(--ink-2); margin-bottom: 2px;
  letter-spacing: .08em; text-transform: uppercase; font-size: 11px;
}
.topo-tl-tooltip .tl-tip-count { color: var(--rust); font-weight: 500; }
.topo-tl-tooltip .tl-tip-kinds { color: var(--ink-2); font-size: 11px; }
.topo-tl-readout {
  position: absolute;
  right: 0; top: -22px;
  display: inline-flex; gap: 8px;
  font-family: var(--mono); font-size: 11px;
  color: var(--ink-3);
}
.topo-tl-readout [data-role="topo-tl-value"] {
  color: var(--rust);
}
`;

/**
 * Page-side JS for the timeline. Wires hover tooltip, scrub value
 * readout, zoom-chip click → ?bucket= reload, and dispatches a custom
 * 'topology:scrub' event the existing page JS can hook to snapshot the
 * canvas at the chosen bucket time.
 */
export const TOPOLOGY_TIMELINE_JS = `
(function() {
  const tl = document.querySelector('[data-role="topo-timeline"]');
  if (!tl) return;
  const slider  = tl.querySelector('[data-role="topo-tl-slider"]');
  const tooltip = tl.querySelector('[data-role="topo-tl-tooltip"]');
  const valEl   = tl.querySelector('[data-role="topo-tl-value"]');
  const timeEl  = tl.querySelector('[data-role="topo-tl-time"]');
  const wrap    = tl.querySelector('.topo-tl-ribbon-wrap');
  const ribbon  = tl.querySelector('.topo-tl-ribbon');
  if (!slider || !ribbon || !wrap) return;

  // Lift bucket data once so tooltip can read it without DOM queries.
  const hits = Array.from(ribbon.querySelectorAll('.topo-tl-hit'));
  const buckets = hits.map(function(h) {
    return {
      at: h.getAttribute('data-at') || '',
      count: Number(h.getAttribute('data-count') || 0),
      kinds: h.getAttribute('data-kinds') || '',
      idx: Number(h.getAttribute('data-idx') || 0),
    };
  });

  function showTip(b, x) {
    if (!tooltip) return;
    const tHHMMSS = b.at.slice(11, 19);
    tooltip.innerHTML = ''
      + '<div class="tl-tip-h">' + esc(tHHMMSS) + ' UTC</div>'
      + '<div><span class="tl-tip-count">' + b.count + '</span> events</div>'
      + (b.kinds ? '<div class="tl-tip-kinds">' + esc(b.kinds) + '</div>' : '');
    tooltip.style.left = x + 'px';
    tooltip.setAttribute('data-open', 'true');
  }
  function hideTip() {
    if (!tooltip) return;
    tooltip.removeAttribute('data-open');
  }
  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // Hover handlers — bucket lookup is index-based, derived from the
  // wrap-local mouse X. Cheaper than per-rect listeners and survives
  // SVG hit-test quirks across browsers.
  wrap.addEventListener('mousemove', function(ev) {
    if (buckets.length === 0) return;
    const rect = wrap.getBoundingClientRect();
    const xPx = ev.clientX - rect.left;
    const idx = Math.max(0, Math.min(buckets.length - 1,
      Math.floor((xPx / rect.width) * buckets.length)));
    showTip(buckets[idx], xPx);
  });
  wrap.addEventListener('mouseleave', hideTip);

  // Scrub readout — mirrors the prior page contract so existing
  // listeners on the topology canvas (worker dimming, etc) still work.
  slider.addEventListener('input', function() {
    const idx = Number(slider.value);
    const total = buckets.length;
    if (idx >= total) {
      valEl.textContent = 'live';
      if (timeEl) timeEl.textContent = '';
    } else {
      const b = buckets[idx];
      if (b) {
        valEl.textContent = '@ ' + (idx + 1) + '/' + total;
        if (timeEl) timeEl.textContent = b.at.slice(11, 19);
      }
    }
    tl.dispatchEvent(new CustomEvent('topology:scrub', {
      detail: { idx: idx, total: total, bucket: buckets[idx] || null },
      bubbles: true,
    }));
  });
  slider.addEventListener('change', function() {
    slider.value = buckets.length;
    valEl.textContent = 'live';
    if (timeEl) timeEl.textContent = '';
    tl.dispatchEvent(new CustomEvent('topology:scrub', {
      detail: { idx: buckets.length, total: buckets.length, bucket: null },
      bubbles: true,
    }));
  });

  // Zoom-chip click → set ?bucket=N and reload. Daemon owns aggregation;
  // round-tripping keeps the rendered buckets the source of truth.
  tl.querySelectorAll('.topo-tl-zoom').forEach(function(chip) {
    chip.addEventListener('click', function() {
      const seconds = Number(chip.getAttribute('data-zoom'));
      if (!Number.isFinite(seconds)) return;
      const url = new URL(window.location.href);
      url.searchParams.set('bucket_ms', String(seconds * 1000));
      window.location.href = url.toString();
    });
  });
})();
`;
