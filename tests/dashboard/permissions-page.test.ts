import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventStore } from '../../src/persistence.js';
import { ToolRegistry, buildMetadata } from '../../src/tools/registry.js';
import { CapabilityOverrideStore } from '../../src/security/capability-overrides.js';
import { ActorPermissionStore } from '../../src/security/actor-permissions.js';
import {
  fetchPermissionsData,
  emptyPermissionsData,
} from '../../src/dashboard/data/permissions-data.js';
import { renderPermissionsPage } from '../../src/dashboard/pages/permissions.js';
import { NAV_ENTRIES } from '../../src/dashboard/shell.js';

let store: EventStore;
let registry: ToolRegistry;
let caps: CapabilityOverrideStore;
let perms: ActorPermissionStore;

beforeEach(() => {
  store = new EventStore();
  store.init(':memory:');
  registry = new ToolRegistry();
  registry.record(buildMetadata('worker_spawn', { description: 'spawn worker' }, 'workers'));
  registry.record(buildMetadata('host_exec', { description: 'shell' }, 'security'));
  registry.record(buildMetadata('emit_event', { description: 'publish' }, 'server'));
  caps = new CapabilityOverrideStore(store.rawDb);
  perms = new ActorPermissionStore(store.rawDb);
});

afterEach(() => {
  store.close();
});

describe('fetchPermissionsData', () => {
  it('joins registry + Layer 0 + matrix into the page shape', () => {
    caps.disablePermanent('host_exec', { setBy: 'operator', reason: 'pause' });
    perms.set('cowork-claude', 'host_exec', 'NO_GO', 'operator');
    perms.set('steward', 'worker_spawn', 'EXPLICIT', 'operator');

    const data = fetchPermissionsData({ registry, caps, perms });
    expect(data.toolCount).toBe(3);
    expect(data.disabledCount).toBe(1);
    expect(data.tools.find((t) => t.id === 'host_exec')?.disabledNow).toBe(true);
    expect(data.tools.find((t) => t.id === 'worker_spawn')?.disabledNow).toBe(false);

    const hostExecCwc = data.matrix.find(
      (c) => c.actor === 'cowork-claude' && c.tool === 'host_exec',
    );
    expect(hostExecCwc?.tier).toBe('NO_GO');
    expect(hostExecCwc?.source).toBe('matrix');

    const workerSpawnSteward = data.matrix.find(
      (c) => c.actor === 'steward' && c.tool === 'worker_spawn',
    );
    expect(workerSpawnSteward?.tier).toBe('EXPLICIT');
    expect(workerSpawnSteward?.source).toBe('matrix');

    const emitOperator = data.matrix.find(
      (c) => c.actor === 'operator' && c.tool === 'emit_event',
    );
    expect(emitOperator?.tier).toBe('AUTO');
    expect(emitOperator?.source).toBe('default');
  });

  it('lists known actors plus any actor discovered from the matrix', () => {
    perms.set('peer:abc123', 'host_exec', 'AUTO', 'operator');
    const data = fetchPermissionsData({ registry, caps, perms });
    expect(data.actors).toContain('operator');
    expect(data.actors).toContain('cowork-claude');
    expect(data.actors).toContain('cc');
    expect(data.actors).toContain('steward');
    expect(data.actors).toContain('peer:abc123');
  });

  it('counts only currently-active disables (excludes expired temporary ones)', () => {
    const now = Date.now();
    caps.disableTemporary('host_exec', { untilMs: now - 1, setBy: 'operator' });
    caps.disablePermanent('worker_spawn', { setBy: 'operator' });
    const data = fetchPermissionsData({ registry, caps, perms, now });
    expect(data.disabledCount).toBe(1);
  });

  it('emptyPermissionsData returns a stable empty shape with known actors', () => {
    const e = emptyPermissionsData();
    expect(e.toolCount).toBe(0);
    expect(e.disabledCount).toBe(0);
    expect(e.matrix).toEqual([]);
    expect(e.actors.length).toBeGreaterThan(0);
  });
});

