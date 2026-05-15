import { describe, expect, it } from 'vitest';
import { renderPill } from '../../../src/dashboard/components/pill.js';

describe('pill component', () => {
  it('renders a neutral pill by default', () => {
    expect(renderPill({ text: 'Idle' })).toContain('pill-neutral');
  });

  it('applies the variant class and escapes the text', () => {
    const html = renderPill({ text: '<x>', variant: 'profile-turbo' });
    expect(html).toContain('pill-profile-turbo');
    expect(html).toContain('&lt;x&gt;');
  });

  it('emits the title attribute when supplied', () => {
    expect(renderPill({ text: 'a', title: 'hover me' })).toContain('title="hover me"');
  });
});
