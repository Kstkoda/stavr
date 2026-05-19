/**
 * Foundation tests for the v0.3 dashboard shell.
 *
 * Two complementary surfaces:
 *   - Unit: render the shell to a string, assert nav structure + active page.
 *   - Integration: boot a daemon, GET each page route, assert 200 + shell.
 *
 * These tests carry the C1 acceptance criteria — every nav entry must be
 * reachable, /dashboard must redirect to /dashboard/home, and the shared
 * nav + tokens must appear on every page.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { EventStore } from '../../src/persistence.js';
import { Broker } from '../../src/broker.js';
import { mountTransports, type MountedTransports } from '../../src/transports.js';
import { NAV_ENTRIES, renderShell, type DashboardPageId } from '../../src/dashboard/shell.js';

interface Harness {
  store: EventStore;
  broker: Broker;
  transports: MountedTransports;
  base: string;
}

async function boot(): Promise<Harness> {
  const store = new EventStore();
  store.init(':memory:');
  const broker = new Broker(store);
  const transports = await mountTransports(broker, { mode: 'daemon', port: 0, silent: true });
  const addr = transports.httpServer!.address() as AddressInfo;
  return { store, broker, transports, base: `http://127.0.0.1:${addr.port}` };
}

describe('v0.3 dashboard shell — unit', () => {
  it('renders the brand mark, every nav entry, and design tokens', () => {
    const html = renderShell({
      title: 'Test',
      activePage: 'helm',
      body: '<div id="probe">hi</div>',
    });
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<title>Test</title>');
    expect(html).toContain('--bg-base:        #0a0a0f;');
    // v0.6.11 Phase 5 (UX audit T1) — wordmark is `stav` + Raido rune; the
    // SR-only `STAVR` duplicate was dropped. The visible wordmark is the
    // brand and screen-readers read it natively.
    expect(html).toContain('class="stav"');
    expect(html).toContain('brand-mark');
    expect(html).toContain('<div id="probe">hi</div>');
    for (const entry of NAV_ENTRIES) {
      expect(html).toContain(`href="${entry.href}"`);
      expect(html).toContain(`data-page="${entry.id}"`);
    }
  });

  it('marks the active page with aria-current', () => {
    const html = renderShell({ title: 't', activePage: 'plans', body: '' });
    expect(html).toContain('data-page="plans"');
    expect(html).toMatch(/data-page="plans"\s+aria-current="page"/);
    expect(html).not.toMatch(/data-page="helm"\s+aria-current="page"/);
  });

  it('includes the inspector skeleton and open/close JS', () => {
    const html = renderShell({ title: 't', activePage: 'home', body: '' });
    expect(html).toContain('id="inspector"');
    expect(html).toContain('window.openInspector');
    expect(html).toContain('window.closeInspector');
  });

  it('v0.6.11 — renders daemon version chip beside the wordmark', () => {
    const html = renderShell({ title: 't', activePage: 'helm', body: '' });
    expect(html).toContain('class="brand-version"');
    // The chip must show the current package.json#version; the shell loads
    // it once at module init so the resolved string ends up baked into the
    // markup.
    expect(html).toMatch(/class="brand-version"[^>]*>v[^<]+</);
  });

  it('v0.6.11 — exposes __stavrCleanup + __stavrStream singletons for pages', () => {
    const html = renderShell({ title: 't', activePage: 'home', body: '' });
    expect(html).toContain('window.__stavrCleanup');
    expect(html).toContain('window.__stavrStream');
    expect(html).toContain("addEventListener('pagehide'");
    // Single EventSource open lives in the shell singleton, not per page.
    expect(html).toContain("new EventSource('/dashboard/stream')");
  });
});

describe('v0.3 dashboard shell — integration', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await boot();
  });

  afterEach(async () => {
    await h.transports.shutdown();
  });

  const pageIds: DashboardPageId[] = [
    'helm', 'topology', 'streams', 'plans',
    'decide', 'toolkit', 'mcps', 'capabilities', 'settings',
  ];

  for (const id of pageIds) {
    it(`GET /dashboard/${id} renders the shared shell with ${id} active`, async () => {
      const r = await fetch(`${h.base}/dashboard/${id}`);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toMatch(/text\/html/);
      const body = await r.text();
      // Shared tokens + nav appear on every page.
      expect(body).toContain('--accent-steward:       #ef4444;');
      expect(body).toContain('href="/dashboard/helm"');
      // Active page is highlighted.
      expect(body).toMatch(new RegExp(`data-page="${id}"\\s+aria-current="page"`));
    });
  }

  it('GET /dashboard/home still works as a v0.3 legacy alias', async () => {
    const r = await fetch(`${h.base}/dashboard/home`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/text\/html/);
  });

  it('GET /dashboard issues 302 to /dashboard/helm', async () => {
    const r = await fetch(`${h.base}/dashboard`, { redirect: 'manual' });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/dashboard/helm');
  });
});
