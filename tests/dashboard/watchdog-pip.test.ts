import { describe, expect, it } from 'vitest';
import { WATCHDOG_PIP_JS, renderWatchdogPip } from '../../src/dashboard/components/watchdog-pip.js';
import { renderShell } from '../../src/dashboard/shell.js';

describe('watchdog pip — top-rail health indicator', () => {
  it('renders a single pip button with placeholder label', () => {
    const html = renderWatchdogPip();
    expect(html).toContain('class="watchdog-pip"');
    expect(html).toContain('data-role="watchdog-pip"');
    expect(html).toContain('data-role="wp-label"');
  });

  it('client JS polls /healthz AND /metrics — not in-process state', () => {
    // The whole point of the pip is to surface the daemon's PUBLIC contract.
    // Any in-process shortcut would lie about what an external monitor sees,
    // which is the same anti-pattern the brief flags.
    expect(WATCHDOG_PIP_JS).toContain("'/healthz'");
    expect(WATCHDOG_PIP_JS).toContain("'/metrics'");
    expect(WATCHDOG_PIP_JS).toContain('setInterval');
  });

  it('reads the two Prom metrics the operator cares about', () => {
    expect(WATCHDOG_PIP_JS).toContain('process_resident_memory_bytes');
    expect(WATCHDOG_PIP_JS).toContain('nodejs_eventloop_lag_p99_seconds');
  });

  it('is mounted into the shell top-rail exactly once', () => {
    const html = renderShell({ title: 't', activePage: 'helm', body: '' });
    // Strip inline <script> blocks — they reference data-role="watchdog-pip"
    // by string inside the JS source, which we don't count as a mount.
    const markupOnly = html.replace(/<script[\s\S]*?<\/script>/g, '');
    const count = markupOnly.split('data-role="watchdog-pip"').length - 1;
    expect(count).toBe(1);
    // Confirm it lives in the topnav, not the page body.
    const navIdx = markupOnly.indexOf('class="topnav"');
    const pipIdx = markupOnly.indexOf('data-role="watchdog-pip"');
    expect(navIdx).toBeGreaterThan(0);
    expect(pipIdx).toBeGreaterThan(navIdx);
    // The pip should appear before the closing </header>.
    const headerEnd = markupOnly.indexOf('</header>');
    expect(pipIdx).toBeLessThan(headerEnd);
  });
});
