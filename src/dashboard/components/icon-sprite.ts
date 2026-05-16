/**
 * Brand SVG icon sprite — 15 symbols used by Topology nodes + Diagnostics
 * rosters + Helm L0 chips. Lifted verbatim from the canonical mockup
 * design-mockups/dashboard-topology-v2-graph.html so the dashboard renders
 * the same brand glyphs (github, slack, linear, drive, ollama, fs, sqlite,
 * webhook, anthropic, meta, deepseek, worker, haiku, peer, rune).
 *
 * Injection: shell.ts renders ICON_SPRITE_SVG once per document; pages
 * reference glyphs via <svg class="icon"><use href="#i-github"/></svg>.
 *
 * Mapping (resolveIconId) keeps it simple: brick display_name match,
 * worker type, fallback to i-rune. Add new symbols here as new bricks
 * land — never sprinkle inline <path> across page modules.
 */

export const ICON_SPRITE_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" style="position:absolute;width:0;height:0;overflow:hidden" aria-hidden="true" data-role="icon-sprite">',
  '<defs>',
  '<symbol id="i-github" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.09.68-.22.68-.49v-1.7c-2.78.62-3.37-1.36-3.37-1.36-.46-1.18-1.11-1.49-1.11-1.49-.91-.63.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.89 1.57 2.34 1.12 2.91.86.09-.66.35-1.12.63-1.38-2.22-.26-4.55-1.13-4.55-5.04 0-1.11.39-2.02 1.03-2.74-.1-.26-.45-1.3.1-2.7 0 0 .84-.27 2.75 1.04A9.46 9.46 0 0 1 12 7.07c.85 0 1.71.12 2.51.34 1.91-1.31 2.75-1.04 2.75-1.04.55 1.4.2 2.44.1 2.7.64.72 1.03 1.63 1.03 2.74 0 3.92-2.34 4.78-4.57 5.03.36.32.68.94.68 1.9v2.81c0 .27.18.59.69.49C19.13 20.62 22 16.78 22 12.25 22 6.58 17.52 2 12 2z"/></symbol>',
  '<symbol id="i-slack" viewBox="0 0 24 24"><path fill="currentColor" d="M5 15.2a2.05 2.05 0 0 1-2 2.05 2.05 2.05 0 0 1-2-2.05 2.05 2.05 0 0 1 2-2.05h2v2.05zm1 0a2.05 2.05 0 0 1 2-2.05 2.05 2.05 0 0 1 2 2.05V21a2.05 2.05 0 0 1-2 2.05A2.05 2.05 0 0 1 6 21v-5.8zm2-10.2A2.05 2.05 0 0 1 6 2.95 2.05 2.05 0 0 1 8 .9a2.05 2.05 0 0 1 2 2.05V5H8zm0 1a2.05 2.05 0 0 1 2 2.05A2.05 2.05 0 0 1 8 10.1H3a2.05 2.05 0 0 1-2-2.05A2.05 2.05 0 0 1 3 6h5zm10 2a2.05 2.05 0 0 1 2-2.05 2.05 2.05 0 0 1 2 2.05 2.05 2.05 0 0 1-2 2.05h-2V8zm-1 0a2.05 2.05 0 0 1-2 2.05A2.05 2.05 0 0 1 14 8V2.95A2.05 2.05 0 0 1 16 .9a2.05 2.05 0 0 1 2 2.05V8zm-2 10a2.05 2.05 0 0 1 2 2.05 2.05 2.05 0 0 1-2 2.05 2.05 2.05 0 0 1-2-2.05V18h2zm0-1a2.05 2.05 0 0 1-2-2.05 2.05 2.05 0 0 1 2-2.05h5a2.05 2.05 0 0 1 2 2.05 2.05 2.05 0 0 1-2 2.05h-5z"/></symbol>',
  '<symbol id="i-linear" viewBox="0 0 24 24"><path fill="currentColor" d="M3 11.5l9.5 9.5c-2.6-.5-4.9-2-6.5-4.1zM3 8.6l12.4 12.4c.7-.2 1.4-.4 2.1-.7L3.7 6.6c-.3.7-.5 1.4-.7 2zm.9-3.7l15.2 15.2c.6-.3 1.1-.7 1.6-1.1L5 3.3c-.5.4-1 .9-1.1 1.6zm3-3l13.1 13.1c.4-.8.7-1.6.96-2.5L9.4 1c-.85.25-1.7.55-2.5.95zm3.7-.85l5.85 5.85c0-1-.45-1.95-1.15-2.6L13.2 3.2c-.65-.7-1.6-1.15-2.6-1.15z"/></symbol>',
  '<symbol id="i-drive" viewBox="0 0 24 24"><path fill="currentColor" d="M7.71 3.5l-7.71 13.36 3.86 6.64h15.43l3.86-6.64L15.43 3.5h-7.72zM4.86 19.86L8.71 13.5l-4.86-7.86-3.85 6.86 4.86 7.36zm14.28 0l3.86-6.36-4.85-7.36-3.86 7.86 4.85 5.86zM12 6.5L9.43 11h5.14L12 6.5z"/></symbol>',
  '<symbol id="i-ollama" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2c-2 0-3.5 1.5-3.8 3.4-.3 1.5 0 3.1.4 4.5C6 11.4 4 14 4 17c0 2.8 2.2 5 5 5h6c2.8 0 5-2.2 5-5 0-3-2-5.6-4.6-7.1.4-1.4.7-3 .4-4.5C15.5 3.5 14 2 12 2zm-1.5 8c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm3 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1z"/></symbol>',
  '<symbol id="i-fs" viewBox="0 0 24 24"><path fill="currentColor" d="M2 6c0-1.1.9-2 2-2h5l2 2h7c1.1 0 2 .9 2 2v10c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6zm2 2v10h16V8H4z"/></symbol>',
  '<symbol id="i-sqlite" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2c-4.4 0-8 1.34-8 3v14c0 1.66 3.6 3 8 3s8-1.34 8-3V5c0-1.66-3.6-3-8-3zm0 2c3.86 0 6 1.07 6 1s-2.14 1-6 1-6-1.07-6-1 2.14-1 6-1zm-6 4.5c1.4.65 3.65 1 6 1s4.6-.35 6-1V11c0 .07-2.14 1-6 1s-6-.93-6-1V8.5zM6 13c1.4.65 3.65 1 6 1s4.6-.35 6-1v2.5c0 .07-2.14 1-6 1s-6-.93-6-1V13zm0 4.5c1.4.65 3.65 1 6 1s4.6-.35 6-1V19c0 .07-2.14 1-6 1s-6-.93-6-1v-1.5z"/></symbol>',
  '<symbol id="i-webhook" viewBox="0 0 24 24"><path fill="currentColor" d="M13 1L4 14h7l-2 9 10-14h-7l1-8z"/></symbol>',
  '<symbol id="i-anthropic" viewBox="0 0 24 24"><path fill="currentColor" d="M7.5 3L2 21h4l1.1-3.7h7.8L16 21h4L14.5 3h-7zm1.5 4l2.5 7.7h-5L8.5 7h.5z"/></symbol>',
  '<symbol id="i-meta" viewBox="0 0 24 24"><path fill="currentColor" d="M5.5 6C3 6 1 9.5 1 13.5c0 2.8 1.5 5 4 5 1.5 0 2.7-.7 4.5-3.5 2-3.2 3-5 4-5s2 1.2 4 4.5c1.6 2.7 2.8 4 4.5 4 2.5 0 4-2.2 4-5 0-4-2-7.5-4.5-7.5-1.8 0-3 1.3-5 4.5-1.5 2.4-2.5 4-3 4s-1.5-1.6-3-4C8.5 7.3 7.3 6 5.5 6z"/></symbol>',
  '<symbol id="i-deepseek" viewBox="0 0 24 24"><path fill="currentColor" d="M2 13c0-3.5 3-6 7-6 2 0 4 .8 5.5 2L20 6l-1 5c1.2 1.2 2 2.7 2 4.5 0 2-1.5 3.5-3.5 3.5-1 0-1.8-.3-2.5-1-1.4 1.3-3.4 2-5.5 2-4 0-7-2.5-7-7zm5-1c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1z"/></symbol>',
  '<symbol id="i-worker" viewBox="0 0 24 24"><path fill="currentColor" d="M3 4h18v16H3V4zm2 2v12h14V6H5zm2 2l4 4-4 4 1.5 1.5L13 12 8.5 6.5 7 8zm6 6h5v2h-5v-2z"/></symbol>',
  '<symbol id="i-haiku" viewBox="0 0 24 24"><path fill="currentColor" d="M2 9c1.5 0 1.5-2 3-2s1.5 2 3 2 1.5-2 3-2 1.5 2 3 2 1.5-2 3-2 1.5 2 3 2 1.5-2 3-2v3c-1.5 0-1.5 2-3 2s-1.5-2-3-2-1.5 2-3 2-1.5-2-3-2-1.5 2-3 2-1.5-2-3-2-1.5 2-3 2V9zm0 7c1.5 0 1.5-2 3-2s1.5 2 3 2 1.5-2 3-2 1.5 2 3 2 1.5-2 3-2 1.5 2 3 2 1.5-2 3-2v3c-1.5 0-1.5 2-3 2s-1.5-2-3-2-1.5 2-3 2-1.5-2-3-2-1.5 2-3 2-1.5-2-3-2-1.5 2-3 2v-3z"/></symbol>',
  '<symbol id="i-peer" viewBox="0 0 24 24"><path fill="currentColor" d="M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm-7 17c0-3.87 3.13-7 7-7s7 3.13 7 7v1H5v-1z"/></symbol>',
  '<symbol id="i-rune" viewBox="0 0 24 24"><path fill="currentColor" d="M6 3v18h2.5v-7h2.3l4.7 7H19l-5-7.3c2-.4 3.5-2 3.5-4.2 0-2.5-2-4.5-4.5-4.5H6zm2.5 2.5h4c1.2 0 2 .8 2 2s-.8 2-2 2h-4v-4z"/></symbol>',
  '</defs>',
  '</svg>',
].join('');