describe('renderPermissionsPage', () => {
  it('renders Layer 0 + matrix sections + the disabled-count header', () => {
    caps.disablePermanent('host_exec', { setBy: 'operator', reason: 'pause' });
    perms.set('cowork-claude', 'worker_spawn', 'NO_GO', 'operator');
    const html = renderPermissionsPage(
      fetchPermissionsData({ registry, caps, perms }),
    );
    expect(html).toContain('Permissions');
    expect(html).toContain('Layer 0');
    expect(html).toContain('Per-actor permissions matrix');
    expect(html).toContain('3 tools');
    expect(html).toContain('1 disabled');
    expect(html).toContain('host_exec');
    expect(html).toContain('worker_spawn');
  });

  it('marks the host_exec row DISABLED + worker_spawn ENABLED', () => {
    caps.disablePermanent('host_exec', { setBy: 'operator', reason: 'audit pause' });
    const html = renderPermissionsPage(
      fetchPermissionsData({ registry, caps, perms }),
    );
    expect(html).toContain('perm-pill-off');
    expect(html).toContain('audit pause');
    expect(html).toContain('Re-enable');
    // worker_spawn (still enabled) shows a Disable button
    expect(html).toContain('Disable');
  });

  it('renders the matrix tier dropdowns with the current effective tier selected', () => {
    perms.set('cowork-claude', 'worker_spawn', 'NO_GO', 'operator');
    const html = renderPermissionsPage(
      fetchPermissionsData({ registry, caps, perms }),
    );
    expect(html).toContain('data-role="perm-tier"');
    // selected option for NO_GO on the cowork-claude/worker_spawn cell
    expect(html).toMatch(/value="NO_GO"[^>]*selected/);
  });

  it('marks default-source cells distinctly from matrix-source cells', () => {
    perms.set('cowork-claude', 'host_exec', 'EXPLICIT', 'operator');
    const html = renderPermissionsPage(
      fetchPermissionsData({ registry, caps, perms }),
    );
    expect(html).toContain('perm-cell-matrix');
    expect(html).toContain('perm-cell-default');
  });

  it('escapes HTML in user-supplied fields (e.g., reason)', () => {
    caps.disablePermanent('host_exec', { setBy: 'operator', reason: '<script>alert(1)</script>' });
    const html = renderPermissionsPage(
      fetchPermissionsData({ registry, caps, perms }),
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('surfaces the named-policy apply affordance (v0.6.9 P6)', () => {
    const html = renderPermissionsPage(fetchPermissionsData({ registry, caps, perms }));
    expect(html).toContain('Apply policy');
    expect(html).toContain('data-role="perm-policy-select"');
    expect(html).toContain('data-role="perm-policy-actor"');
    expect(html).toContain('data-role="perm-policy-apply"');
    // The three built-in presets are rendered as options.
    expect(html).toContain('>Tight<');
    expect(html).toContain('>Developer<');
    expect(html).toContain('>Review-only<');
  });

  it('still notes the remaining v0.6.9 follow-up scope (Topology drawer)', () => {
    const html = renderPermissionsPage(fetchPermissionsData({ registry, caps, perms }));
    expect(html).toContain('Topology side-drawer');
  });
});

describe('Permissions nav entry', () => {
  it('appears in NAV_ENTRIES between tools and capabilities', () => {
    const ids = NAV_ENTRIES.map((e) => e.id);
    const toolsAt = ids.indexOf('tools');
    const permsAt = ids.indexOf('permissions');
    const capsAt = ids.indexOf('capabilities');
    expect(permsAt).toBe(toolsAt + 1);
    expect(permsAt).toBe(capsAt - 1);
  });

  it('points at /dashboard/permissions with label "Permissions"', () => {
    const entry = NAV_ENTRIES.find((e) => e.id === 'permissions');
    expect(entry).toBeDefined();
    expect(entry?.href).toBe('/dashboard/permissions');
    expect(entry?.label).toBe('Permissions');
  });
});
