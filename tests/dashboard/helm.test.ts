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
    worker_counters: over.worker_counters,
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
    // BOM v0.6.6: L2 chips show ONLY currently-active workers (starting /
    // running). Both workers in this test are passed lifecycle_state so the
    // new chip path renders them; data-lifecycle is the forward-compatible
    // attribute, data-state remains for back-compat with click handlers.
    const html = renderHelmPage(
      snapshot({
        workers: [
          { id: 'wkr_abcd', type: 'cc', status: 'running', lifecycle_state: 'running', current_step: 'step 1' },
          { id: 'wkr_efgh', type: 'shell', status: 'running', lifecycle_state: 'starting' },
        ],
      }),
    );
    expect(html).toContain('data-worker-id="wkr_abcd"');
    expect(html).toContain('data-state="running"');
    expect(html).toContain('data-lifecycle="running"');
    expect(html).toContain('data-lifecycle="starting"');
    expect(html).toContain('data-fi-open="worker"');
  });

  it('historic workers (completed / killed / crashed) are filtered out of L2 chips', () => {
    // BOM v0.6.6 hard rule #7: primary view never shows historic workers.
    // The 2026-05-17 scenario had 6 historic rows showing as if active —
    // this test makes that regression impossible.
    const html = renderHelmPage(
      snapshot({
        workers: [
          { id: 'old1', type: 'cc', status: 'idle', lifecycle_state: 'completed-clean' },
          { id: 'old2', type: 'cc', status: 'crashed', lifecycle_state: 'crashed' },
          { id: 'op-killed', type: 'shell', status: 'idle', lifecycle_state: 'killed-by-operator' },
        ],
        worker_counters: {
          active: 0, completed: 1, crashed: 1, killed_by_operator: 1, stale: 0, total: 3,
        },
      }),
    );
    expect(html).toContain('No workers running');
    expect(html).not.toContain('data-worker-id="old1"');
    expect(html).not.toContain('data-worker-id="old2"');
    expect(html).not.toContain('data-worker-id="op-killed"');
    // The counter summary line MUST mention 0 active (not 3) — that's the
    // exact lie this BOM is fixing.
    expect(html).toMatch(/0 active/);
  });

  it('L2 summary distinguishes lifetime vs current per BOM hard rule #5', () => {
    const html = renderHelmPage(
      snapshot({
        workers: [
          { id: 'a', type: 'cc', status: 'running', lifecycle_state: 'running' },
        ],
        worker_counters: {
          active: 1, completed: 7, crashed: 0, killed_by_operator: 1, stale: 2, total: 11,
        },
      }),
    );
    expect(html).toMatch(/1 active/);
    expect(html).toMatch(/7 completed/);
    expect(html).toMatch(/1 terminated/);
    expect(html).toMatch(/2 stale/);
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

  // F9 — operator-trust pass. Storm Pass #2 found the L1 TOP TOOLS panel
  // was rendering a hardcoded v8-mockup array (github.read_pr / drive.write
  // / ollama.generate / slack.post / linear.create_issue) regardless of
  // real traffic. Never again — the slot must be populated by the page JS
  // via /dashboard/api/top-tools, with an explicit empty-state on zero.
  it('L1 top-tools renders a server-side loading placeholder, not mockup numbers', () => {
    const html = renderHelmPage(snapshot());
    expect(html).toContain('data-role="top-tools"');
    expect(html).toContain('Loading top tools');
    // Hardcoded v8-mockup tool names + counts must not appear in the SSR.
    expect(html).not.toMatch(/github\.read_pr/);
    expect(html).not.toMatch(/drive\.write/);
    expect(html).not.toMatch(/ollama\.generate/);
    expect(html).not.toMatch(/slack\.post/);
    expect(html).not.toMatch(/linear\.create_issue/);
    expect(html).not.toMatch(/\b(412|304|247|170|98)\b/);
  });

  it('L1 top-tools page JS fetches /dashboard/api/top-tools and has empty-state copy', () => {
    const html = renderHelmPage(snapshot());
    expect(html).toContain('/dashboard/api/top-tools');
    expect(html).toContain('No tool calls in last hour.');
  });
});
