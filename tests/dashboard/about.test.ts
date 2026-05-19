/**
 * tests/dashboard/about.test.ts
 *
 * Render coverage for the /dashboard/about page (v0.7 Phase 6).
 * Non-developer landing page; we assert on the load-bearing structural
 * pieces (Raido rune wordmark, links to family-mode + docs, brain-mode
 * "coming soon" pointer).
 */
import { describe, expect, it } from 'vitest';
import { renderAboutPage } from '../../src/dashboard/pages/about.js';

describe('renderAboutPage', () => {
  it('renders the page title', () => {
    const html = renderAboutPage();
    expect(html).toContain('About');
  });

  it('renders the Raido rune wordmark (ᚱ, U+16B1)', () => {
    const html = renderAboutPage();
    // The page uses a numeric HTML entity for the rune so it survives
    // HTML round-trips across editors and CRLF.
    expect(html).toContain('stav&#x16B1;');
  });

  it('describes stavR in plain language without jargon', () => {
    const html = renderAboutPage();
    expect(html).toContain('personal MCP gateway');
    expect(html).toContain('1Password for AI tool access');
  });

  it('mentions brain modes as v0.8 coming-soon', () => {
    const html = renderAboutPage();
    expect(html).toContain('Brain modes');
    expect(html).toContain('coming in v0.8');
    expect(html).toContain('Shadow');
    expect(html).toContain('Cloud');
    expect(html).toContain('Local');
  });

  it('links to family-mode + setup docs + passkey settings', () => {
    const html = renderAboutPage();
    expect(html).toContain('/dashboard/family-mode');
    expect(html).toContain('/dashboard/settings#identity');
    expect(html).toContain('docs/family-mode.md');
  });

  it('explains the topbar chips', () => {
    const html = renderAboutPage();
    expect(html).toContain('WATCH OK');
    expect(html).toContain('Turbo');
  });
});
