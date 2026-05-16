import { describe, expect, it } from 'vitest';
import { renderCapabilitiesPage } from '../../src/dashboard/pages/capabilities.js';
import { CAPABILITY_TAGS } from '../../src/types/stavr-bom.js';

describe('Capabilities — v0.4 per-profile matrix + Steward card', () => {
  it('renders the Steward pinned card with a model dropdown', () => {
    const html = renderCapabilitiesPage({ activeMode: 'balanced', ollamaModels: ['llama3.2:3b'] });
    expect(html).toContain('data-role="steward-card"');
    expect(html).toContain('data-role="steward-model"');
    // The dropdown should include both frontier + Ollama options.
    expect(html).toContain('claude-opus-4-7');
    expect(html).toContain('llama3.2:3b');
  });

  it('renders the 14 × 3 matrix with one cell per capability × profile mode', () => {
    const html = renderCapabilitiesPage({ activeMode: 'balanced' });
    expect(html).toContain('class="cm-matrix"');
    // 14 capability rows (10 original + 4 local-* added in v0.4).
    expect(CAPABILITY_TAGS.length).toBe(14);
    // Spot-check: cm-cell with mode + tag attributes exist.
    expect(html).toContain('data-mode="turbo"');
    expect(html).toContain('data-mode="balanced"');
    expect(html).toContain('data-mode="eco"');
    expect(html).toContain('data-tag="cheap-classifier"');
    expect(html).toContain('data-tag="local-summary"');
  });

  it('flags a missing local model with a warning marker', () => {
    // Balanced.cheap-classifier first choice is llama3.2:3b; passing no
    // ollamaModels means the local model is "not pulled" → warning.
    const html = renderCapabilitiesPage({ activeMode: 'balanced', ollamaModels: [] });
    expect(html).toMatch(/data-mode="balanced"\s+data-tag="cheap-classifier"\s+data-tier="other"\s+data-warn="missing"/);
  });

  it('no warning when the local model IS available', () => {
    const html = renderCapabilitiesPage({ activeMode: 'balanced', ollamaModels: ['llama3.2:3b'] });
    // Should NOT have the warn attribute on cheap-classifier × balanced.
    const cell = html.match(/data-mode="balanced"\s+data-tag="cheap-classifier"[^>]*>/);
    expect(cell).toBeTruthy();
    expect(cell![0].includes('data-warn="missing"')).toBe(false);
  });

  it('Turbo column never has a local-model warning since Turbo never routes locally', () => {
    const html = renderCapabilitiesPage({ activeMode: 'balanced', ollamaModels: [] });
    // Any cell with data-mode="turbo" should never carry data-warn="missing".
    const re = /data-mode="turbo"[^>]*data-warn="missing"/;
    expect(re.test(html)).toBe(false);
  });
});
