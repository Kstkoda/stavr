import { describe, expect, it } from 'vitest';
import { renderBrick } from '../../../src/dashboard/components/brick.js';

describe('brick component', () => {
  it('emits an svg with the supplied display name, kind, and id', () => {
    const html = renderBrick({
      id: 'github',
      kind: 'connector-above',
      displayName: 'GitHub',
      position: 'above',
      status: 'idle',
    });
    expect(html.startsWith('<svg class="brick"')).toBe(true);
    expect(html).toContain('data-id="github"');
    expect(html).toContain('data-kind="connector-above"');
    expect(html).toContain('data-position="above"');
    expect(html).toContain('>GitHub</text>');
    // Status dot is present when status is supplied.
    expect(html).toContain('brick-status');
  });

  it('omits the status dot when status is undefined', () => {
    const html = renderBrick({ id: 'x', kind: 'mcp', displayName: 'mcp' });
    expect(html).not.toContain('brick-status');
  });

  it('renders one circle per stud (default 4)', () => {
    const html = renderBrick({ id: 'x', kind: 'ai-external', displayName: 'Claude' });
    const studs = html.match(/<circle [^>]*r="5"/g);
    expect(studs?.length).toBe(4);
  });

  it('honors a custom stud count, clamped to [1, 8]', () => {
    const six = renderBrick({ id: 'x', kind: 'mcp', displayName: 'x', studs: 6 });
    expect((six.match(/<circle [^>]*r="5"/g) ?? []).length).toBe(6);
    const tooMany = renderBrick({ id: 'x', kind: 'mcp', displayName: 'x', studs: 99 });
    expect((tooMany.match(/<circle [^>]*r="5"/g) ?? []).length).toBe(8);
    const tooFew = renderBrick({ id: 'x', kind: 'mcp', displayName: 'x', studs: 0 });
    expect((tooFew.match(/<circle [^>]*r="5"/g) ?? []).length).toBe(1);
  });

  it('maps each kind to its color custom-property', () => {
    expect(renderBrick({ id: 'a', kind: 'ai-external',     displayName: 'a' })).toContain('var(--accent-ai-external)');
    expect(renderBrick({ id: 'b', kind: 'ai-internal',     displayName: 'b' })).toContain('var(--accent-ai-internal)');
    expect(renderBrick({ id: 'c', kind: 'mcp',             displayName: 'c' })).toContain('var(--accent-mcp)');
    expect(renderBrick({ id: 'd', kind: 'steward',         displayName: 'd' })).toContain('var(--accent-steward)');
    expect(renderBrick({ id: 'e', kind: 'connector-above', displayName: 'e' })).toContain('var(--accent-connector-above)');
    expect(renderBrick({ id: 'f', kind: 'connector-below', displayName: 'f' })).toContain('var(--accent-connector-below)');
  });

  it('escapes the display name', () => {
    const html = renderBrick({ id: 'x', kind: 'mcp', displayName: '<bad>' });
    expect(html).toContain('&lt;bad&gt;');
    expect(html).not.toContain('<bad>');
  });
});
