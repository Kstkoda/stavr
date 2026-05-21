/**
 * Range picker — Today / 24h / 7d / Custom. Emits a `range:change` event
 * on the picker root with `{ since, until }` ISO 8601 strings.
 *
 * Server-side stub: renders the controls. Client-side JS handles the
 * picker state + dispatches the event; pages re-fetch in response.
 *
 * No external date library — built on `Intl.DateTimeFormat` + native
 * date math. The custom dialog uses `<input type="date">` which all
 * supported browsers (Chrome 90+ / Firefox 88+ / Safari 14+) render
 * with a native picker.
 */

export type RangePreset = 'today' | '24h' | '7d' | 'custom';

export const RANGE_PRESETS: Array<{ id: RangePreset; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: '24h',   label: '24h'   },
  { id: '7d',    label: '7d'    },
  { id: 'custom', label: 'Custom' },
];

/**
 * Resolve a preset to a concrete ISO range. Pure function so the page
 * snapshot + the live JS can agree on the same bounds.
 *
 * - today: since=00:00 of operator-local day, until=now
 * - 24h:   since=now-24h, until=now
 * - 7d:    since=now-7d,  until=now
 * - custom: caller supplies both
 */
export function resolveRange(
  preset: Exclude<RangePreset, 'custom'>,
  now: Date = new Date(),
): { since: string; until: string } {
  const until = now.toISOString();
  if (preset === 'today') {
    const local = new Date(now);
    local.setHours(0, 0, 0, 0);
    return { since: local.toISOString(), until };
  }
  const offsets: Record<Exclude<RangePreset, 'custom'>, number> = {
    today: 0,
    '24h': 24 * 60 * 60 * 1000,
    '7d':  7 * 24 * 60 * 60 * 1000,
  };
  return { since: new Date(now.getTime() - offsets[preset]).toISOString(), until };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export interface RenderRangePickerOpts {
  /** Initial active preset. */
  active?: RangePreset;
  /** Initial custom range (when active === 'custom'). */
  customSince?: string;
  customUntil?: string;
}

export function renderRangePicker(opts: RenderRangePickerOpts = {}): string {
  const active = opts.active ?? '24h';
  const buttons = RANGE_PRESETS.map((p) => {
    const cur = p.id === active ? ' aria-pressed="true"' : '';
    return `<button type="button" class="range-btn${p.id === active ? ' active' : ''}" data-range="${p.id}"${cur}>${escapeHtml(p.label)}</button>`;
  }).join('');
  const customSince = opts.customSince ? escapeHtml(opts.customSince.slice(0, 10)) : '';
  const customUntil = opts.customUntil ? escapeHtml(opts.customUntil.slice(0, 10)) : '';
  return [
    `<div class="range-picker" data-role="range-picker" data-active="${active}">`,
    `<span class="range-label">Range</span>`,
    `<div class="range-btns">${buttons}</div>`,
    `<div class="range-custom" data-role="range-custom"${active === 'custom' ? '' : ' hidden'}>`,
    `<input type="date" class="range-date" data-role="range-since" aria-label="From" value="${customSince}" />`,
    `<span class="range-sep">→</span>`,
    `<input type="date" class="range-date" data-role="range-until" aria-label="Until" value="${customUntil}" />`,
    `</div>`,
    `</div>`,
  ].join('');
}

export const RANGE_PICKER_CSS = `
.range-picker {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--ink-1);
}
.range-label {
  color: var(--ink-3);
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.range-btns {
  display: inline-flex;
  background: var(--bg-elevated, rgba(255,255,255,0.04));
  border: 1px solid var(--line-2);
  border-radius: 8px;
  padding: 2px;
  gap: 2px;
}
.range-btn {
  background: transparent;
  border: 0;
  color: var(--ink-1);
  padding: 4px 10px;
  font-size: 12px;
  font-family: inherit;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
}
.range-btn:hover { color: var(--ink-0); background: rgba(255,255,255,0.04); }
.range-btn.active {
  background: var(--rust-soft);
  color: #ffd9c4;
}
.range-custom {
  display: flex;
  align-items: center;
  gap: 6px;
}
.range-custom[hidden] { display: none; }
.range-date {
  background: var(--bg-elevated, rgba(255,255,255,0.04));
  border: 1px solid var(--line-2);
  border-radius: 6px;
  padding: 4px 8px;
  color: var(--ink-0);
  font-size: 12px;
  font-family: inherit;
  color-scheme: dark;
}
.range-sep { color: var(--ink-3); }
`;

export const RANGE_PICKER_JS = `
(function() {
  const root = document.querySelector('[data-role="range-picker"]');
  if (!root) return;
  const custom = root.querySelector('[data-role="range-custom"]');
  const sinceEl = root.querySelector('[data-role="range-since"]');
  const untilEl = root.querySelector('[data-role="range-until"]');

  function resolve(preset) {
    const now = new Date();
    if (preset === 'today') {
      const d = new Date(now); d.setHours(0,0,0,0);
      return { since: d.toISOString(), until: now.toISOString() };
    }
    if (preset === '24h') return { since: new Date(now.getTime() - 86400000).toISOString(), until: now.toISOString() };
    if (preset === '7d')  return { since: new Date(now.getTime() - 7*86400000).toISOString(), until: now.toISOString() };
    return null;
  }

  function emit(detail) {
    root.dispatchEvent(new CustomEvent('range:change', { detail, bubbles: true }));
  }

  root.addEventListener('click', function(ev) {
    const btn = ev.target.closest('[data-range]');
    if (!btn) return;
    const preset = btn.getAttribute('data-range');
    root.setAttribute('data-active', preset);
    root.querySelectorAll('.range-btn').forEach(function(b) {
      const on = b === btn;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    if (preset === 'custom') {
      custom.removeAttribute('hidden');
      return;
    }
    custom.setAttribute('hidden', '');
    const r = resolve(preset);
    if (r) emit(r);
  });

  function emitCustom() {
    if (!sinceEl.value || !untilEl.value) return;
    const since = new Date(sinceEl.value + 'T00:00:00').toISOString();
    const until = new Date(untilEl.value + 'T23:59:59').toISOString();
    emit({ since: since, until: until });
  }
  sinceEl && sinceEl.addEventListener('change', emitCustom);
  untilEl && untilEl.addEventListener('change', emitCustom);
})();
`;
