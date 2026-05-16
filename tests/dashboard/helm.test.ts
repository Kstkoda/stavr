import { describe, expect, it } from 'vitest';
import { renderHelmPage, type HelmData } from '../../src/dashboard/pages/helm.js';

function snapshot(over: Partial<HelmData> = {}): HelmData {
  return {
    intent: { summary: 'do the thing', sub: 'eco · 1 active', ...(over.intent ?? {}) },
    health: {
      ok: true,
      version: '0.4.0',
      port: 7777,
      started_at: new Date().toISOString(),
      uptime_sec: 60,
      profile_mode: 'eco',
      event_count: 42,
      active_scopes: 1,
      ...(over.health ?? {}),
    },
    boms: { recent: [], total: 0, open: 0, ...(over.boms ?? {}) },
    decisions: { recent: [], open: 0, ...(over.decisions ?? {}) },
    workers: over.workers ?? [],
    systems: over.systems ?? [],
  };
}

describe('Helm page — 5-band v8 stack', () => {
  it('renders all five bands with their L-tag labels', () => {
    const html = renderHelmPage(snapshot());
    expect(html).toContain('data-slot="intent"');
    expect(html).toContain('data-slot="plans"');
    expect(html).toContain('data-slot="workers"');
    expect(html).toContain('data-slot="tool-calls"');
    expect(html).toContain('data-slot="systems"');
    expect(html).toContain('L4 · INTENT');
    expect(html).toContain('L3 · PLANS');
    expect(html).toContain('L2 · WORKERS');
    expect(html).toContain('L1 · TOOL CALLS');
    expect(html).toContain('L0 · SYSTEMS');
  });

  it('intent band shows the summary text and profile pill', () => {
    const html = renderHelmPage(
      snapshot({ intent: { summary: 'walk the dog', sub: 'eco' } }),
    );
    expect(html).toContain('walk the dog');
    expect(html).toContain('pill-profile-eco');
  });

  it('worker dots are clickable with data-fi-open="worker"', () => {
    const html = renderHelmPage(
      snapshot({
        workers: [
          { id: 'wkr_abcd', type: 'cc', status: 'running', current_step: 'step 1' },
          { id: 'wkr_efgh', type: 'shell', status: 'idle' },
        ],
      }),
    );
    expect(html).toContain('data-worker-id="wkr_abcd"');
    expect(html).toContain('data-state="running"');
    expect(html).toContain('data-fi-open="worker"');
    expect(html).toContain('data-state="idle"');
  });

  it('sys-chips are clickable with data-fi-open="system"', () => {
    const html = renderHelmPage(
      snapshot({
        systems: [
          { id: 'github', label: 'GitHub', glyph: '🐙', health: 'ok', detail: 'mcp' },
          { id: 'fs', label: 'fs', glyph: '📁', health: 'down', detail: 'disabled' },
        ],
      }),
    );
    expect(html).toContain('data-sys-id="github"');
    expect(html).toContain('data-state="ok"');
    expect(html).toContain('data-fi-open="system"');
    expect(html).toContain('data-state="down"');
  });

  it('uses the helm activePage so the nav tab is highlighted', () => {
    const html = renderHelmPage(snapshot());
    expect(html).toMatch(/data-page="helm"\s+aria-current="page"/);
  });

  it('mounts the floating inspector + smooth timeline + watchdog pip shells', () => {
    const html = renderHelmPage(snapshot());
    expect(html).toContain('data-role="float-inspector"');
    expect(html).toContain('data-role="smooth-timeline"');
    expect(html).toContain('data-role="watchdog-pip"');
  });

  it('falls back to a friendly empty state when there are no plans/workers/systems', () => {
    const html = renderHelmPage(snapshot());
    expect(html).toContain('No active plans');
    expect(html).toContain('No workers running');
    expect(html).toContain('No external systems');
  });
});
