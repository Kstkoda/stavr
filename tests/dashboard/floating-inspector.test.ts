import { describe, expect, it } from 'vitest';
import {
  FLOATING_INSPECTOR_CSS,
  FLOATING_INSPECTOR_JS,
  renderFloatingInspectorShell,
} from '../../src/dashboard/components/floating-inspector.js';
import { renderShell } from '../../src/dashboard/shell.js';

describe('floating inspector', () => {
  it('renders a single hidden shell ready to be mutated by the client API', () => {
    const html = renderFloatingInspectorShell();
    expect(html).toContain('data-role="float-inspector"');
    // Default state — aria-hidden true; the visible flip happens
    // client-side via the openAt API. No data-open attribute in markup.
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('data-open=');
    expect(html).toContain('class="float-inspector"');
  });

  it('CSS uses the rust-glow + glass-blur tokens (v8 visual language)', () => {
    expect(FLOATING_INSPECTOR_CSS).toContain('var(--rust-glow)');
    expect(FLOATING_INSPECTOR_CSS).toContain('var(--glass-blur)');
    expect(FLOATING_INSPECTOR_CSS).toContain('var(--bg-popover)');
  });

  it('client JS exposes the openAt + close API on window', () => {
    expect(FLOATING_INSPECTOR_JS).toContain('__stavrFloatingInspector');
    expect(FLOATING_INSPECTOR_JS).toContain('openAt');
    expect(FLOATING_INSPECTOR_JS).toContain('close');
    // Outside-click + Escape dismissal must both be wired so the popover
    // doesn't trap focus.
    expect(FLOATING_INSPECTOR_JS).toContain("ev.key === 'Escape'");
    expect(FLOATING_INSPECTOR_JS).toContain('addEventListener');
  });

  it('is mounted into the shell exactly once per page', () => {
    const html = renderShell({ title: 't', activePage: 'helm', body: '' });
    // The shell inlines the inspector JS in a <script>, so the string also
    // appears in the JS source. Strip <script>...</script> blocks before
    // counting the actual DOM mounts.
    const markupOnly = html.replace(/<script[\s\S]*?<\/script>/g, '');
    const count = markupOnly.split('data-role="float-inspector"').length - 1;
    expect(count).toBe(1);
  });
});
