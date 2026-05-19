/**
 * tests/dashboard/stavr-icon.test.ts
 *
 * Coverage for the MCP serverInfo icon advertisement (v0.7 Phase 8).
 * Verifies the icon-set shape MCP clients consume + that the Raido
 * rune codepoint actually appears in the SVG bytes.
 */
import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import {
  STAVR_MCP_ICONS,
  STAVR_MCP_DESCRIPTION,
  STAVR_WEBSITE_URL,
} from '../../src/dashboard/components/stavr-icon.js';

function decodeDataUrl(dataUrl: string): string {
  const [, payload] = dataUrl.split('base64,');
  return Buffer.from(payload ?? '', 'base64').toString('utf8');
}

describe('stavR MCP icon advertisement', () => {
  it('ships two themed variants (light + dark)', () => {
    expect(STAVR_MCP_ICONS).toHaveLength(2);
    const themes = STAVR_MCP_ICONS.map((i) => i.theme);
    expect(new Set(themes)).toEqual(new Set(['light', 'dark']));
  });

  it('each variant has mimeType image/svg+xml + 64x64 size', () => {
    for (const icon of STAVR_MCP_ICONS) {
      expect(icon.mimeType).toBe('image/svg+xml');
      expect(icon.sizes).toEqual(['64x64']);
    }
  });

  it('each src is a base64-encoded data URL', () => {
    for (const icon of STAVR_MCP_ICONS) {
      expect(icon.src.startsWith('data:image/svg+xml;base64,')).toBe(true);
    }
  });

  it('decoded SVG contains the Raido rune codepoint reference', () => {
    for (const icon of STAVR_MCP_ICONS) {
      const svg = decodeDataUrl(icon.src);
      expect(svg).toContain('<svg');
      expect(svg).toContain('viewBox="0 0 64 64"');
      // The rune itself is referenced via the &#x16B1; HTML entity in the
      // SVG <text> element so it survives non-UTF8 build pipelines.
      expect(svg).toContain('&#x16B1;');
    }
  });

  it('exports a plain-language description', () => {
    expect(STAVR_MCP_DESCRIPTION.toLowerCase()).toContain('personal mcp gateway');
    expect(STAVR_MCP_DESCRIPTION).toContain('Local-first');
  });

  it('exports the canonical website URL', () => {
    expect(STAVR_WEBSITE_URL).toBe('https://github.com/Kstkoda/stavr');
  });
});
