import { describe, expect, it } from 'vitest';
import { ToolRegistry, buildMetadata } from '../../src/tools/registry.js';
import {
  fetchToolsData,
  emptyToolsData,
} from '../../src/dashboard/data/tools-data.js';
import { renderToolsPage } from '../../src/dashboard/pages/tools.js';
import { NAV_ENTRIES } from '../../src/dashboard/shell.js';

function populated(): ToolRegistry {
  const r = new ToolRegistry();
  r.record(buildMetadata('worker_spawn', { description: 'spawn worker' }, 'workers/tools.ts'));
  r.record(buildMetadata('worker_list', { description: 'list workers' }, 'workers/tools.ts'));
  r.record(buildMetadata('emit_event', { description: 'publish event' }, 'server.ts'));
  r.record(buildMetadata('host_exec', { description: 'arbitrary shell' }, 'security/host-exec-tool.ts'));
  r.record(buildMetadata('trust_scope_grant', { description: 'grant scope' }, 'trust/tools.ts'));
  return r;
}

describe('fetchToolsData', () => {
  it('returns counts + category breakdown + flat tool list', () => {
    const data = fetchToolsData(populated());
    expect(data.registeredCount).toBe(5);
    expect(data.categoriesPresent.sort()).toEqual(['event', 'scope', 'shell', 'worker']);
    const counts = Object.fromEntries(data.byCategory.map((c) => [c.category, c.count]));
    expect(counts.worker).toBe(2);
    expect(counts.event).toBe(1);
    expect(counts.shell).toBe(1);
    expect(counts.scope).toBe(1);
    expect(data.tools.map((t) => t.id)).toEqual([
      'emit_event',
      'host_exec',
      'trust_scope_grant',
      'worker_list',
      'worker_spawn',
    ]);
  });

  it('returns null callsLast24h for every tool until PR #2 wiring', () => {
    const data = fetchToolsData(populated());
    expect(data.invocationTrackingEnabled).toBe(false);
    for (const t of data.tools) {
      expect(t.callsLast24h).toBeNull();
    }
  });

  it('rows carry the tier + reversibility heuristic results', () => {
    const data = fetchToolsData(populated());
    const byId = Object.fromEntries(data.tools.map((t) => [t.id, t]));
    expect(byId.worker_spawn.defaultTier).toBe('CONFIRM');
    expect(byId.worker_spawn.reversibility).toBe('irreversible');
    expect(byId.emit_event.defaultTier).toBe('AUTO');
    expect(byId.emit_event.reversibility).toBe('reversible');
    expect(byId.host_exec.defaultTier).toBe('EXPLICIT');
    expect(byId.host_exec.reversibility).toBe('irreversible');
  });

  it('emptyToolsData returns a stable empty shape', () => {
    const empty = emptyToolsData();
    expect(empty.registeredCount).toBe(0);
    expect(empty.tools).toEqual([]);
    expect(empty.byCategory).toEqual([]);
    expect(empty.categoriesPresent).toEqual([]);
    expect(empty.invocationTrackingEnabled).toBe(false);
  });
});

describe('renderToolsPage', () => {
  it('renders the page shell with the Tools page id active', () => {
    const html = renderToolsPage(fetchToolsData(populated()));
    expect(html).toContain('Stavr — Tools');
    // shell exposes activePage via data attribute or class
    expect(html).toContain('Tools');
    // contains the iron-palette page title pattern
    expect(html).toContain('page-title');
  });

  it('shows the registered-count header reflecting registry size', () => {
    const html = renderToolsPage(fetchToolsData(populated()));
    expect(html).toContain('5 registered');
  });

  it('renders one card per registered tool with category + tier + reversibility', () => {
    const html = renderToolsPage(fetchToolsData(populated()));
    // every tool id is mentioned
    for (const id of ['worker_spawn', 'worker_list', 'emit_event', 'host_exec', 'trust_scope_grant']) {
      expect(html).toContain(id);
    }
    // tier styling classes appear (CONFIRM for worker_spawn, EXPLICIT for host_exec)
    expect(html).toContain('tools-tier-CONFIRM');
    expect(html).toContain('tools-tier-EXPLICIT');
    expect(html).toContain('tools-tier-AUTO');
    // reversibility tag
    expect(html).toContain('tools-rev-irreversible');
    expect(html).toContain('tools-rev-reversible');
  });

  it('shows the pending-tracking banner when invocationTrackingEnabled = false', () => {
    const html = renderToolsPage(fetchToolsData(populated()));
    expect(html).toContain('Per-tool invocation tracking');
    expect(html).toContain('PR #2');
  });

  it('exposes search + category + tier toolbars on the page', () => {
    const html = renderToolsPage(fetchToolsData(populated()));
    expect(html).toContain('data-role="tools-search"');
    expect(html).toContain('data-role="tools-cat"');
    expect(html).toContain('data-role="tools-tier"');
  });

  it('escapes html in tool descriptions', () => {
    const r = new ToolRegistry();
    r.record(buildMetadata('emit_event', { description: '<script>alert(1)</script>' }, 'server'));
    const html = renderToolsPage(fetchToolsData(r));
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('shows the placeholder when no tools are registered', () => {
    const html = renderToolsPage(emptyToolsData());
    expect(html).toContain('No tools registered yet');
  });

  it('renders the search-data attribute so client-side filter can match', () => {
    const html = renderToolsPage(fetchToolsData(populated()));
    expect(html).toContain('data-search=');
  });
});

describe('Tools nav entry', () => {
  it('appears in NAV_ENTRIES between mcps and capabilities', () => {
    const ids = NAV_ENTRIES.map((e) => e.id);
    const mcpsAt = ids.indexOf('mcps');
    const toolsAt = ids.indexOf('tools');
    const capsAt = ids.indexOf('capabilities');
    expect(mcpsAt).toBeGreaterThan(-1);
    expect(toolsAt).toBeGreaterThan(-1);
    expect(capsAt).toBeGreaterThan(-1);
    expect(toolsAt).toBe(mcpsAt + 1);
    expect(toolsAt).toBe(capsAt - 1);
  });

  it('points at /dashboard/tools', () => {
    const entry = NAV_ENTRIES.find((e) => e.id === 'tools');
    expect(entry).toBeDefined();
    expect(entry?.href).toBe('/dashboard/tools');
    expect(entry?.label).toBe('Tools');
  });
});
