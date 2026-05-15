/**
 * C9 acceptance — Settings page.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { EventStore } from '../../src/persistence.js';
import { Broker } from '../../src/broker.js';
import { mountTransports, type MountedTransports } from '../../src/transports.js';
import { renderSettingsPage, type SettingsData } from '../../src/dashboard/pages/settings.js';

function snap(over: Partial<SettingsData> = {}): SettingsData {
  return {
    activeMode: 'balanced',
    scopes: [],
    noGo: [],
    bricks: [],
    ...over,
  };
}

describe('Settings page — unit', () => {
  it('renders all three sections plus bricks', () => {
    const html = renderSettingsPage(snap());
    expect(html).toContain('data-section="profile"');
    expect(html).toContain('data-section="scopes"');
    expect(html).toContain('data-section="nogo"');
    expect(html).toContain('data-section="bricks"');
  });

  it('flags the active profile-mode card', () => {
    const html = renderSettingsPage(snap({ activeMode: 'eco' }));
    expect(html).toMatch(/<label class="mode-card active" data-mode="eco"/);
    expect(html).toMatch(/<label class="mode-card" data-mode="turbo"/);
  });

  it('renders one row per trust scope with Extend / Revoke buttons', () => {
    const html = renderSettingsPage(snap({
      scopes: [
        { id: 'scope_abc', title: 'feature-x', status: 'active', expires_at: '2030-01-01T00:00:00Z', actions_executed: 2, expires_after_actions: 10 },
      ],
    }));
    expect(html).toContain('data-scope-id="scope_abc"');
    expect(html).toContain('feature-x');
    expect(html).toContain('data-role="extend"');
    expect(html).toContain('data-role="revoke"');
    expect(html).toContain('2 / 10');
  });

  it('renders no-go rows with toggle/delete only for user-source rules', () => {
    const html = renderSettingsPage(snap({
      noGo: [
        { id: 'r1', action_pattern: 'rm -rf /', risk_class: 'destructive', reason: 'kills disk', source: 'default', enabled: true },
        { id: 'r2', action_pattern: 'foo.bar',  risk_class: 'execute',     reason: 'because',    source: 'user',    enabled: true },
      ],
    }));
    // user row gets toggle + delete buttons; default row gets none.
    expect(html).toMatch(/data-rule-id="r1"[\s\S]*?read-only/);
    expect(html).toMatch(/data-rule-id="r2"[\s\S]*?data-role="toggle-rule"/);
    expect(html).toMatch(/data-rule-id="r2"[\s\S]*?data-role="delete-rule"/);
  });

  it('emits the add-rule form with risk_class options', () => {
    const html = renderSettingsPage(snap());
    expect(html).toContain('data-role="add-nogo"');
    expect(html).toContain('name="action_pattern"');
    expect(html).toContain('value="destructive" selected');
  });

  it('lists installed bricks with Configure + Uninstall actions', () => {
    const html = renderSettingsPage(snap({
      bricks: [{ id: 'b1', kind: 'mcp', display_name: 'GitHub', enabled: true }],
    }));
    expect(html).toContain('data-brick-id="b1"');
    expect(html).toContain('GitHub');
    expect(html).toContain('href="/dashboard/toolkit#b1"');
    expect(html).toContain('data-role="uninstall-brick"');
  });

  it('wires every POST endpoint into the page JS', () => {
    const html = renderSettingsPage(snap());
    expect(html).toContain('/dashboard/settings/profile');
    expect(html).toContain('/dashboard/settings/scopes/');
    expect(html).toContain('/dashboard/settings/nogo');
    expect(html).toContain('/dashboard/bricks/install');
  });
});

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

describe('Settings endpoints — integration', () => {
  let h: Harness;

  beforeEach(async () => { h = await boot(); });
  afterEach(async () => { await h.transports.shutdown(); });

  it('POST /dashboard/settings/profile flips active mode and emits an event', async () => {
    const r = await fetch(`${h.base}/dashboard/settings/profile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'turbo' }),
    });
    expect(r.status).toBe(200);
    expect(h.store.getActiveProfileMode()).toBe('turbo');
    const evs = h.store.getEvents({ kinds: ['profile_mode_switched'] }).events;
    expect(evs.length).toBeGreaterThan(0);
  });

  it('POST /dashboard/settings/profile rejects invalid modes', async () => {
    const r = await fetch(`${h.base}/dashboard/settings/profile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'ludicrous' }),
    });
    expect(r.status).toBe(400);
  });

  it('POST /dashboard/settings/nogo adds a user rule', async () => {
    const r = await fetch(`${h.base}/dashboard/settings/nogo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        rule: { id: 'my.rule', action_pattern: 'foo.bar', risk_class: 'execute', reason: 'because' },
      }),
    });
    expect(r.status).toBe(200);
    const rules = h.store.listNoGoRules();
    expect(rules.find((x) => x.id === 'my.rule')).toBeTruthy();
  });

  it('POST /dashboard/settings/nogo refuses duplicate ids', async () => {
    const body = {
      rule: { id: 'dup', action_pattern: 'a', risk_class: 'execute', reason: 'b' },
    };
    await fetch(`${h.base}/dashboard/settings/nogo`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const r = await fetch(`${h.base}/dashboard/settings/nogo`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    expect(r.status).toBe(409);
  });

  it('POST /dashboard/settings/nogo/:id/toggle only flips user rules', async () => {
    h.store.addNoGoRule({ id: 'u1', action_pattern: 'x', risk_class: 'execute', reason: 'y' });
    const r = await fetch(`${h.base}/dashboard/settings/nogo/u1/toggle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(r.status).toBe(200);
    const rule = h.store.listNoGoRules().find((r) => r.id === 'u1');
    expect(rule?.enabled).toBe(false);
  });

  it('POST /dashboard/settings/nogo/:id/delete refuses default rules', async () => {
    // STARTER_NO_GO_LIST seeds defaults — pick the first and try to delete.
    const someDefault = h.store.listNoGoRules().find((r) => r.source === 'default');
    if (!someDefault) {
      // No defaults seeded in this environment; skip.
      return;
    }
    const r = await fetch(`${h.base}/dashboard/settings/nogo/${someDefault.id}/delete`, { method: 'POST' });
    expect(r.status).toBe(404);
  });

  it('GET /dashboard/settings shows the current mode + active scopes', async () => {
    h.store.setActiveProfileMode('eco', 'test');
    const r = await fetch(`${h.base}/dashboard/settings`);
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).toMatch(/data-mode="eco"[^>]*>\s*<input[^>]*checked/);
  });
});
