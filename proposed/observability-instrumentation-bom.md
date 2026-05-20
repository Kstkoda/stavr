# BOM: Observability Instrumentation — 5 Waves

**Owner:** CC
**Sensitivity:** `careful` — touches `src/observability/` and many code paths to emit metrics; no security primitives. Status check before/after each commit; report per phase.
**Verification window:** `full` — observability is perf-sensitive; metric emission must not regress hot paths.
**Branch:** `feat/observability-instrumentation`
**Base:** `main`
**Estimated scope:** 7 phases (0 + 5 waves + verification), each wave independently shippable, 4-6 PRs.

---

## Why this BOM exists

The observability metrics spec (`proposed/observability-metrics-spec.md`, merged PR #58) defines ~170 metrics across 6 layers; stavR emits 9. This BOM wires the emitters, wave by wave, in the spec's order. It is the substrate the Diagnostics rebuild (task #72) renders — without it that page is tiles with no data, which is exactly why v0.6.12's Diagnostics failed.

## The spec is the contract

Read `proposed/observability-metrics-spec.md` first. It defines the metric names (OTel GenAI/MCP semconv + NVIDIA DCGM), types, labels, thresholds, per-layer applicability, and the two override rules. This BOM **implements** the spec; it does not redesign it. If the spec and reality disagree, raise it — do not silently diverge.

## Two hard rules (from the spec)

1. **Burn-rate first.** Wave 0 (SLO burn-rate) ships before any static-threshold wiring — biggest signal-to-noise win.
2. **Cardinality discipline.** Safe labels only: `tool`, `model`, `upstream`, `error.type`, `host`, `gpu`. NEVER `request_id` / `user_id` / `session_id` or any unbounded identifier. A test must assert no unbounded label is registered.

## Reference reading

- `proposed/observability-metrics-spec.md` — the contract.
- `adr/031-observability-architecture.md` — the OTel + Prometheus + pino baseline.
- Code: `src/observability/metrics.ts` (the 9 current metrics), `src/observability/otel.ts`, `src/observability/spans.ts`, `src/observability/event-loop.ts`.

## Don't-touch

- The Diagnostics page itself — the page rebuild is task #72, a separate BOM. This BOM only emits metrics.
- Security primitives, persistence schema.

---

## Phase 0 — Recon

Confirm the 9 current metrics, the `prom-client` registry setup, the OTel pipeline state (ADR-031). Map each of the 9 to its spec layer. Output `proposed/observability-instrumentation-recon.md`.

## Phase 1 — Wave 0: SLO + telemetry-pipeline health

Define stavR's SLOs. Wire `slo.error_budget.burn_rate` multi-window burn-rate alerts + the telemetry self-monitoring set (`otel.collector.*`, `trace.completeness_pct`, `tsdb.active_series`, `monitoring.scrape.failures`). Per the spec — smallest surface, biggest win, first.

## Phase 2 — Wave 1: Layer 5 MCP gateway

stavR *is* the gateway, so this is the cheapest and most core. Reshape `stavr_http_request_duration_seconds` → `mcp.gateway.request.duration` and `stavr_sse_sessions` → `mcp.server.sessions.active`; add the rest of the L5 catalog (gateway / server / client metrics).

## Phase 3 — Wave 2: Layer 1 host USE

node-exporter-equivalent host metrics (CPU/memory/disk/network USE). Co-deploy or bundle an exporter as the spec describes.

## Phase 4 — Wave 3: Layer 4 LLM execution

Promote `stavr_provider_requests_total` / `stavr_provider_latency_seconds` to OTel GenAI conventions; add the vLLM-style queue / KV-cache / batch metrics for local models.

## Phase 5 — Wave 4: Layer 2 GPU/DCGM

Wire scraping of the NVIDIA DCGM exporter. Depends on the exporter being deployed on the local-LLM machines (family-mode Phase 2 territory) — if it is not available in CI, the wiring + tests use a fixture. The BOM is writable now; execution of this phase may wait on the family GPU machines.

## Phase 6 — Verification

`full` window. `npm test` + `npm run build` + `tsc` clean. `/metrics` endpoint exposes the new metrics with correct types/labels. Cardinality test: no unbounded label registered. A perf check confirms metric emission did not regress request hot paths.

---

## Sensitivity & cadence

`careful`. Status check before/after every commit; delta report per phase. Each wave is independently shippable — a wave can merge and deploy on its own.

## PR grouping

- PR 1 — Phase 0 + Wave 0.
- PR 2 — Wave 1.
- PR 3 — Wave 2.
- PR 4 — Wave 3.
- PR 5 — Wave 4.
- PR 6 — verification (or fold into PR 5).

## Definition of done

1. All five waves' metrics emit with spec-correct names, types, labels.
2. Wave 0 burn-rate alerts are live and the first thing wired.
3. No unbounded-cardinality label exists; the assertion test passes.
4. Full test suite green; no hot-path regression.
5. The metrics are real data ready for the task #72 Diagnostics page.

## Run prompt for CC

```
Read CLAUDE.md, then proposed/observability-metrics-spec.md, then proposed/observability-instrumentation-bom.md. Execute Phase 0 (recon) and Wave 0, then open PR 1 and continue — waves are independent.

Sensitivity: careful. Status check before/after every commit; delta report per phase.

Hard rules: burn-rate (Wave 0) first; cardinality discipline — never request_id/user_id/session_id as a label.

Skärp och hängslen: git status --short + git symbolic-ref HEAD before every mutating git op. One commit per phase, DCO -s. Branch feat/observability-instrumentation off main.

Go.
```

---

## End of BOM
