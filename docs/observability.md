# Observability

Reference for the stavr daemon's observability surface. The full design lives
in `adr/031-observability-architecture.md`; this doc is the operator runbook.

Current state (after `bom-diagnostics-2026` C1 + C3):

- **Metrics**: Prometheus `/metrics` endpoint with default Node runtime + stavr
  custom counters/gauges/histograms. See `src/observability/metrics.ts`.
- **Structured logging**: pino JSON-per-line on stderr, with `correlation_id`
  auto-attached via AsyncLocalStorage. See `src/observability/logger.ts`.
- **On-demand diagnostics**: `/debug/heap-snapshot`, `/debug/cpu-profile`,
  `/debug/diagnostic-report` (this checkpoint).
- **Crash-time dumps**: `npm start` flags `--heapsnapshot-near-heap-limit=2`,
  `--report-on-fatalerror`, `--report-directory=./tmp/diag-reports`.

C2 (OTel SDK + GenAI MCP semconv spans + event-loop monitor) lands in a
follow-up PR off the same BOM.

## `/debug/*` endpoints

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
| Daemon feels slow / latency spikes | `POST /debug/cpu-profile?duration=30`, open in DevTools Performance |
| Daemon memory growing | `POST /debug/heap-snapshot` at baseline → run load → snapshot again → compare in DevTools Memory tab |
| Daemon hung / pegged | `POST /debug/diagnostic-report` for the libuv handle list + native stacks |
| Daemon crashed | Look in `tmp/diag-reports/` for the auto-written report; check daemon log for the last `correlation_id` |
| Need full state dump for a bug report | `POST /debug/diagnostic-report` then attach the JSON to the issue |

## Environment variables (this checkpoint)

| Var | Default | Purpose |
| --- | --- | --- |
| `STAVR_DEBUG_ENABLED` | unset (off) | Gate for all `/debug/*` endpoints. Set to `1` or `true`. |
| `STAVR_LOG_LEVEL` | `info` | Pino log level. `trace`/`debug`/`info`/`warn`/`error`/`fatal`. |
| `STAVR_LOG_PRETTY` | unset | When `1`, pipes pino through pino-pretty (dev only). |

See `docs/leak-hunt-procedure.md` for retention/memoization envs from PR #15
and PR #16.

## Production posture

`STAVR_DEBUG_ENABLED` should be **off** in any production daemon by default.
Flip it on temporarily when you're actively debugging, then back off. Each
endpoint is rate-limited but a sustained drumbeat on `/debug/heap-snapshot`
will still pause the event loop and balloon disk usage.
