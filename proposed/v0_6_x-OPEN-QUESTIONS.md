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
