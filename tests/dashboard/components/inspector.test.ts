import { describe, expect, it } from 'vitest';
import { renderInspectorPanel, INSPECTOR_JS } from '../../../src/dashboard/components/inspector.js';

describe('inspector component', () => {
  it('renders an aside with head, body, foot, and is hidden by default', () => {
    const html = renderInspectorPanel();
    expect(html).toContain('id="inspector"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('data-role="title"');
    expect(html).toContain('data-role="body"');
    expect(html).toContain('data-role="foot"');
    expect(html).toContain('data-role="close"');
  });

  it('exposes openInspector / closeInspector on window via inline JS', () => {
    expect(INSPECTOR_JS).toContain('window.openInspector');
    expect(INSPECTOR_JS).toContain('window.closeInspector');
    // The handler must wire the close button.
    expect(INSPECTOR_JS).toContain("addEventListener('click'");
  });
});
