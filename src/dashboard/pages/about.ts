/**
 * About page — v0.7 Phase 6.
 *
 * Non-developer landing page. Audience: Kenneth's two sons (~11yo), plus
 * anyone else who lands on this dashboard without context. Explains:
 *
 *   - what stavR is (in plain language, not jargon)
 *   - what the brain modes mean (Shadow / Cloud / Local) — referenced as
 *     "coming soon" since the brain-mode UI lands in v0.8
 *   - a friendly diagram of the topbar chips
 *   - links to family-mode quickstart + main docs
 *
 * Intentionally lightweight. Plain prose + a couple of explainer cards.
 * No live data, no charts — this is a doorway, not a dashboard.
 */
import { renderShell } from '../shell.js';

const ABOUT_STYLES = `
<style>
.about-stack { display: grid; gap: 1rem; max-width: 64rem; }
.about-card h2 { margin-top: 0; }
.about-card p { line-height: 1.55; }
.brand-glyph { font-family: 'Iosevka', 'Cascadia Mono', var(--mono); font-size: 1.4em; }
.chip-legend { display: grid; grid-template-columns: max-content 1fr; gap: 0.5rem 1rem; align-items: center; }
.chip-legend .chip-sample { padding: 2px 8px; border-radius: 6px; background: rgba(255,255,255,.06); border: 1px solid var(--line, rgba(255,255,255,.12)); font-family: var(--mono); font-size: 0.85em; text-align: center; }
.callout { padding: 0.75rem 1rem; border-left: 3px solid var(--accent-rust, #c4642d); background: rgba(196,100,45,.06); border-radius: 0 6px 6px 0; }
.about-link-list { padding-left: 1.5em; line-height: 1.8; }
</style>`;

function renderHero(): string {
  return [
    `<section class="card about-card glass">`,
    `<h1>About <span class="brand-glyph">stav&#x16B1;</span></h1>`,
    `<p><strong>stavR</strong> is your personal MCP gateway — a local-first authority and audit layer that sits between your AI assistants (Claude Code, Cowork, the Codex agent) and the tools they use (GitHub, your filesystem, Slack, local Ollama models).</p>`,
    `<p>Think of it as <em>1Password for AI tool access</em>: assistants come and go, but the trust decisions live with you, on your machine, in a log you can read.</p>`,
    `<div class="callout">stavR is NOT an enterprise MCP gateway and it's NOT multi-tenant. It runs on your laptop or desktop, brokers traffic between AIs and tools, and remembers every decision you make so you can audit it later.</div>`,
    `</section>`,
  ].join('');
}

function renderModes(): string {
  return [
    `<section class="card about-card glass">`,
    `<h2>Brain modes (coming in v0.8)</h2>`,
    `<p>Different tasks want different "brains" — local for fast iteration, cloud for heavy lifting, shadow for sensitive work that should never leave your machine. v0.8 adds an explicit brain-mode picker; the modes are:</p>`,
    `<ul>`,
    `<li><strong>Shadow</strong> — entirely on this machine. No outbound network. Your own local models (Ollama, etc.) do the work.</li>`,
    `<li><strong>Cloud</strong> — your account at Anthropic / OpenAI / whoever. Fast, strong, but the work crosses the wire.</li>`,
    `<li><strong>Local</strong> — middle ground. Local model for the bulk; cloud only for the gnarly parts you mark as OK to send.</li>`,
    `</ul>`,
    `<p class="hint">v0.7 (what you're running now) builds the federation foundation that those modes will plug into.</p>`,
    `</section>`,
  ].join('');
}

function renderChips(): string {
  return [
    `<section class="card about-card glass">`,
    `<h2>The chips at the top</h2>`,
    `<p>The little colored badges in the top bar tell you, at a glance, what's going on:</p>`,
    `<div class="chip-legend">`,
    `<div class="chip-sample">WATCH OK</div><div>The watchdog is happy. PM2 sees the daemon, heartbeat is recent, memory has headroom.</div>`,
    `<div class="chip-sample">v0.7.x</div><div>The version you're running. Click it to see the changelog.</div>`,
    `<div class="chip-sample">Turbo</div><div>Profile mode. Turbo = fewer confirmations; Balanced = standard friction; Eco = ask first, run later.</div>`,
    `<div class="chip-sample">3 peers</div><div>How many other stavR instances are in your federation right now (v0.7+).</div>`,
    `</div>`,
    `</section>`,
  ].join('');
}

function renderFederation(): string {
  return [
    `<section class="card about-card glass">`,
    `<h2>Family mode — running stavR with your people</h2>`,
    `<p>If two or more machines on your network run stavR, they can find each other and team up. The originating machine (the one you're typing on) keeps the decision log; the other machines contribute compute, models, or files.</p>`,
    `<p>That's <strong>family mode</strong>. It's intentionally simple — your laptop + your desktop + a kid's gaming rig should all talk to each other without you setting up a server.</p>`,
    `<ul class="about-link-list">`,
    `<li><a href="/dashboard/family-mode">See your peers</a></li>`,
    `<li><a href="https://github.com/Kstkoda/stavr/blob/main/docs/family-mode.md">Family mode setup guide</a></li>`,
    `<li><a href="/dashboard/settings#identity">Register a passkey</a> (needed for high-trust actions)</li>`,
    `</ul>`,
    `</section>`,
  ].join('');
}

export function renderAboutPage(): string {
  const body = [
    `<div class="about-stack">`,
    renderHero(),
    renderChips(),
    renderFederation(),
    renderModes(),
    `</div>`,
  ].join('\n');
  return renderShell({
    title: 'About stavR',
    activePage: 'about',
    body,
    head: ABOUT_STYLES,
  });
}
