/**
 * Watchdog pip — small status indicator in the top rail. Reads `/healthz`
 * every 5s and selected `/metrics` lines every 30s to compute combined
 * health (green / yellow / red). Click → placeholder watchdog incidents
 * sheet (full sheet ships when stavr-tray companion lands, ADR-033).
 *
 * The pip is intentionally a client-side widget that reads the SAME public
 * surfaces an external monitor would — no in-process shortcut. This lets the
 * dashboard be honest about what the daemon advertises to the outside world.
 */

export const WATCHDOG_PIP_CSS = `
.watchdog-pip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border-radius: 999px;
  background: rgba(109, 213, 140, 0.08);
  border: 1px solid rgba(109, 213, 140, 0.25);
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.12em;
  color: var(--ok);
  text-transform: uppercase;
  cursor: pointer;
  transition: border-color 0.15s ease, color 0.15s ease, background 0.15s ease;
  user-select: none;
}
.watchdog-pip:hover {
  border-color: rgba(109, 213, 140, 0.55);
}
.watchdog-pip .wp-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--ok);
  box-shadow: 0 0 6px var(--ok);
  transition: background 0.2s ease, box-shadow 0.2s ease;
}
.watchdog-pip[data-state="healthy"] {
  background: rgba(109, 213, 140, 0.08);
  border-color: rgba(109, 213, 140, 0.25);
  color: var(--ok);
}
.watchdog-pip[data-state="degraded"] {
  background: rgba(226, 169, 66, 0.10);
  border-color: rgba(226, 169, 66, 0.30);
  color: var(--warn);
}
.watchdog-pip[data-state="degraded"] .wp-dot {
  background: var(--warn);
  box-shadow: 0 0 8px var(--warn);
}
.watchdog-pip[data-state="down"] {
  background: rgba(239, 90, 111, 0.10);
  border-color: rgba(239, 90, 111, 0.35);
  color: var(--crit);
}
.watchdog-pip[data-state="down"] .wp-dot {
  background: var(--crit);
  box-shadow: 0 0 8px var(--crit);
  animation: wp-pulse 1.4s ease-in-out infinite;
}
@keyframes wp-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.45; } }
.watchdog-pip .wp-label {
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.12em;
}
`;

export function renderWatchdogPip(): string {
  // Brief calls this the WATCH chip — replaces any literal red dot. Hover
  // opens the watchdog tooltip via the existing JS.
  return [
    '<button type="button" class="watchdog-pip" data-role="watchdog-pip"',
    ' data-state="healthy"',
    ' aria-label="Watchdog status" title="Watchdog (click for details)">',
    '<span class="wp-dot" aria-hidden="true"></span>',
    '<span class="wp-label" data-role="wp-label">WATCH OK</span>',
    '</button>',
  ].join('');
}

/**
 * Reads `/healthz` and `/metrics`. Health rules:
 *   - HEALTHY: /healthz OK, RSS < 1.5 GB, eventloop_lag p99 < 100ms.
 *   - DEGRADED: /healthz OK but one metric over threshold.
 *   - DOWN: /healthz non-200 or fetch throws.
 *
 * The pip uses the same parsing strategy as a third-party scraper would
 * (text-format Prom output, simple regex extraction). Don't dress it up
 * with structured types — that's exactly the failure mode the brief calls
 * out (in-process shortcuts that hide protocol drift).
 */
export const WATCHDOG_PIP_JS = `
(function() {
  const pip = document.querySelector('[data-role="watchdog-pip"]');
  if (!pip) return;
  const label = pip.querySelector('[data-role="wp-label"]');

  let rssMb = null;
  let lagP99 = null;
  let healthOk = null;

  function setState(state, text, tooltip) {
    pip.setAttribute('data-state', state);
    if (label) label.textContent = text;
    if (tooltip) pip.setAttribute('title', tooltip);
  }

  function compute() {
    if (healthOk === false) { setState('down', 'WATCH DOWN', 'Daemon /healthz non-200'); return; }
    if (healthOk == null)   { setState('down', 'WATCH …', 'Watchdog probing /healthz'); return; }
    const rssTooHigh = rssMb != null && rssMb > 1500;
    const lagTooHigh = lagP99 != null && lagP99 > 0.1;
    const rssText = rssMb != null ? Math.round(rssMb) + 'MB' : 'n/a';
    const lagText = lagP99 != null ? Math.round(lagP99 * 1000) + 'ms' : 'n/a';
    const baseTip = 'PM2 healthy · last /healthz 200 · RSS ' + rssText + ' · loop p99 ' + lagText;
    if (rssTooHigh || lagTooHigh) {
      setState('degraded', 'WATCH WARN', baseTip);
    } else {
      setState('healthy', 'WATCH OK', baseTip);
    }
  }

  async function pollHealth() {
    try {
      const r = await fetch('/healthz', { headers: { accept: 'application/json' } });
      healthOk = r.ok;
    } catch (_e) {
      healthOk = false;
    }
    compute();
  }

  async function pollMetrics() {
    try {
      const r = await fetch('/metrics', { headers: { accept: 'text/plain' } });
      if (!r.ok) return;
      const text = await r.text();
      const rssMatch = text.match(/^process_resident_memory_bytes\\s+(\\S+)/m);
      if (rssMatch) rssMb = Number(rssMatch[1]) / (1024 * 1024);
      const p99Match = text.match(/^nodejs_eventloop_lag_p99_seconds\\s+(\\S+)/m);
      if (p99Match) lagP99 = Number(p99Match[1]);
    } catch (_e) { /* swallow */ }
    compute();
  }

  pip.addEventListener('click', function() {
    // Placeholder; full incidents sheet lands with stavr-tray (ADR-033).
    if (window.__stavrFloatingInspector) {
      const sections = [
        { label: 'RSS', value: rssMb != null ? Math.round(rssMb) + ' MB' : 'n/a' },
        { label: 'Event-loop p99', value: lagP99 != null ? Math.round(lagP99 * 1000) + ' ms' : 'n/a' },
        { label: 'Healthz', value: healthOk == null ? '…' : (healthOk ? 'OK' : 'down') },
      ];
      window.__stavrFloatingInspector.openAt(pip, {
        icon: 'W',
        title: 'Watchdog',
        sub: 'Polls /healthz + /metrics — same surface a tray companion uses',
        sections: sections,
        actions: [{ label: 'Open /metrics', onClick: 'window.open(\"/metrics\", \"_blank\")' }],
      });
    }
  });

  pollHealth();
  pollMetrics();
  setInterval(pollHealth, 5000);
  setInterval(pollMetrics, 30000);
})();
`;
