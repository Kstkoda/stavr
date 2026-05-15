import { describe, expect, it } from 'vitest';
import { renderFoodLabel } from '../../../src/dashboard/components/food-label.js';

describe('food-label component', () => {
  it('renders all four cells with the input values', () => {
    const html = renderFoodLabel({
      name: 'Rotate API key',
      what: 'Rotates the production Anthropic key.',
      riskClass: 'high',
      reversible: 'no',
      costUsd: 0.42,
    });
    expect(html).toContain('Rotate API key');
    expect(html).toContain('Rotates the production Anthropic key.');
    expect(html).toContain('Risk');
    expect(html).toContain('High');
    expect(html).toContain('Reversible');
    expect(html).toContain('✗ No');
    expect(html).toContain('$0.42');
    expect(html).toContain('data-risk="high"');
  });

  it('formats sub-cent costs as <$0.01 and missing costs as $0.00', () => {
    const sub = renderFoodLabel({
      name: 'x', what: 'y', riskClass: 'low', reversible: 'yes', costUsd: 0.001,
    });
    expect(sub).toContain('&lt;$0.01');
    const zero = renderFoodLabel({
      name: 'x', what: 'y', riskClass: 'low', reversible: 'yes', costUsd: 0,
    });
    expect(zero).toContain('$0.00');
  });

  it('escapes user-supplied strings to prevent injection', () => {
    const html = renderFoodLabel({
      name: '<script>alert(1)</script>',
      what: 'a "quoted" & dangerous value',
      riskClass: 'medium',
      reversible: 'partial',
      costUsd: 1,
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&quot;quoted&quot;');
    expect(html).toContain('&amp;');
  });

  it('wraps the card in an <a> when href is provided', () => {
    const html = renderFoodLabel({
      name: 'x', what: 'y', riskClass: 'low', reversible: 'yes', costUsd: 0,
      href: '/dashboard/plans/bom-123',
    });
    expect(html.startsWith('<a class="food-label"')).toBe(true);
    expect(html).toContain('href="/dashboard/plans/bom-123"');
  });

  it('emits the model-mix indicator when supplied', () => {
    const html = renderFoodLabel({
      name: 'x', what: 'y', riskClass: 'low', reversible: 'yes', costUsd: 0,
      modelMix: 'Sonnet · Opus',
    });
    expect(html).toContain('Sonnet · Opus');
    expect(html).toContain('fl-mix');
  });
});
