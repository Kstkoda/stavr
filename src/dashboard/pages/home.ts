/**
 * Home page — C1 lands the empty shell with section placeholders.
 * Real data wiring (daemon health, active BOMs, recent decisions,
 * quick actions) follows in C2.
 */
import { renderShell } from '../shell.js';

export function renderHomePage(): string {
  const body = [
    `<div class="page-head">`,
    `<h1 class="page-title">Home</h1>`,
    `<span class="page-sub">Daemon at-a-glance</span>`,
    `</div>`,
    `<div class="home-grid">`,
    `<section class="card" data-slot="health">`,
    `<h2 class="card-title">Daemon health</h2>`,
    `<div class="placeholder"><strong>Coming in C2</strong>Uptime · port · profile mode.</div>`,
    `</section>`,
    `<section class="card" data-slot="boms">`,
    `<h2 class="card-title">Active BOMs</h2>`,
    `<div class="placeholder"><strong>Coming in C2</strong>Most recent 3 as food-label mini cards.</div>`,
    `</section>`,
    `<section class="card" data-slot="decisions">`,
    `<h2 class="card-title">Recent decisions</h2>`,
    `<div class="placeholder"><strong>Coming in C2</strong>Last 5 decisions; click → Decide.</div>`,
    `</section>`,
    `<section class="card" data-slot="actions">`,
    `<h2 class="card-title">Quick actions</h2>`,
    `<div class="placeholder"><strong>Coming in C2</strong>Propose BOM · Plans · Topology · Settings.</div>`,
    `</section>`,
    `</div>`,
  ].join('');

  return renderShell({
    title: 'Stavr — Home',
    activePage: 'home',
    body,
    head: `<style>
.home-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
@media (max-width: 900px) {
  .home-grid { grid-template-columns: 1fr; }
}
</style>`,
  });
}
