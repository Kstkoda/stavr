# Observability Instrumentation — Phase 0 Recon

**Owner:** CC · **Branch:** `feat/observability-instrumentation` · **Date:** 2026-05-21

This is the BOM's Phase 0 output. It pins the substrate before any wiring goes in.
Source of truth: `proposed/observability-metrics-spec.md` (the contract) and
`adr/031-observability-architecture.md` (the four-pillar architecture).

---

## The 9 metrics stavR emits today

All defined in `src/observability/metrics.ts`, registered on the module-scope
`registry: prom-client.Registry`. The registry has default labels
`{service: "stavr", version: <pkg.version>}`. Node defaults
(`prom-client.collectDefaultMetrics`) are registered alongside via the
module-load-time `ensureDefaultMetrics()` call — these are process-level
(`process_*`, `nodejs_*`), not host-level. Two further metrics are registered
from `src/observability/event-loop.ts`.

| # | Current metric                          | Type | Defined in                            | Wired by                                                                            | Spec layer       | Target name (Wave) |
|---|------------------------------------------|------|----------------------------------------|--------------------------------------------------------------------------------------|------------------|--------------------|
| 1 | `stavr_http_request_duration_seconds`    | H    | `src/observability/metrics.ts:91`      | `src/transports.ts:221` (Express middleware on all routes except `/metrics`)         | L5 (gateway)     | `mcp.gateway.request.duration` (W1) |
| 2 | `stavr_sse_sessions`                     | G    | `src/observability/metrics.ts:85`      | `src/transports.ts:144` `refreshSseGauge()` on session add/drop                       | L5 (server)      | `mcp.server.sessions.active` (W1) |
| 3 | `stavr_events_emitted_total`             | C    | `src/observability/metrics.ts:64`      | `Broker.publish()` → `recordBrokerEvent()` (kind, normalized source_agent)            | cross-cutting    | stay (internal) |
| 4 | `stavr_workers_alive`                    | G    | `src/observability/metrics.ts:78`      | `recordBrokerEvent` on `worker_spawned`/`worker_terminated`                           | stavR-specific   | stay |
| 5 | `stavr_bom_state`                        | G    | `src/observability/metrics.ts:71`      | `recordBrokerEvent` on `bom_*` kinds                                                  | stavR-specific   | stay |
| 6 | `stavr_provider_requests_total`          | C    | `src/observability/metrics.ts:99`      | `src/steward/providers/ollama.ts:205` via `recordProviderRequest()`                  | L4 (LLM exec)    | `gen_ai.client.operation.count` family (W3) |
| 7 | `stavr_provider_latency_seconds`         | H    | `src/observability/metrics.ts:106`     | `src/steward/providers/ollama.ts:206` via `recordProviderLatency()`                  | L4 (LLM exec)    | `gen_ai.server.request.duration` (W3) |
| 8 | `stavr_eventloop_lag_seconds`            | H    | `src/observability/event-loop.ts`      | poller in `event-loop.ts`                                                            | runtime (L1-adj) | stay |
| 9 | `nodejs_eventloop_utilization`           | G    | `src/observability/event-loop.ts`      | poller in `event-loop.ts`                                                            | runtime (L1-adj) | stay |
|   | `prom-client` defaults (`process_*`, `nodejs_*`) | mixed | registered via `collectDefaultMetrics` | n/a                                                                                  | runtime (L1-adj) | stay |

That is the complete real substrate today. Of the ~170 metrics in the spec,
stavR emits zero under their canonical names — only those nine related metrics
under stavR-specific names.

## Registry topology

- One process-wide `Registry` instance in `src/observability/metrics.ts` (line 51).
- Default labels: `service=stavr`, `version=<pkg.version-or-STAVR_VERSION>`.
- Node defaults collected once via `ensureDefaultMetrics()` (idempotent flag).
- Exposed via `GET /metrics` in `src/transports.ts:236` using `registry.metrics()` and
  the `registry.contentType` (`text/plain; version=0.0.4`). No middleware runs for
  `/metrics` (line 220 guard prevents recursive timing).
- Tests assert custom-metric presence in `tests/observability/metrics.test.ts`.

## OTel pipeline state (ADR-031)

- Bootstrap in `src/observability/otel.ts`. **Disabled by default** — `NodeSDK`
  only starts when `STAVR_OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_ENDPOINT`)
  is set, or when a test injects an exporter/processor.
- Instrumentations registered: `HttpInstrumentation`, `ExpressInstrumentation`.
- Span helpers in `src/observability/spans.ts` follow OTel GenAI/MCP semconv
  (`gen_ai.*`, `gen_ai.mcp.*`). Two-tier shape: `invoke_agent` (BOM) → `execute_tool` (step).
