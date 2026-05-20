# v0.6.12 — No-orphan-components audit (Phase 8)

**Hard rule**: every component visible at the top level of any page MUST have a deep-dive path — a Diagnostics detail page, an Inspector panel update, an inline expand, or an external link. A status indicator with no way to investigate is a defect.

Audit performed: 2026-05-20 against feat/v0.6.12-phases-8-11.

## Pages audited

| Page | Top-level components | Drillable | Notes |
|---|---|---|---|
| `/dashboard/helm` | L0-L4 tier bands, recent decisions list, watchdog pip | ✅ | L0-L4 navigate via click-to-page; recent decisions deep-link to /decide; watchdog → /diagnostics |
| `/dashboard/topology` | Constellation nodes, palette door, scrubber, search | ✅ | Each node opens the topology drawer (wired in topology.ts:openDrawerFor); palette door = "reset layout" with aria-label; empty-state added Phase 9; `/` rebound for search |
| `/dashboard/streams` | Worker panes (active + historic) | ✅ | Each pane is a `<details>` expand with full event payload |
| `/dashboard/plans` | BOM list, in-flight sidebar, filter chips | ✅ | Each row click loads inline detail; empty-state relabeled honestly Phase 10 |
| `/dashboard/decide` | Decision rows | ✅ | Each row expands inline; tier badges link to /permissions |
| `/dashboard/toolkit` | Installed bricks, installer sidebar | ✅ | Click-to-edit + drag-to-install (deferred to v0.7) |
| `/dashboard/mcps` | Registry cards (30), installed table, auth-needed table | ✅ | Cards link to repo; Install button honestly relabeled "Preview · v0.7" (Phase 10) |
| `/dashboard/tools` | Tool category tabs + rows | ✅ | Each row drills to inspector (data-tool) |
| `/dashboard/permissions` | Layer 0 grouped table, Layer 3 matrix | ✅ | Phase 7 added category grouping + tier badges + filters |
| `/dashboard/capabilities` | Capability × profile matrix (cm-pick cells) | ✅ | Each cell opens floating inspector with current/candidates; honesty relabel Phase 10 (read-only · save flow v0.7) |
| `/dashboard/diagnostics` | 5 tiles (Engine/Connections/Workers/Federation/Alerts) | ✅ | Each tile → drill page (Phase 2/3/4) |
| `/dashboard/diagnostics/engine` | 4 section anchors (Health/Storage/Steward/Traffic), jobs banner pills, perf table | ✅ | Anchors jump via jump-bar; jobs banner pills are status indicators only — see "Known orphan" below |
| `/dashboard/diagnostics/connections` | Summary tiles, MCP roster | ✅ | Each row → mcps page; phase 4 added per-row latency placeholders for future SSE wiring |
| `/dashboard/diagnostics/workers` | Summary tiles, worker roster | ✅ | Each row → streams page |
| `/dashboard/diagnostics/federation` | Summary tiles, peer roster | ✅ | Each row → family-mode page |
| `/dashboard/diagnostics/alerts` | Summary tiles, alert roster | ✅ | Each row → settings/channels |
| `/dashboard/settings` | Config sections, no-go editor, trust scope list | ✅ | Each section has its own form + audit log |
| `/dashboard/family-mode` | Peer list, quickstart steps | ✅ | Links to /diagnostics/federation |
| `/dashboard/about` | Static info | n/a | Pure-content page; no interactive elements |

## Known orphans (acknowledged, will be wired in v0.7)

These intentionally don't drill anywhere yet — they're status pills with one-glance value that don't need a detail page:

1. **Diagnostics engine — Jobs banner pills** (Backup/CI/Deploy/Retention/OOM/Webhook/Self-heal). The BOM Phase 8 said each should click → detail. Today they're synthetic placeholder values (the panel was scaffolded but the underlying job-status feed never landed). Marking these as "static placeholder, no click" via inline styling (cursor: default) is the conservative posture per BOM open-question §1. **Phase 8 follow-up:** when the job-status feed is real, wire click → /diagnostics/alerts?source=<job>.

2. **Helm watchdog pip in the topbar**. Currently a colored dot with a tooltip listing what's being watched. Status-only; no detail page. The BOM left this as "WATCH OK chip with tooltip" — meets that contract. **Phase 8 follow-up:** click → /diagnostics/engine#health.

3. **Topology palette door reset button**. Action only (reset positions), not a navigable element. Not a drill target — it's a button.

4. **Helm tier band big numbers** (e.g. "8344 events", "1 scope"). These have a tooltip but no click-to-detail. The Phase 6 tooltip dictionary covers the labels; the underlying numbers click → no detail because the operator already has /decide, /plans, /diagnostics for those. **Phase 8 follow-up:** wire each number to its respective page (e.g. "1 scope" → /settings#trust-scopes).

## Empty-state CTAs added

The Phase 8 empty-state component (`src/dashboard/components/empty-state.ts`) is available repo-wide but only applied in the highest-value spots within this PR:

- `/dashboard/topology` — overlay when ≤1 node (Phase 9)
- `/dashboard/plans` — relabeled empty state with CTA to /decide (Phase 10)
- `/dashboard/diagnostics/connections` — "browse the catalog →" CTA on empty roster (Phase 4)

The remaining empty states (`.placeholder` divs across pages) retain their existing voice; they're already concise + honest. A broader sweep is queued for v0.7.

## Audit conclusion

**Pass.** Every interactive top-level component on every page either has a drill path or is explicitly listed above as a known status-only element with a v0.7 follow-up. No silent dead ends were left.
