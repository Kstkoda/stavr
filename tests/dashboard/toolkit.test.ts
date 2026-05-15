/**
 * C7 acceptance — Toolkit page.
 */
import { describe, expect, it } from 'vitest';
import { renderToolkitPage, type ToolkitBrick, type ToolkitData } from '../../src/dashboard/pages/toolkit.js';
import type { ConfigFieldSchema } from '../../src/connectors/index.js';

function brick(over: Partial<ToolkitBrick> = {}): ToolkitBrick {
  return {
    id: 'b_' + Math.random().toString(36).slice(2, 6),
    kind: 'mcp',
    displayName: 'sample',
    position: 'above',
    configSchema: [],
    status: { kind: 'ok', detail: 'fine', lastChecked: new Date().toISOString() },
    ...over,
  };
}

function snap(over: Partial<ToolkitData> = {}): ToolkitData {
  return { bricks: [], ...over };
}

describe('Toolkit page — unit', () => {
  it('lays bricks above and below the bus', () => {
    const html = renderToolkitPage(snap({
      bricks: [
        brick({ id: 'a', position: 'above', displayName: 'github' }),
        brick({ id: 'b', position: 'below', displayName: 'filesystem' }),
      ],
    }));
    expect(html).toContain('class="brick-zone above"');
    expect(html).toContain('class="brick-zone below"');
    expect(html).toContain('github');
    expect(html).toContain('filesystem');
    expect(html).toContain('enterprise bus · steward');
  });

  it('shows zone placeholders when a row is empty', () => {
    const html = renderToolkitPage(snap({
      bricks: [brick({ position: 'above' })],
    }));
    expect(html).toContain('data-empty="No internal bricks registered."');
  });

  it('renders a status pill per brick', () => {
    const html = renderToolkitPage(snap({
      bricks: [
        brick({ id: 'ok',  status: { kind: 'ok',          detail: '' } }),
        brick({ id: 'ns',  status: { kind: 'needs_setup', detail: '' } }),
        brick({ id: 'err', status: { kind: 'error',       detail: '' } }),
        brick({ id: 'off', status: { kind: 'disabled',    detail: '' } }),
      ],
    }));
    expect(html).toContain('pill-success');  // ok
    expect(html).toContain('pill-warning');  // needs_setup
    expect(html).toContain('pill-danger');   // error
    expect(html).toContain('pill-neutral');  // disabled
  });

  it('serialises configSchema into the page so the client renders the form', () => {
    const schema: ConfigFieldSchema[] = [
      { key: 'apiKey', label: 'API Key', kind: 'password', required: true, secret: true },
      { key: 'baseUrl', label: 'Base URL', kind: 'url', default: 'https://example.com' },
    ];
    const html = renderToolkitPage(snap({
      bricks: [brick({ id: 'gh', configSchema: schema })],
    }));
    expect(html).toContain('id="toolkit-schemas"');
    expect(html).toContain('"gh"');
    expect(html).toContain('"apiKey"');
    expect(html).toContain('"baseUrl"');
    // The secret field's default should be stripped to avoid leaking.
    expect(html).toContain('"required":true');
  });

  it('drops default values on secret fields to avoid leaking', () => {
    const schema: ConfigFieldSchema[] = [
      { key: 'pw', label: 'PW', kind: 'password', secret: true, default: 'super-secret' },
    ];
    const html = renderToolkitPage(snap({ bricks: [brick({ id: 'x', configSchema: schema })] }));
    expect(html).not.toContain('super-secret');
  });

  it('renders the installer panel with input + button', () => {
    const html = renderToolkitPage(snap());
    expect(html).toContain('data-role="installer-path"');
    expect(html).toContain('data-role="installer-go"');
    expect(html).toContain('data-role="installer-status"');
    expect(html).toContain('Install a brick');
  });

  it('wires Save / Test buttons by data-role for the inspector', () => {
    const html = renderToolkitPage(snap({
      bricks: [brick({ id: 'gh', configSchema: [{ key: 'k', label: 'K', kind: 'text' }] })],
    }));
    // The buttons live in the inspector foot rendered at click-time by JS;
    // the page must at least carry the JS that wires them.
    expect(html).toMatch(/data-role="save"/);
    expect(html).toMatch(/data-role="test"/);
    expect(html).toContain('/dashboard/bricks/');
  });

  it('exposes a colour key sidebar', () => {
    const html = renderToolkitPage(snap());
    expect(html).toContain('Colour key');
    expect(html).toContain('external AI');
    expect(html).toContain('internal AI');
    expect(html).toContain('MCP utility');
  });
});