- `addBrokerSpanEvent`, `attachMcpAttributes`, `recordTokenUsage` decorate active spans.
- Pino logs propagate `correlation_id` via AsyncLocalStorage; metrics intentionally
  do NOT carry it (cardinality).

There is no OTel metrics pipeline today — the four-pillar split is prom-client
for metrics, OTel for traces, pino for logs, V8 endpoints for diagnostics.

## Cardinality discipline (the spec's Rule 2)

The current code already normalizes the two label families with bounded
cardinality:

- `normalizeSourceAgent()` collapses arbitrary worker names to a fixed 8-bucket
  set (`worker:cc | worker:shell | worker:unity | worker:other | dashboard |
  steward | stavr-daemon | stavr-cli | other | unknown`).
- `normalizeRoute()` collapses Express paths to a fixed allow-list plus
  `/dashboard*`, `/debug/*`, `/pair/*`, `other`.
- `normalizeModelLabel()` truncates LLM model names to ≤48 chars.

The forbidden labels per the spec — `request_id`, `user_id`, `session_id`, any
unbounded identifier — are NOT used by any current metric. The wave-by-wave
work must preserve that invariant. **Wave 0 introduces a cardinality test
(`tests/observability/cardinality.test.ts`) that enumerates every registered
metric's `labelNames` and fails if any forbidden label appears.**

## Mapping to spec waves

- **Wave 0 (SLO + telemetry pipeline)** — net-new surface. Defines stavR's
  SLOs (gateway request availability + latency, LLM provider availability),
  adds `slo.error_budget.burn_rate{slo}` gauge driven by a multi-window
  reservoir, plus the self-monitoring set: `otel.collector.spans.dropped`,
  `otel.collector.metrics.dropped`, `otel.exporter.queue.size`,
  `trace.completeness_pct`, `tsdb.active_series`, `monitoring.scrape.failures`,
  `telemetry.ingestion.lag_seconds`. Wave 0 ships the cardinality test.

- **Wave 1 (L5 — MCP gateway)** — reshape #1 → `mcp.gateway.request.duration`
  and #2 → `mcp.server.sessions.active`; add `mcp.gateway.request.rate`,
  `mcp.gateway.request.errors`, `mcp.gateway.tool.invocations`,
  `mcp.gateway.auth.failures`, `mcp.server.tool.duration`,
  `mcp.server.tool.errors`, `mcp.server.tool.invocations`,
  `mcp.server.invocations.in_flight`, `mcp.client.*` (downstream brokering),
  `mcp.jsonrpc.errors`, `mcp.protocol.version_mismatch`. Old names kept as
  aliases during deprecation window so existing scrape configs and tests
  don't break in a single commit. (Old metric still emits; alias deprecated
  in a follow-up release.)

- **Wave 2 (L1 — host USE)** — bundle a node-exporter-equivalent poller
  (`src/observability/host-metrics.ts`) reading from `os.cpus()`,
  `os.freemem()/totalmem()`, `os.loadavg()`, plus Linux/Windows-portable
  disk + network reads. cgroup-aware where available. Honors the
  already-existing host-resource-ceiling poller (`src/observability/perf-poller.ts`).

- **Wave 3 (L4 — LLM exec)** — wire OTel GenAI metric names alongside the
  existing `stavr_provider_*` (dual-emit during deprecation). Add the
  vLLM-style runtime metrics for local models when the Ollama provider can
  surface them: `llm_requests_waiting`, `llm_requests_running`,
  `llm_kv_cache_utilization_pct`, etc.

- **Wave 4 (L2 — GPU/DCGM)** — scrape NVIDIA DCGM exporter via HTTP.
  Implementation is a poller that fetches `/metrics` from the configured
  DCGM endpoint and re-registers the metrics on our registry under their
  canonical `DCGM_FI_*` names. CI uses a fixture file with sample DCGM output
  since no GPU is present.

## Don't-touch reminder

This BOM emits metrics; it does NOT touch:

- The Diagnostics page (task #72, separate BOM).
- Security primitives (`src/security/`, `src/trust/`, `src/credentials/`).
- Persistence schema (`src/persistence.ts`, `migrations/`).
- The event log shape.

## Risks acknowledged

- **Metric-name churn**: changing `stavr_http_request_duration_seconds` →
  `mcp.gateway.request.duration` is a breaking change for any external scraper
  config. Mitigation: dual-emit during the deprecation window; remove old
  names in v0.7.0 (out of this BOM's scope).
- **Cardinality blow-up**: Wave 1 introduces `tool` and `upstream` labels.
  Both are bounded by `mcp.json`/registered upstreams — verified by the
  cardinality test.
- **Hot-path regression**: every middleware addition is a tax on request
  latency. Phase 6 perf check confirms emission stays ≤1ms p50 overhead per
  request.

## Done when

This document landed on `feat/observability-instrumentation` with one DCO-signed
commit. Wave 0 starts in the next commit.
