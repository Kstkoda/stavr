# ADR-028: Dashboard architecture (v0.3)

**Status:** Accepted · 2026-05-15

## Context

v0.2 shipped two single-file HTML dashboards served from string
constants in `src/dashboard-html.ts` and `src/dashboard-plans-html.ts`.
Both were CDN-Tailwind one-pagers. They worked, but every new page was
a copy-paste of the shell + a fresh CSS pile, and the visual language
drifted (the Plans page used a different palette to the main page).

v0.3 needed eight pages with a shared design language (Dark 2.0,
food-label visual grammar, brick colour invariants). Continuing the
single-file pattern would have meant eight copies of the shell.

## Decision

1. **Modular per-page directory** at `src/dashboard/`:
   - `tokens.ts` — Dark 2.0 CSS custom properties, single source of truth.
   - `shell.ts` — `renderShell({ title, activePage, body, head?, script? })` returns the full HTML document. Owns the top-nav, the inspector panel skeleton, and the connection-state banner.
   - `components/` — pure render functions returning HTML strings: `food-label.ts`, `brick.ts` (SVG), `inspector.ts`, `pill.ts`, `scrubber.ts`. Each carries its own CSS string exported alongside; the shell stitches them together.
   - `pages/` — one file per nav entry, each exports `renderXxxPage(data?)`. Pages compose the shell + their body markup + their inline script.
   - `adapters/` — domain → component mappers (`bom.ts`, `decision.ts`, `topology.ts`). Centralise the risk → food-label class rules so Plans and Decide can't drift.
   - `index.ts` — `mountDashboardPages(app, deps?)` mounts `/dashboard` (302 → home) plus eight per-page routes. Each route renders the shared shell with a different body. The `deps` bag carries per-page snapshot factories so `transports.ts` can inject live data without the dashboard module depending on the broker.

2. **Server-rendered HTML + vanilla JS**. No React / Vue / Svelte. No client-side build step. The dashboard is a local-first observability surface, not a SPA — server-side rendering keeps deep-links working, pages copyable, `view-source` useful for debugging, and `dist/` small.

3. **Pull-based snapshots, live update via SSE**. Pages take an optional `data?` argument; missing → render with zeroed placeholders (useful for tests). With data → render the initial paint server-side. The client subscribes to `/dashboard/stream` and reacts to relevant event kinds (Home re-fetches the aggregator; Plans triggers a soft refresh on `bom_*`; Topology debounces on `worker_*` / `bom_step_*` / `trust_scope_*`; Streams appends lines on every matching correlation_id).

4. **Reusable component contracts**. `renderFoodLabel({ name, what, riskClass, reversible, costUsd, modelMix?, href?, id? })` is the visual grammar for any "action card." Plans, Decide, Home mini-cards, and Topology hover-cards all consume it. Same for `renderBrick({ id, kind, displayName, position?, status? })` for any brick-shaped node.

5. **One snapshot factory per page** lives in `transports.ts` and feeds `mountDashboardPages` via `DashboardPageDeps`. Keeps the dashboard module pure and the broker / trust store / V0.2 subsystem touches in one place.

## Consequences

**Positive:**
- Adding a ninth page costs: one file in `pages/`, one entry in `NAV_ENTRIES`, one snapshot factory in `transports.ts`. No CSS duplication.
- Design language is enforced by component contracts. Risk colour drift is caught at code review.
- E2E test trivially asserts every page renders with the shared shell.
- Server-rendered pages stay accessible: HTML is meaningful before JS runs; degraded experience without JS still loads the data.

**Negative:**
- Pages can't share state across navigation; every click is a full page load. Acceptable for an oversight surface — the operator is not playing a video game inside the dashboard.
- Live update granularity is coarse. Topology and Plans reload the page on relevant events rather than applying deltas. Trade-off chosen for simplicity; per-page delta logic could land in v0.4 if anyone complains.
- Pure-string render functions mean component testing is "does the markup match," not "does it behave in a browser." Acceptable while every component is a pure function; once anything stateful appears, a jsdom-style harness becomes worth it.

## Alternatives considered

- **Continue single-file per page**. Rejected — eight copies of the shell would have entrenched the drift problem.
- **Move to a SPA framework** (React / Preact / Svelte). Rejected — needless build step, doesn't help the dashboard's actual job, would push dependency surface up substantially.
- **Server-side templating with Pug / EJS / Handlebars**. Rejected — adds a templating language to learn; TS template literals + escape helpers are sufficient and let us pass real types through.

## Related

- ADR-006 daemon binds 127.0.0.1 only — basis for "no auth, no CORS" on the dashboard
- ADR-008 write actions await decision — Decide page surfaces these
- BOM `proposed/v0.3-dashboard-bom.md` — ten checkpoints that landed this architecture
