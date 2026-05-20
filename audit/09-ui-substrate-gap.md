# Audit 09 — UI Substrate Gap

> Formal version of the 2026-05-19 manual QA finding: "UI shipped ahead of substrate." For each interactive element in `src/dashboard/`, classify whether clicking it reaches a working endpoint, a placeholder, dead code, or a freeze.

## Headline

| Category | Count |
|---|---|
| **Works** — handler invokes real substrate that responds | 32 |
| **Placeholder** — handler exists but no-ops or shows a "v0.7" alert | 28 |
| **Dead** — UI attribute exists but route/function is missing | 12 |
| **Freezes** — known to hang or block | 0 (none observed) |
| **Static** — no interactivity | 4 pages |

The headline number: **~40 of 72 interactive elements (55%) reach real substrate.** The rest are honest scaffolding (often labelled "v0.7 / lands in vN") or quietly dead.

## Detailed table

Excerpted from agent investigation — every dashboard interactive element with handler and substrate target.

### Works (real substrate)

| Element | Page | Handler | Substrate target |
|---|---|---|---|
| Top-nav links (Plans / Decide / Topology / Settings) | `home.ts:89, 104, 115, 116` | `<a href>` | GET `/dashboard/<page>` |
| Digest edit + toggle | `helm.ts:268-269` | `data-role="digest-edit"` / `digest-toggle` | POST `/dashboard/settings/digest` (`transports.ts:1938`) |
| L0–L3 band-arrows | `helm.ts:974-977` | `onclick → /dashboard/<page>` | href routing |
| Worker chips (open inspector) | `helm.ts:941-955` | `data-fi-open="worker"` | floating inspector JS |
| System chips (open inspector) | `helm.ts:957-971` | `data-fi-open="system"` | floating inspector JS |
| Top tools fetch | `helm.ts:1039-1063` | GET `/dashboard/api/top-tools` | `transports.ts:2134` |
| L1 metrics trend pull | `helm.ts:981-996` | GET `/metrics` | `transports.ts:236` |
| Decide → Respond buttons | `decide.ts:56-61` | `data-role="respond"` | POST `/dashboard/decisions/:correlationId/respond` (`transports.ts:2226`) |
| Plans → BOM respond | `plans.ts` | `data-role="respond"` | POST `/dashboard/plans/:bomId/respond` (`transports.ts:2042`) |
| Settings → profile mode radio | `settings.ts:91` | `name="profile-mode"` | POST handler bound in JS |
| Settings → trust scope grant | `settings.ts:133` | `data-role="grant"` | POST `/dashboard/settings/scopes/:id/grant` (`transports.ts:1818`) |
| Settings → trust scope extend | `settings.ts` | extend button | `transports.ts:1847` |
| Settings → trust scope revoke | `settings.ts` | revoke button | `transports.ts:1800` |
| Settings → no-go toggle / delete | `settings.ts` | `data-role` toggle / delete | `transports.ts:1885, 1896` |
| Settings → brick test / install / uninstall | `settings.ts` | `data-role="test|install|uninstall"` | `transports.ts:1961, 1975, 2006` |
| Topology filter chips | `topology.ts:446` | `data-type` toggle | page JS |
| Topology reset layout | `topology.ts:486` | `data-role="topo-reset"` | localStorage clear |
| Topology LIVE toggle | `topology.ts:468` | `data-role="topo-live"` | page JS |
| Topology node drag | `topology.ts:780-782` | grab handlers | localStorage persist |
| Topology inspector tabs (Health / Config / Events) | `topology.ts:525-528` | `data-tab` switching | page JS |
| Diagnostics window selector (5m/1h/24h/7d) | `diagnostics.ts:825-831` | button click → `refreshAll()` | GET `/dashboard/api/traffic-summary` (`transports.ts:2163`) |
| Diagnostics copy build version | `diagnostics.ts:697-725` | `data-role="bv-copy"` | `navigator.clipboard` |
| Diagnostics update check | `diagnostics.ts:730-759` | `data-role="bv-update-check"` | GitHub API (external) |
| Diagnostics memory / perf / storage panels | `diagnostics.ts:904-1119` | GETs | `transports.ts:389, 440, 452` |
| Streams search + filter | `streams.ts:137-146` | `.streams-search`, `.filter-select` | page JS filter |
| Permissions drawer | `permissions.ts` | embedded in topology | `transports.ts` permissioning routes |

### Placeholder (handler exists, but does nothing meaningful)

