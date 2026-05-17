// v0.5 P6 — Steward subprocess panel renders inside the existing /diagnostics
// page without disturbing the negative-assertion regression locks added in the
// earlier polish runs (visual freeze: no topo-bus, no topo-mode-chips, no
// "enterprise bus", no "this · 8421", no "STAVR DAEMON").

import { describe, expect, it } from 'vitest';
import { renderDiagnosticsPage, type DiagnosticsData } from '../../src/dashboard/pages/diagnostics.js';

describe('v0.5 P6 — Steward subprocess panel on /diagnostics', () => {
  it('renders an unwired panel when no steward data is passed', () => {
    const html = renderDiagnosticsPage({});
    expect(html).toContain('class="steward-panel');
    expect(html).toContain('Steward subprocess');
    expect(html).toContain('UNWIRED');
  });

  it('reflects up status + autonomy mode + heartbeat from data', () => {
    const data: DiagnosticsData = {
      steward: {
        pid: 12345,
        status: 'up',
        last_heartbeat_at: '2026-05-17T13:00:00.000Z',
        autonomy_mode: 'scheduled',
        lessons_count: 7,
        memory_working_keys: 4,
      },
    };
    const html = renderDiagnosticsPage(data);
    expect(html).toContain('12345');
    expect(html).toContain('UP');
    expect(html).toContain('steward-mode-chip scheduled');
    expect(html).toContain('2026-05-17T13:00:00.000Z');
    expect(html).toMatch(/Lessons[\s\S]*?>7</);
    expect(html).toMatch(/Working keys[\s\S]*?>4</);
  });

  it('rune halo gets crit class when status is down', () => {
    const html = renderDiagnosticsPage({
      steward: {
        pid: null,
        status: 'down',
        last_heartbeat_at: null,
        autonomy_mode: 'reactive',
        lessons_count: 0,
        memory_working_keys: 0,
      },
    });
    expect(html).toContain('steward-rune crit');
    expect(html).toContain('DOWN');
  });

  it('preserves PR-#24 negative assertions (visual freeze)', () => {
    const html = renderDiagnosticsPage({
      steward: { pid: 1, status: 'up', last_heartbeat_at: null, autonomy_mode: 'reactive', lessons_count: 0, memory_working_keys: 0 },
    });
    // Regression locks from the dashboard freeze — adding the steward panel
    // must not reintroduce any of these.
    expect(html).not.toContain('topo-mode-chips');
    expect(html).not.toContain('class="topo-bus"');
    expect(html).not.toContain('enterprise bus');
    expect(html).not.toContain('class="bus"');
    expect(html).not.toContain('this · 8421');
    expect(html).not.toContain('STAVR DAEMON');
  });
});
