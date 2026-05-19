# v0.6.x — open questions and deferred scope

This file collects single-line notes about decisions left open during the
`feat/v0.6-baseline-pt2` bundled-PR run (2026-05-19). Each entry is a
pointer for the operator to revisit; nothing here is blocking.

## Deferred from PR B (feat/v0.6-baseline-pt2)

### v0.6.8 Diagnostics engine room — partial implementation

The full BOM (`proposed/v0_6_8-diagnostics-engine-room-bom.md`) budgets
15–20h and was originally split across 3 separate PRs. PR B delivered
the most operator-visible, lowest-risk subset:

- **Shipped**: P6 Section 0 — Build & Versions widget on the Diagnostics
  page, including the [Copy version] / [View on GitHub] / [Check for
  updates] actions and the `STAVR_DISABLE_UPDATE_CHECK` opt-out.
- **Deferred to a dedicated v0.6.8 PR sequence**:
  - P1 SSE multiplexer + bug fixes — single page-level dispatcher
    fanning out to widgets (touches 7+ pages, needs careful client-side
    architecture work).
  - P2 throughput chart + always-render empty states refinement.
  - P3 host vitals collectors (cross-platform CPU / mem / disk / net / GPU).
  - P4 MCP / LLM / Workers / Scopes / EventStore collectors.
  - P5 storage backend + retention + Prometheus export extension.
  - P6 remaining Sections 1–9 (host, daemon, MCP, LLM, workers, trust,
    event-store, notifications, connectivity).
  - P7 cross-platform GPU + per-AV branch.
  - P8 docs + tooltips operator guide.

**Why deferred**: each of P3–P5 introduces multi-thousand-LOC collector
backends with their own migration files, retention rules, and
cross-platform implementation matrices. Folding them into PR B
alongside Task 1 + Task 3 + Task 4 would have produced a >6,000 LOC PR
that's effectively unreviewable. The Section 0 widget is the highest
operator-value piece that ships cleanly without that infrastructure
dependency.

**Recommendation**: open `feat/v0.6.8-diagnostics-pr1` from the merged
baseline once PR B lands, taking P1 + P2 as the next chunk per the
BOM's original phase-group structure.

### Task 4 dashboard UX — partial delivery

PR B shipped the smaller, lower-risk fixes:

- **Phase A (Helm tier-band alignment)** — investigated; the existing
  `.band-head` already uses a uniform `grid-template-columns: 280px 1fr auto`
  across all 5 bands, so the X-axis IS shared. The dispatch-spec'd 200px
  would break level-name readability ("User intent · talk to Steward"
  doesn't fit). Marked as already-aligned; the broader body-grid
  normalization (12-col per-tier body row) is deferred.
- **Phase B (Tools page)** ✅ shipped — GitHub category now matches both
  `github_*` and `github.*` prefixes (the registered tools use dot
  separator); cards grouped into collapsible `<details>` sections by
  category; GitHub default-collapsed; EXPLICIT + NO_GO cards visually
  emphasized; "Critical tools" section pinned to the top.
- **Phase C (Topology cleanup)** ✅ partial — #4 palette-door FAB
  cleanup (Add/Edit v0.7-parked buttons hidden) and #7 keyboard
  shortcut rebind (`/` primary, `⌘K` on Mac via `navigator.platform`
  detection) shipped. **Deferred to a follow-up topology PR**:
  - #1 Galactic map empty (wire MCP/worker/peer nodes into topology data)
  - #2 Move worker roster → Streams page
  - #3 Move in-flight BOMs panel → Plans page
  - #6 YouTube-style heatmap timeline (replace flat blue scrubber polyline)
- **Phase D (Decide expandable rows)** ✅ shipped — resolved decision
  rows now use `<details>` with the full record on expand
  (correlation_id, requested_at, deadline, response timestamp, elapsed,
  responder, chosen + default options, all offered options, reason).
  PR-URL + scope-id cross-links added as best-effort regex extraction
  from the question text.

### v0.6.9 P8 — Topology side-drawer for permissions

The standalone `/dashboard/permissions` page is the authoritative
surface today and delivers the full Layer 0 + matrix + named-policy
apply experience. Wiring a side-drawer onto `/dashboard/topology` that
mirrors the same matrix shape is a real UI integration (the Topology
page is dense; the drawer needs careful CSS work to coexist with the
existing graph view). PR B already ships:

- P6 named policies (built-in presets) + Apply affordance
- P7 YAML import/export + `stavr permissions {export,import,show,set}`
- P9 audit events on every Layer 0 + matrix mutation

P8 is the single deferred slice. Track for a follow-up
`feat/v0.6.9-topology-drawer` PR.

## Open questions (no decision needed yet)

### v0.6.8 BOM §1 — auto-refresh vs manual refresh
Picked the conservative interpretation in shipped P6 work: SSE-driven
auto-refresh is implicit (existing Diagnostics already streams). No
manual "Pause live" toggle added — defer to P1 multiplexer work.

### v0.6.8 BOM §2 — alerts/thresholds in the page
Picked: no in-page alerts. Operator wires their own Grafana /
Alertmanager via the Prometheus export. (Aligned with BOM default.)

### v0.6.8 BOM §3 — collapse/resize sections
Deferred — Section 0 is a single tile so the question doesn't apply yet.

### v0.6.8 BOM §4 — team-mode LLM cost attribution
Deferred — depends on P4 LLM-usage collector landing first.

### v0.6.8 BOM §5 — per-section vs uniform polling rate
Deferred — depends on P3+P4 collectors landing first. Section 0
specifically refreshes only on page load (versions don't change).

## Notes

- The `STAVR_WORKER_SCRIPT_DIR` env var added in Task 1 P5 is documented
  in `docs/worker-spawn.md`. No change to the daemon API needed —
  callers that already pass `scriptBaseDir` keep working unchanged.
- The Ed25519 signing key (`${STAVR_HOME}/keys/spawn-signing.key`)
  generates lazily on first script write. There is no migration step
  for existing operators; old unsigned scripts age out via the existing
  7-day retention sweep.