/**
 * Map a display_name / brick kind / worker type to one of the symbol ids
 * above. The matching is intentionally loose — operators don't want to
 * register icons, they want a sensible default for new connectors.
 */
export function resolveIconId(hint: string | undefined | null): string {
  if (!hint) return 'i-rune';
  const h = hint.toLowerCase();
  if (h.includes('github'))    return 'i-github';
  if (h.includes('slack'))     return 'i-slack';
  if (h.includes('linear'))    return 'i-linear';
  if (h.includes('drive') || h.includes('gdrive')) return 'i-drive';
  if (h.includes('ollama'))    return 'i-ollama';
  if (h.includes('sqlite') || h.includes('runestone')) return 'i-sqlite';
  if (h.includes('webhook'))   return 'i-webhook';
  if (h.includes('anthropic') || h.includes('opus') || h.includes('sonnet')) return 'i-anthropic';
  if (h.includes('haiku'))     return 'i-haiku';
  if (h.includes('meta') || h.includes('llama')) return 'i-meta';
  if (h.includes('deepseek'))  return 'i-deepseek';
  if (h.includes('fs') || h.includes('file'))    return 'i-fs';
  if (h.includes('peer') || h.includes('fleet')) return 'i-peer';
  if (h.includes('worker') || h.includes('cc'))  return 'i-worker';
  return 'i-rune';
}

/** Inline SVG snippet that references a sprite symbol by id. */
export function renderIcon(iconId: string, className = 'icon'): string {
  return `<svg class="${className}" aria-hidden="true"><use href="#${iconId}"/></svg>`;
}
