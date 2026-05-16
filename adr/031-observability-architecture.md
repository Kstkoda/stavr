# ADR-031: Observability architecture (OTel + Prometheus + pino + on-demand profiling)

**Status:** Accepted (2026-05-16, after the 2026-05-15 OOM incident)
**Related:** ADR-006 (loopback-only kernel boundary), ADR-020 (daemon watchdog),
ADR-030 (event retention + dashboard caching), `bom-diagnostics-2026.md`

## Context

The 2026-05-15 OOM exposed that stavr had no production-grade observability.
Recovery required reading raw V8 trace output from a PowerShell window:
no metrics for trending, no traces to follow a request across the
broker/worker/transport boundary, no structured logs to grep after the fact,
no way to capture an on-demand heap or CPU profile against the running
daemon. By 2026 these are table-stakes for any critical Node.js daemon.

`project_stavr_architecture_validation_2026_05_15` flagged "OTel adapter from
existing event stream" as queued; this ADR locks that decision in.

## Decision

Adopt a four-pillar observability surface:

1. **Metrics** — Prometheus / OpenMetrics via `prom-client`. The daemon
   exposes `/metrics` on the same HTTP listener. Default Node runtime metrics
   plus stavr custom metrics (event throughput, BOM state, worker counts, SSE
   sessions, HTTP request duration histogram). Operators bring their own
   scraper / Grafana — the daemon doesn't ship a Prometheus server.
   [Shipped in PR #18.]

2. **Traces** — OpenTelemetry SDK with OTLP HTTP exporter. Traces follow the
   OTel GenAI / MCP semantic conventions (`gen_ai.*`, `gen_ai.mcp.*`) so
   trace consumers like Jaeger's GenAI plugin and LangSmith recognize the
   shape. Canonical agent span tree: `invoke_agent` → `execute_tool` → worker
   subprocess. Export is opt-in via `STAVR_OTEL_EXPORTER_OTLP_ENDPOINT` —
   default is no export. [Lands in C2.]

3. **Logs** — pino structured JSON, one object per line on stderr, with
   `correlation_id` automatically stamped via AsyncLocalStorage. The legacy
   `getLogger()` API is preserved as a thin delegate; modules that already
   call `.info(msg, metadata)` keep working unchanged. [Shipped in PR #18.]

4. **On-demand diagnostics** — three POST endpoints under `/debug/*` for
   heap snapshot, CPU profile, and Node Diagnostic Report. Loopback-only AND
   gated by `STAVR_DEBUG_ENABLED=1`; either condition failing returns 404 to
   avoid leaking endpoint existence. Rate-limited 1/min/endpoint. [Shipped
   in this PR.]

### Event log stays system-of-record

The persisted event stream (better-sqlite3 `events` table) remains the
canonical replay/audit source. OTel is an **adapter** on top of the event
stream — it exists to make a single agent invocation legible to
external trace consumers, not to replace the event log. BOM execution,
decisions, trust scopes, and audit reads all continue to flow through the
event store. Reasons:

- The event log is what the dashboard, `stavr tail`, and replay tools depend
  on. Repointing them at an external collector would change the security and
  durability posture of every existing surface.
- OTel exporters are best-effort; the event log is durable.
- Federation (future) needs an authoritative on-disk record; an OTel
  collector address is not that.

### Why not just one pillar?

A previous instinct was "OTel for everything." Practice diverges from that
ideal:

- Prometheus is what the operator universe is built around for scrape-based
  metrics — recording rules, alert manager, Grafana templates. OTel metrics
  exist but the ecosystem isn't there yet for the kind of one-machine
  diagnostics stavr operators actually do.
- Heap snapshots and CPU profiles are V8 artifacts, not OTel signals.
- Structured logs with correlation IDs are useful even when no collector is
  configured (vitest, dev, single-machine ops).

The four pillars share one primitive: `correlation_id`, propagated via
AsyncLocalStorage. Logs and OTel spans both pick it up automatically; metrics
don't carry it (cardinality), but every metric label set comes from the
bounded-cardinality normalizers (`normalizeSourceAgent`, `normalizeRoute`).

## Trade-offs

- **Extra dependencies** (~5 MB): pino, prom-client, `@opentelemetry/*` (C2).
  All read-only adds to package.json; no transitive licensing surprises (all
  Apache-2.0 / MIT).
- **Runtime overhead**: ~1-3% CPU per OTel benchmarks at typical span rates;
  prom-client default metrics negligible; pino is the fastest Node logger in
  benchmark suites. Acceptable.
- **Endpoint surface area**: three new `/debug/*` routes. Mitigated by the
  loopback-only + env-gate + rate-limit triple-lock.

## Consequences

- Operators get the 2026 baseline: metrics they can chart, traces they can
  follow across a BOM run, logs they can grep, and on-demand diagnostics for
  incident response.
- The daemon stays local-first: every export channel is opt-in via env.
  Default config emits exactly zero data to any external endpoint.
- The event log keeps its role as system-of-record; OTel is additive.

## Future work

- **Continuous profiling** (Pyroscope or Datadog Profiler-style sampler) once
  there's a clear use case beyond incident response.
- **Distributed tracing across federated stavr instances** — needs the
  federation work in `015-federation-readiness-design-constraint.md` first.
- **OTel-as-system-of-record** experiment if the event log ever becomes the
  bottleneck. Not soon.
