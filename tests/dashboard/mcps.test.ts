import { describe, expect, it } from 'vitest';
import { renderMcpsPage } from '../../src/dashboard/pages/mcps.js';
import { MCP_REGISTRY } from '../../src/dashboard/data/mcp-registry.js';

describe('MCPs page', () => {
  it('the static registry snapshot has at least 25 entries (matches Phase 4 acceptance criterion)', () => {
    expect(MCP_REGISTRY.length).toBeGreaterThanOrEqual(25);
  });

  it('every registry entry has the required shape', () => {
    for (const e of MCP_REGISTRY) {
      expect(e.id).toMatch(/^[a-z0-9-]+$/);
      expect(e.name.length).toBeGreaterThan(0);
      expect(e.author.length).toBeGreaterThan(0);
      expect(e.description.length).toBeGreaterThan(5);
      expect(e.install_url).toMatch(/^https?:\/\//);
      expect(['dev','database','browser','productivity','game','design','monitoring','cloud','comms'])
        .toContain(e.category);
    }
  });

  it('renders three tabs and a card per registry entry', () => {
    const html = renderMcpsPage({ installed: [] });
    expect(html).toContain('Browse · ' + MCP_REGISTRY.length);
    expect(html).toContain('Installed · 0');
    expect(html).toContain('Auth-needed · 0');
    for (const e of MCP_REGISTRY.slice(0, 3)) {
      expect(html).toContain(`data-id="${e.id}"`);
      expect(html).toContain(e.name);
    }
  });

  it('renders search + sort + category controls', () => {
    const html = renderMcpsPage({ installed: [] });
    expect(html).toContain('data-role="mcp-search"');
    expect(html).toContain('data-role="mcp-sort"');
    expect(html).toContain('data-role="mcp-cat"');
  });

  it('Installed tab lists the supplied bricks', () => {
    const html = renderMcpsPage({
      installed: [
        { id: 'github', display_name: 'GitHub', kind: 'mcp', enabled: true },
        { id: 'shell',  display_name: 'Shell',  kind: 'http', enabled: false },
      ],
    });
    expect(html).toContain('Installed · 2');
    expect(html).toContain('<code>github</code>');
    expect(html).toContain('<code>shell</code>');
    expect(html).toContain('enabled');
    expect(html).toContain('disabled');
  });

  it('Auth-needed tab counts only bricks flagged needs_auth', () => {
    const html = renderMcpsPage({
      installed: [
        { id: 'github', display_name: 'GitHub', kind: 'mcp', enabled: true, needs_auth: true },
        { id: 'fs',     display_name: 'fs',     kind: 'mcp', enabled: true },
      ],
    });
    expect(html).toContain('Auth-needed · 1');
  });

  it('Install button surfaces the v0.4 "paste into manifest.yaml" workaround as a tooltip', () => {
    const html = renderMcpsPage({ installed: [] });
    expect(html).toContain('Coming soon — paste URL in ~/.stavr/bricks/manifest.yaml for now');
  });

  it('highlights the mcps tab in the top nav', () => {
    const html = renderMcpsPage({ installed: [] });
    expect(html).toMatch(/data-page="mcps"\s+aria-current="page"/);
  });
});
