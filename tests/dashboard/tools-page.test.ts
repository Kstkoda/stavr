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
  r.record(buildMetadata('job_dispatch', { description: 'dispatch job' }, 'jobs/tools.ts'));
  r.record(buildMetadata('job_list', { description: 'list jobs' }, 'jobs/tools.ts'));
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
      'job_dispatch',
      'job_list',
      'trust_scope_grant',
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
    expect(byId.job_dispatch.defaultTier).toBe('CONFIRM');
    expect(byId.job_dispatch.reversibility).toBe('irreversible');
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
    for (const id of ['job_dispatch', 'job_list', 'emit_event', 'host_exec', 'trust_scope_grant']) {
      expect(html).toContain(id);
    }
    // tier styling classes appear (CONFIRM for job_dispatch, EXPLICIT for host_exec)
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

  // v0.6 Task 4 Phase B — grouped layout + critical-tools pinning.
  it('pins EXPLICIT + NO_GO tools into a "Critical" section at the top', () => {
    const html = renderToolsPage(fetchToolsData(populated()));
    expect(html).toContain('tools-pinned');
    expect(html).toContain('Critical');
    // host_exec (EXPLICIT) lands in the pinned section before any
    // <details> category group.
    const pinnedAt = html.indexOf('tools-pinned');
    const firstDetails = html.indexOf('<details class="tools-group"');
    expect(pinnedAt).toBeGreaterThan(0);
    expect(firstDetails).toBeGreaterThan(pinnedAt);
  });

  it('groups remaining cards by category in collapsible <details> sections', () => {
    const html = renderToolsPage(fetchToolsData(populated()));
    expect(html).toContain('<details class="tools-group" data-role="tools-group"');
    expect(html).toContain('data-category="worker"');
    expect(html).toContain('data-category="event"');
    expect(html).toContain('data-category="shell"');
    expect(html).toContain('data-category="scope"');
  });

  it('default-collapses the github category when present', () => {
    const r = new ToolRegistry();
    r.record(buildMetadata('emit_event', { description: 'evt' }, 'server'));
    r.record(buildMetadata('github.create_pr', { description: 'create PR' }, 'adapters/github-writes'));
    r.record(buildMetadata('github.read_pr', { description: 'read PR' }, 'adapters/github'));
    const html = renderToolsPage(fetchToolsData(r));
    expect(html).toContain('data-category="github"');
    // github group is rendered WITHOUT `open` attribute on the <details>
    expect(html).toMatch(/<details class="tools-group" data-role="tools-group" data-category="github"(?!\s*open)/);
    // other categories open by default
    expect(html).toMatch(/<details class="tools-group" data-role="tools-group" data-category="event" open/);
  });

  it('categorizes MCP-namespace dot-prefix tools to the same family as the underscore form', () => {
    const r = new ToolRegistry();
    r.record(buildMetadata('github.list_issues', { description: 'list issues' }, 'adapters/github'));
    const html = renderToolsPage(fetchToolsData(r));
    expect(html).toContain('data-category="github"');
    // No `data-category="other"` for the github.* tool.
    expect(html).not.toMatch(/data-id="github\.list_issues"[\s\S]*?data-category="other"/);
  });
});

describe('Tools nav entry', () => {
  it('appears in NAV_ENTRIES immediately after mcps (permissions sits between tools and capabilities post-PR #2)', () => {
    const ids = NAV_ENTRIES.map((e) => e.id);
    const mcpsAt = ids.indexOf('mcps');
    const toolsAt = ids.indexOf('tools');
    const permsAt = ids.indexOf('permissions');
    expect(mcpsAt).toBeGreaterThan(-1);
    expect(toolsAt).toBeGreaterThan(-1);
    expect(toolsAt).toBe(mcpsAt + 1);
    if (permsAt > -1) {
      // v0.6.9 PR #2 inserts permissions between tools and capabilities
      expect(permsAt).toBe(toolsAt + 1);
    }
  });

  it('points at /dashboard/tools', () => {
    const entry = NAV_ENTRIES.find((e) => e.id === 'tools');
    expect(entry).toBeDefined();
    expect(entry?.href).toBe('/dashboard/tools');
    expect(entry?.label).toBe('Tools');
  });
});
