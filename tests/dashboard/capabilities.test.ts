/**
 * C8 acceptance — Capabilities page.
 */
import { describe, expect, it } from 'vitest';
import { renderCapabilitiesPage } from '../../src/dashboard/pages/capabilities.js';
import { CAPABILITY_TAGS, DEFAULT_PROFILES } from '../../src/types/stavr-bom.js';

describe('Capabilities page — unit', () => {
  it('renders one slot per CapabilityTag', () => {
    const html = renderCapabilitiesPage({ activeMode: 'balanced' });
    // Slice out the baseplate so the embedded JS template doesn't pollute the count.
    const m = html.match(/<div class="baseplate"[^>]*>([\s\S]*?)<\/div>\s*<div class="budgets">/);
    expect(m).not.toBeNull();
    const baseplate = m![1];
    for (const tag of CAPABILITY_TAGS) {
      expect(baseplate).toContain(`data-tag="${tag}"`);
    }
    const slots = baseplate.match(/<div class="cap-slot"/g);
    expect(slots?.length).toBe(CAPABILITY_TAGS.length);
  });

  it('renders the profile-mode toggle with all three modes and the active one flagged', () => {
    const html = renderCapabilitiesPage({ activeMode: 'turbo' });
    expect(html).toContain('data-mode="turbo"');
    expect(html).toContain('data-mode="balanced"');
    expect(html).toContain('data-mode="eco"');
    expect(html).toMatch(/data-mode="turbo"\s+data-active="true"/);
    expect(html).toMatch(/data-mode="balanced"\s+data-active="false"/);
  });

  it('uses the routing table for the active mode by default', () => {
    const balanced = renderCapabilitiesPage({ activeMode: 'balanced' });
    // balanced.code-reasoning routes to opus-4-7 first, so the slot should
    // show opus + tier opus.
    const reCodeR = balanced.match(/data-tag="code-reasoning"\s+data-tier="([^"]+)"/);
    expect(reCodeR?.[1]).toBe('opus');
    expect(balanced).toContain('opus 4.7');
  });

  it('switches the rendered baseplate when the active mode changes', () => {
    const turbo = renderCapabilitiesPage({ activeMode: 'turbo' });
    const eco = renderCapabilitiesPage({ activeMode: 'eco' });
    // Pull out the cap-reading slot tier from each render.
    const tTurbo = turbo.match(/data-tag="reading"\s+data-tier="([^"]+)"/)?.[1];
    const tEco = eco.match(/data-tag="reading"\s+data-tier="([^"]+)"/)?.[1];
    expect(tTurbo).toBeDefined();
    expect(tEco).toBeDefined();
    // Both default to haiku for reading per DEFAULT_PROFILES. The test
    // value is that the data-mode attribute on the baseplate differs.
    expect(turbo).toContain('class="baseplate" data-mode="turbo"');
    expect(eco).toContain('class="baseplate" data-mode="eco"');
  });

  it('renders one budget card per profile mode with the profile description', () => {
    const html = renderCapabilitiesPage({ activeMode: 'balanced' });
    for (const mode of ['turbo', 'balanced', 'eco'] as const) {
      expect(html).toContain(`<article class="budget-card" data-mode="${mode}">`);
      expect(html).toContain(DEFAULT_PROFILES[mode].description);
    }
  });

  it('serialises profiles into a JSON block so the client can re-render on toggle', () => {
    const html = renderCapabilitiesPage({ activeMode: 'balanced' });
    expect(html).toContain('id="cap-profiles"');
    // Routing dictionary keys should be present.
    expect(html).toContain('"routing":');
    expect(html).toContain('"code-reasoning"');
  });

  it('flags itself read-only with a link to Settings', () => {
    const html = renderCapabilitiesPage({ activeMode: 'balanced' });
    // v0.4 changed the surface from "v0.3 read-only" to "matrix + Ollama models;
    // persisting picks lands in v0.5"; the link to Settings stays.
    expect(html).toContain('v0.4');
    expect(html).toContain('/dashboard/settings');
  });
});