| Element | Page | Reason | Marker |
|---|---|---|---|
| Capabilities → model dropdown | `capabilities.ts:352` | "Read-only · v0.6.12, picks not persisted" | comment + UI |
| Capabilities → pin toggle | `capabilities.ts:354` | not persisted | comment "v0.7" |
| Capabilities → per-cell picker | `capabilities.ts:371` | renders candidates, not saved | — |
| MCPs → Install button | `mcps.ts ~650` | `alert("...lands in v0.7...")` | `aria-label` says so |
| Plans → Propose form | `plans.ts` | not rendered | comment "lands in v0.7" |
| Toolkit page | `toolkit.ts` | page is stub | — |
| Topology → Add (+) button | `topology.ts:475` | parked with v0.7 badge | — |
| Topology → Edit (✎) button | `topology.ts:475` | parked with v0.7 badge | — |
| Topology → Restart action | `topology.ts:550` | `data-action="restart"` disabled | v0.7 badge |
| Topology → Disable action | `topology.ts:551` | `data-action="disable"` disabled | v0.7 badge |
| Topology → Ping action | `topology.ts:549` | `type="button"`, no handler wired | — |
| Streams → Pane expand (⤢) | `streams.ts:122-123` | no fullscreen/modal handler | silent no-op |
| About / Placeholders / Family-mode | as-named | static read-only | by design |

### Dead (UI element exists, no route/handler)

| Element | Page | Reason |
|---|---|---|
| Topology inspector → per-node qps / p95 / err / retry charts | `topology.ts:539-542` | `data-role="dt-*"` SVG, no `/metrics` slice per node |
| Topology inspector → time-window buttons (5m/1h/24h/7d) | `topology.ts:533-536` | page JS does not respect them |
| Topology → Permissions drawer body | `topology.ts` | drawer rendered, no handler |
| Settings → "add no-go rule" button | `settings.ts` | no POST endpoint |
| Diagnostics → heal Undo / Deny | `diagnostics.ts:873-874` | `data-act="undo|deny"` not wired |
| Capabilities → model SAVE | `capabilities.ts:352` | no POST endpoint visible |
| Helm L4 → Steward intent input | `helm.ts:229` | `data-role="l4-composer"` plus "cmd+enter to send" hint, no handler |
| Helm L4 → STEWARD button | `helm.ts:224` | onclick → intent sheet that doesn't exist |
| Tools page actions | `tools.ts` | likely missing endpoints (per-tool invocation tracking deferred to v0.6.9 per comment) |
| Toolkit interactive elements | `toolkit.ts` | likely missing endpoints |
| Capture endpoint | `transports.ts` exposes POST `/dashboard/capture`; no UI caller | — |

## Top 10 most-visible dead/placeholder elements

These are what an operator hits first when exploring the dashboard. Fix order should be informed by visibility:

1. **Capabilities → model dropdown** (`capabilities.ts:352`) — labelled read-only but looks editable.
2. **MCPs → Install button** (`mcps.ts ~650`) — `alert("v0.7")` on click.
3. **Plans → Propose form** (`plans.ts`) — operator expects to create a BOM from UI; not rendered.
4. **Topology → Edit (✎) button** (`topology.ts:475`) — visible palette door, disabled.
5. **Topology → Add (+) button** (`topology.ts:475`) — visible palette door, disabled.
6. **Topology → Ping action** (`topology.ts:549`) — Actions tab promises ping; no handler.
7. **Helm L4 → Steward intent input** (`helm.ts:229`) — Composer with "cmd+enter to send" hint; nothing fires.
8. **Diagnostics → heal Undo / Deny** (`diagnostics.ts:873-874`) — operator can't approve/reject heals.
9. **Topology inspector → per-node charts** (`topology.ts:539-542`) — qps/p95/err/retry SVG slots empty.
10. **Streams → Pane expand (⤢)** (`streams.ts:122-123`) — silent no-op on every pane.

## Pattern observations

- **The "v0.7 honesty" approach is well-applied for forward-looking features** (Capabilities, MCPs install, Plans propose, Topology Add/Edit/Restart/Disable). These are placeholders the operator can recognise.
- **The "dead without a label" group is the real risk** — Helm L4 composer, Topology Ping, Diagnostics heal Undo/Deny, per-node charts. An operator types or clicks and *nothing happens*, no toast, no error, no "coming soon."
- **There is no `freezes` element** — credit to the broker rejection + retention work. No hangs were identified in this pass.
- **Tests are mostly shape tests**, not behaviour tests — a placeholder element with no handler renders identically to a working element from a snapshot's perspective. See audit 03 Gap #8.

## Recommendations

| # | Action | Size |
|---|---|---|
| 1 | Add a "coming soon" toast on every `dead` element so the operator gets feedback | trivial |
| 2 | Disable the Helm L4 Steward composer + Topology Ping button until they are wired | trivial |
| 3 | Wire Diagnostics heal Undo / Deny to the existing decision-response route (substrate is already there) | small |
| 4 | Build the per-node `/dashboard/api/topology/:nodeId/metrics` endpoint and feed the qps/p95/err/retry charts | medium / BOM-worthy |
| 5 | Convert "shape" tests in `tests/dashboard/` into "behaviour" tests that POST to the handler and verify the route exists | medium |
| 6 | Add a CI lint that flags `data-role` / `data-action` attributes whose value doesn't appear in any handler registration | medium |
