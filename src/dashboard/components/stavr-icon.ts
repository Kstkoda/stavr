/**
 * stavR brand icon — v0.7 Phase 8.
 *
 * A 64x64 SVG of the Raido rune (ᚱ, U+16B1) used in serverInfo.icons so
 * MCP clients (Cowork, Claude Code's connector sidebar, etc.) show the
 * stavR mark instead of a generic placeholder.
 *
 * The icon ships as both a light + dark theme variant. The MCP spec
 * lets clients pick by `theme` field. Light variant uses the rust
 * accent on a near-white background; dark inverts.
 *
 * Embedded as base64 data URL so the MCP serverInfo payload is fully
 * self-contained — no separate HTTP fetch required client-side.
 */

const STAVR_RUNE_SVG_LIGHT = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <rect width="64" height="64" rx="12" fill="#f2efe7"/>
  <text x="32" y="46" text-anchor="middle" font-family="Iosevka, 'Cascadia Mono', 'Segoe UI', monospace" font-size="42" font-weight="700" fill="#c4642d">&#x16B1;</text>
</svg>`;

const STAVR_RUNE_SVG_DARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <rect width="64" height="64" rx="12" fill="#14161f"/>
  <text x="32" y="46" text-anchor="middle" font-family="Iosevka, 'Cascadia Mono', 'Segoe UI', monospace" font-size="42" font-weight="700" fill="#e8b48b">&#x16B1;</text>
</svg>`;

/** Encode raw SVG markup as a data URL. */
function dataUrl(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

/** The icon-set we advertise via MCP serverInfo. Two themed variants;
 *  every variant is 64x64 — small enough to embed inline, large enough
 *  to render cleanly in any client. */
export const STAVR_MCP_ICONS = [
  {
    src: dataUrl(STAVR_RUNE_SVG_LIGHT),
    mimeType: 'image/svg+xml',
    sizes: ['64x64'],
    theme: 'light' as const,
  },
  {
    src: dataUrl(STAVR_RUNE_SVG_DARK),
    mimeType: 'image/svg+xml',
    sizes: ['64x64'],
    theme: 'dark' as const,
  },
];

/** Plain-text description we advertise alongside the icons. Matches the
 *  positioning in ADR-034 + the dashboard /about page. */
export const STAVR_MCP_DESCRIPTION =
  'Personal MCP gateway daemon. Local-first authority and audit layer brokering ' +
  'tool access between AI assistants and your tools.';

export const STAVR_WEBSITE_URL = 'https://github.com/Kstkoda/stavr';
