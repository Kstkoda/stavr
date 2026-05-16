# Observability

Reference for the stavr daemon's observability surface. The full design lives
in `adr/031-observability-architecture.md`; this doc is the operator runbook.

Pillars (all shipped or shipping under `bom-diagnostics-2026`):

| Pillar | Shipped in | Default | How to enable / read |
| --- | --- | --- | --- |
| Metrics (Prometheus) | C1 (PR #18) | on (no flag needed) | `curl http://127.0.0.1:7777/metrics` |
| Structured logs (pino) | C1 (PR #18) | on | stderr is one JSON object per line |
| Traces (OTel + GenAI MCP semconv) | **C2 (this PR)** | **off** | set `STAVR_OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` |
| Event-loop lag + ELU | **C2 (this PR)** | on | `curl /metrics | grep stavr_eventloop_lag_seconds` |
| On-demand `/debug/*` (heap, cpu, diag) | C3 (PR #20) | **off** | set `STAVR_DEBUG_ENABLED=1` |

## Quick start — local Jaeger via docker-compose

```sh
# Start a local OTel collector + Jaeger UI on :16686
cd examples/observability-stack && docker compose up -d

# Point the daemon at it
STAVR_OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
  OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental \
  npm start

# Open Jaeger
open http://localhost:16686
```

The `OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental` env asks any
downstream OTel libraries that emit GenAI semantic-convention attributes to use
the latest experimental names (`gen_ai.*` / `gen_ai.mcp.*`). Stavr's own helpers
emit the latest names regardless of this flag; setting it keeps behaviour
consistent if you later add other libraries that emit GenAI signals.

## Span catalog

| Span name | Kind | Attributes |
| --- | --- | --- |
| `invoke_agent` | Root per BOM run | `gen_ai.operation.name=invoke_agent`, `gen_ai.agent.name=stavr-steward`, `stavr.bom.id`, `stavr.bom.title`, `stavr.bom.profile_mode`, `stavr.bom.step_count`, `stavr.correlation_id` |
| `execute_tool` | Child of `invoke_agent`, one per BOM step | `gen_ai.operation.name=execute_tool`, `gen_ai.tool.name=<capability>`, `gen_ai.tool.call.id=<bom>:<step_no>`, `stavr.bom.id`, `stavr.bom.step_no`, `stavr.step.risk_class`, `stavr.brick.id` |
| HTTP server span | Auto (HttpInstrumentation) | Standard http.* attrs + `gen_ai.mcp.method` / `gen_ai.mcp.tool.name` / `gen_ai.mcp.session.id` when the request hits `/mcp` |

**Do not collapse `invoke_agent` and `execute_tool` into one level.** Trace
consumers (LangSmith, Braintrust, Jaeger GenAI plugins) recognize the two-tier
shape for agent traces; merging them breaks the canonical view.

Broker `publish()` records each emission as an `addEvent` on whatever span is
active (named `stavr.event.emitted`, with `event.kind`/`event.correlation_id`/`event.source_agent`)
rather than creating a new span — span volume would otherwise explode under
high event rates. The event log remains the system-of-record; spans only
need to know "an emission happened during this operation."

## Metrics catalog (additions in C2)

| Metric | Type | Help |
| --- | --- | --- |
| `stavr_eventloop_lag_seconds` | Histogram | Event-loop lag mean over each 5s sampling interval (buckets 1ms–1s). Use `histogram_quantile(0.99, ...)` for p99. |
| `nodejs_eventloop_utilization` | Gauge | Event-loop utilization 0..1 over each 5s sampling interval. |

prom-client's `collectDefaultMetrics` also exposes
`nodejs_eventloop_lag_p50/p90/p99_seconds` Gauges (single-tick percentiles from
the same `monitorEventLoopDelay` source). Use those when you want a fast
percentile read in a dashboard; use `stavr_eventloop_lag_seconds` when you want
a histogram aggregated server-side.

A `daemon_eventloop` broker event is also emitted every 60s with
`{ lag_seconds_mean, utilization, sample_interval_ms }` so `stavr tail
--kind daemon_eventloop` shows the same series in the event log. Bounded by
the kind-aware retention policy (PR #16) — won't grow unbounded.

## `/debug/*` endpoints (PR #20)

All three diagnostic endpoints have the same access model:

1. The request must come from a loopback address (`127.0.0.1`, `::1`,
   `localhost`, or an empty `remoteAddress` for in-process tests).
2. `STAVR_DEBUG_ENABLED=1` (or `true`) must be set in the daemon's environment.

When either condition fails the route returns **404**, not 403. The 404 is
deliberate: we don't want an unauthenticated probe to be able to discover that
these endpoints exist on a daemon by their HTTP status code alone.

Each endpoint is rate-limited to **one invocation per minute, per endpoint**.
A second hit within the window returns 429 with `retry_after_seconds: 60`.
The limits are per-endpoint, not global — so a heap snapshot doesn't block an
immediate cpu-profile capture.

### POST `/debug/heap-snapshot`

Writes a V8 heap snapshot to `./tmp/heap-snapshots/snapshot-<ts>.heapsnapshot`.
Heap snapshots are large (tens to hundreds of MB on a busy daemon) and pause
the event loop while serializing — don't trigger this on a production daemon
that's currently serving live traffic.

```sh
STAVR_DEBUG_ENABLED=1 \
  curl -X POST http://127.0.0.1:7777/debug/heap-snapshot
# { "ok": true, "file": "...", "size_bytes": 12345678 }
```

Open the resulting file in Chrome DevTools → Memory → Load. Sort by Retained
Size. See `docs/leak-hunt-evidence.md` for the retainer chains we expect.

### POST `/debug/cpu-profile?duration=<seconds>`

Captures a CPU profile via the V8 inspector. Duration is in seconds, clamped
to `[1, 120]`. Default 30. Writes to
`./tmp/cpu-profiles/profile-<ts>.cpuprofile`.

```sh
STAVR_DEBUG_ENABLED=1 \
  curl -X POST 'http://127.0.0.1:7777/debug/cpu-profile?duration=10'
# Waits 10s, then returns:
# { "ok": true, "file": "...", "duration_seconds": 10, "size_bytes": 7543 }
```

Open the `.cpuprofile` file in Chrome DevTools → Performance → Load profile.
The flame graph shows the hot stacks during the capture window.

### POST `/debug/diagnostic-report`

Triggers a Node.js Diagnostic Report (the same one auto-written via
`--report-on-fatalerror`). Contains the V8 heap stats, libuv handle/request
counts, native stack of every Node thread, environment vars, command line,
loaded native modules, and resource usage. Writes to
`./tmp/diag-reports/report-<ts>.json`.

```sh
STAVR_DEBUG_ENABLED=1 \
  curl -X POST http://127.0.0.1:7777/debug/diagnostic-report
# { "ok": true, "file": "...", "size_bytes": 27212 }
```

A daemon that crashed on a fatal error (OOM, uncaught exception) will already
have a report on disk in the same directory — no curl needed; just look at
the most recent file in `./tmp/diag-reports/`.

**Note on signal-based triggers:** Node's `process.report.signal = 'SIGUSR2'`
mechanism is POSIX-only and not supported on Windows. Use the HTTP endpoint
on Kenneth's Windows dev environment.

## Diagnostic procedures

| Symptom | First step |
| --- | --- |
| Daemon feels slow / latency spikes | `POST /debug/cpu-profile?duration=30` and/or check `histogram_quantile(0.99, rate(stavr_eventloop_lag_seconds_bucket[1m]))` |
| Daemon memory growing | `POST /debug/heap-snapshot` at baseline → run load → snapshot again → compare in DevTools Memory tab |
| Daemon hung / pegged | `POST /debug/diagnostic-report` for libuv handles + native stacks |
| Daemon crashed | Look in `tmp/diag-reports/` for the auto-written report; check daemon log for last `correlation_id` |
| Following one BOM run | Filter Jaeger by `gen_ai.agent.name=stavr-steward` and the BOM's `stavr.bom.id` |
| Need full state dump for a bug report | `POST /debug/diagnostic-report` then attach the JSON to the issue |

## Environment variables

| Var | Default | Purpose |
| --- | --- | --- |
| `STAVR_OTEL_EXPORTER_OTLP_ENDPOINT` | unset | OTLP/HTTP endpoint base URL. When unset, traces are disabled. `OTEL_EXPORTER_OTLP_ENDPOINT` is honoured as a fallback. |
| `OTEL_SEMCONV_STABILITY_OPT_IN` | unset | Recommended: `gen_ai_latest_experimental` for the GenAI MCP semconv. |
| `STAVR_DEBUG_ENABLED` | unset (off) | Gate for all `/debug/*` endpoints. Set to `1` or `true`. |
| `STAVR_LOG_LEVEL` | `info` | Pino log level. `trace`/`debug`/`info`/`warn`/`error`/`fatal`. |
| `STAVR_LOG_PRETTY` | unset | When `1`, pipes pino through pino-pretty (dev only). |

See `docs/leak-hunt-procedure.md` for retention/memoization envs from PR #15
and PR #16.

## Production posture

- **Traces** are off by default. Set `STAVR_OTEL_EXPORTER_OTLP_ENDPOINT` only when you have a collector you intend to send to. The daemon stays local-first; nothing leaves the box unless that env is set.
- **`STAVR_DEBUG_ENABLED`** should be **off** in any production daemon by default. Flip it on temporarily when you're actively debugging, then back off. Each endpoint is rate-limited but a sustained drumbeat on `/debug/heap-snapshot` will still pause the event loop and balloon disk usage.
- **Event-loop monitor** is always on (cheap) — Prom metrics flow into `/metrics` whether anyone scrapes them or not.
