# stavR · v0.6.8 — Diagnostics revamp: the engine room

> Major PR (3 PRs). Reframes Diagnostics as **the engine room** of stavR — the operator's deep operational view across host vitals, daemon internals, MCP traffic, LLM usage, worker fleet, trust/decision flow, event store, notifications, federation, and self-heal. Discovered during 2026-05-17 audit when the page presented as a wasteland of empty cards while real activity was flowing through the system unreported.

**Architectural framing** (operator-supplied 2026-05-17):
- **Helm** = the overview / cockpit (L4-L0 tiers, one-glance status)
- **Topology** = the world / galactic map (relationships between actors)
- **Diagnostics** = the engine room (operator's deep operational view)

The three pages serve different purposes; today's Diagnostics fails at its role because it shows almost nothing useful when MCPs aren't connected and workers aren't long-running. This BOM makes the engine room actually show the engine.

**Estimated wall-clock**: 15–20 hours CC sequential across 3 PRs.

**Sensitivity**: `high` per CLAUDE.md section 9 — touches metric collection (potentially expensive), event subscription (SSE wiring), and the dashboard page that's most visited during incidents. Operator approval gate between PRs.

**Stop conditions**: end of any phase if `npm test` regresses, build fails, daemon RSS grows >20% after enabling new collectors (metric collection itself becomes the problem), or any negative test demonstrates that a metric collector blocks the daemon's event loop.

**Do NOT pause for approval** between phases within a PR. Open PR at end of each phase-group.

---

## Why this matters

The 2026-05-17 audit screenshots showed Diagnostics as visually empty:
- 3 sections of placeholder dials showing `—`
- "No data — register an MCP to see traffic" (true but unhelpful — there's a LOT happening that isn't MCP traffic)
- "Live trace tail · received 0" (false — 50+ events fired during the same session)
- "Workers · throughput: No active workers — spawn a job to see throughput" (false — 8 workers spawned in stress test, none showed)
- One section actually displaying data: stavR fleet RSS chart (with a single weird vertical spike)

The page is designed assuming MCPs are registered, workers are long-running, and traffic is high. None of those are true for a personal/small-team operator most of the time. The result is a page that says "nothing happens here" while everything is happening.

For team direction (per ADR 040), this matters more: multiple operators sharing one stavR need a shared operational view of what's going on. The engine room is that view.

## Investigation findings (immediate bugs to fix in PR #1)

**SSE multiple-connections bug**: Network panel during one Diagnostics page load shows 8 separate `GET /dashboard/stream` requests. Either multiple widgets each open their own SSE connection (waste of resources) or one widget is reconnecting in a tight loop (broken). One SSE connection per page should serve all subscribers via a client-side fan-out.

**Live trace tail "received 0"**: SSE connects (status 200) but no events render. Either the server's filter excludes worker/notification/scope kinds, or the widget's render handler is broken, or the subscription happens after events fire (no replay).

**Throughput chart empty**: needs continuous data; chart doesn't render with sparse events (1-2 in window). Needs either a "no data yet, last seen N seconds ago" empty state OR a synthetic time-axis that always renders.

**Workers section shows 0 active** despite Helm L2 showing "6 active" simultaneously — different counter sources, both wrong (v0.6.6 fixes both via single-source-of-truth).

---

## Reference reading

1. `CLAUDE.md` — invariants
2. `adr/031-observability-architecture.md` — current OTel + Prometheus + pino baseline
3. `adr/030-event-retention-and-dashboard-caching.md` — retention model (affects how far back metrics can show)
4. `adr/036-audit-integrity-baseline.md` — hash-chained events (metric collectors must respect chain)
5. `adr/040-three-process-architecture.md` — engine/steward/governor split; this is the operator's view of all three
6. `adr/041-universal-signal-trace.md` — universal trace + privacy boundary (metrics must follow same rules)
7. `src/dashboard/pages/diagnostics.ts` — current render
8. `src/dashboard/data/*` — existing fetchers (extend)
9. `proposed/v0_6_6-worker-status-fidelity-bom.md` — lands first; counters here read from its single-source helpers
10. `proposed/v0_6_7-worker-spawn-hygiene-bom.md` — lands first; AV-block events become visible here

---

## Don't touch

- Helm + Topology + Streams + Settings + Plans + Decide + MCPs + Capabilities pages — out of scope
- `src/security/*`, `src/notify/*`, `src/steward/*` — read-only from this BOM
- Schema except for one additive table in P2 (metrics roll-up cache) and one additive table in P4 (per-resource readings buffer)
- ADR 031 observability baseline — extend, don't supersede
- Existing metric counters (Prometheus `/metrics`) — extend, don't break
- The wire format of `/dashboard/stream` SSE events — read-only; widget changes only
- PM2 ecosystem config

---

## Hard rules

1. **Tests are derivative** — existing Diagnostics tests that assert on the wasteland-empty rendering are now wrong; update them as the render changes
2. **Never lose files** — `stat -c %s` + `tail -5` for any file >15KB
3. **Status-check before every git op** (CLAUDE.md §8)
4. **Metric collectors MUST be non-blocking** — every collector runs in `setImmediate` or a worker thread; never blocks the daemon's event loop. Test: daemon's request p99 must not increase by more than 5% with all collectors enabled
5. **Privacy boundary** (ADR 041) — every metric respects "our universe" only. NO collection of federated peer internals. LLM body bodies stay opt-in.
6. **One SSE connection per page** — page-level dispatcher subscribes once, fans out to widgets client-side via event-bus pattern
7. **Empty states must be MEANINGFUL** — not "no data, register an MCP" but "no MCP registered yet · 247 daemon events in last minute · 12 active scopes". Always show what IS happening even when the specific section's data source is empty.
8. **DCO -s, per-phase commits, push at end of each phase. 3 PRs.**

---

## Phase-group structure (3 PRs)

| PR | Phases | Scope | Wall-clock |
|---|---|---|---|
| #1 — Bug fixes + SSE multiplexer | P0, P1, P2 | Fix multiple-SSE, fix live tail empty, fix throughput render, single page-level dispatcher | 4–5h |
| #2 — Metric collectors (host + daemon + LLM) | P3, P4, P5 | Host vitals + daemon internals + LLM provider stats + storage backend | 6–8h |
| #3 — Engine room layout (8 sections) | P6, P7, P8 | Redesigned page with all sections, empty states meaningful, drill-down links | 5–7h |

Each PR is independently merge-able. PR #1 fixes the worst bugs; PR #2 lays the data foundation; PR #3 is the visible-design payoff.

---

## P0 · Pre-flight (Kenneth, before CC kicks off)

~5 min:
1. `git status` clean on main; v0.6.6 (worker fidelity) and ideally v0.6.7 (worker spawn hygiene) merged
2. `npm test --run` baseline = current passing count
3. Confirm operator wants the metric coverage proposed (review section "Metric taxonomy" below); flag any to exclude or scope down
4. Dispatch CC with PR #1 brief

---

## Metric taxonomy (the comprehensive engine-room coverage)

Organized by 8 sections that the redesigned page will surface. Each metric has: name, collection method, default polling rate, retention default.

### Section 1 — Host vitals (the machine stavR runs on)

| Metric | Method | Poll | Retention |
|---|---|---|---|
| CPU utilization % (per-core + aggregate) | Windows: `Get-Counter '\Processor(*)\% Processor Time'`; Linux: `/proc/stat`; macOS: `top -l 1` | 5s | 24h aggregated to 1min after 1h |
| CPU load average (1/5/15 min) | OS-native | 30s | 24h |
| Memory: total / used / free / cached | OS-native | 5s | 24h |
| Memory pressure events | Linux: `/proc/pressure/memory`; Win: ETW counters | 30s | 7d |
| Disk per-device: IOPS, MB/s, queue, latency p95 | OS-native | 10s | 24h |
| Disk free space (per-mount) | OS-native | 60s | 24h |
| Network per-interface: bytes in/out, errors, drops, retransmits | OS-native | 5s | 24h |
| Network TCP connections (established / time-wait) | netstat | 30s | 24h |
| GPU utilization, memory, temp, power (if present) | NVIDIA: `nvidia-smi --query-gpu=...`; AMD: `rocm-smi`; Apple Silicon: `powermetrics --samplers gpu_power` | 10s | 24h |
| GPU process attribution (which PID is using GPU) | nvidia-smi | 30s | 24h |
| Process file descriptors / handles | OS-native | 60s | 24h |

**Empty state**: "Host stavR · last sample 5s ago" with the actual host name + OS version, even if no metrics are populated yet (boot-time grace).

### Section 2 — stavR daemon internals

| Metric | Method | Poll | Retention |
|---|---|---|---|
| Daemon RSS / heap used / heap total | Node `process.memoryUsage()` | 5s | 24h |
| GC pause time (minor + major) | Node `perf_hooks.PerformanceObserver` for `gc` entries | event-driven | 24h |
| Event loop lag p50/p95/p99 | `monitorEventLoopDelay` | 5s | 24h |
| Active handles + active requests | `process._getActiveHandles().length` | 30s | 24h |
| HTTP request rate (per route) | Express middleware counter | event-driven | 24h |
| HTTP response time p50/p95/p99 (per route) | Express middleware histogram | event-driven | 24h |
| HTTP error rate (4xx + 5xx, per route) | Express middleware counter | event-driven | 24h |
| Active SSE connections (per endpoint) | Track in transport layer | event-driven | 24h |
| SSE messages sent/sec | Track in transport layer | 5s | 24h |
| StreamableHTTP active sessions | MCP transport tracking | 30s | 24h |
| Daemon uptime | `Date.now() - process.startTime` | 60s | always |
| Watchdog heartbeat lag | Existing watchdog | 30s | 24h |

**Empty state**: "Daemon up 23m · RSS 187MB · 2922 events in store" — always something to show.

### Section 3 — MCP traffic (per-MCP server + aggregate)

| Metric | Method | Poll | Retention |
|---|---|---|---|
| Tool calls per second (per MCP) | Event counter on tool invocation | event-driven | 24h |
| Tool call latency p50/p95/p99 (per MCP, per tool) | Histogram on tool invocation | event-driven | 24h |
| Tool call error rate (per MCP) | Counter | event-driven | 24h |
| MCP server connection state (per MCP) | Track in transport | event-driven | always |
| Authentication failures (per MCP) | Counter | event-driven | 7d |
| Bytes in/out (per MCP) | Track on the wire | event-driven | 24h |
| Tool catalog freshness (per MCP) | Time since last `tools/list` | 60s | always |
| Tool call concurrency (active calls per MCP) | In-flight counter | event-driven | 24h |
| Rate-limit hits (per MCP) | Counter (when MCP returns 429) | event-driven | 7d |
| Top tools by qps (overall, last 1h) | Aggregation | 60s rollup | 24h |
| Top tools by error rate (last 1h) | Aggregation | 60s rollup | 24h |

**Empty state**: "0 MCPs registered · browse [MCPs page →]" — link to take action, not just "no data".

### Section 4 — LLM usage (per-provider + aggregate) ⭐ HIGH OPERATOR VALUE

| Metric | Method | Poll | Retention |
|---|---|---|---|
| Calls/minute per provider (Anthropic, OpenAI, Ollama, etc.) | Event counter on LLM call | event-driven | 24h |
| Tokens in/out per provider | Captured from LLM response metadata | event-driven | 30d (per ADR 041) |
| Cost USD per provider (daily, per-job, lifetime) | Token-to-cost mapping per provider price sheet | rollup 60s | 30d |
| Latency p50/p95/p99 per provider | Histogram from call start to last token | event-driven | 24h |
| Time-to-first-token (TTFT) p50/p95 per provider | Captured from streaming responses | event-driven | 24h |
| Tokens-per-second throughput per provider | Captured from streaming | event-driven | 24h |
| Streaming vs non-streaming call ratio per provider | Counter | event-driven | 24h |
| Cache hit rate (prompt cache, response cache) per provider | Counter (where provider exposes cache headers) | event-driven | 24h |
| Error rate per provider (timeouts, rate limits, content blocks) | Counter by error class | event-driven | 7d |
| Rate-limit headroom per provider (calls remaining in window) | From `X-RateLimit-*` headers | event-driven | 1h |
| Capability slot usage (per profile mode) — e.g., how many "code reasoning" calls per day | Counter | event-driven | 30d |
| Model fallback rate (% calls that failed primary, succeeded on backup) | Counter | event-driven | 7d |
| Active concurrent LLM conversations | In-flight counter | event-driven | 1h |
| Average tokens per conversation | Histogram | event-driven | 24h |
| Tool-call density (tool calls per LLM call) | Histogram | event-driven | 24h |

**Empty state**: "0 LLM calls in last 5m · Steward idle · last call 3h ago to anthropic/sonnet-4.6 (1240 tokens, $0.012)" — show LATEST even when activity is low.

### Section 5 — Workers (per-type + aggregate)

| Metric | Method | Poll | Retention |
|---|---|---|---|
| Active workers by type (cc/shell/unity) | Worker store query (v0.6.6 helpers) | 30s | 24h |
| Worker spawn rate (per minute) | Counter on spawn | event-driven | 24h |
| Worker completion rate (clean/error/killed-by-operator/killed-by-system/crashed) | Counter by termination_reason | event-driven | 24h |
| Worker duration p50/p95/p99 (per type) | Histogram | event-driven | 24h |
| Worker CPU/memory usage (per active worker) | OS query on each worker PID | 10s while active | 24h |
| Spawn failure rate (per cause: AV, EPERM, OOM, etc.) | Counter from v0.6.7 events | event-driven | 7d |
| Worker stdout/stderr volume (bytes/sec, per worker) | Track via spawner | event-driven | 24h |
| Concurrent workers peak (last 1h) | Aggregation | rollup 5min | 24h |
| AV-blocked workers (per AV product) | Counter from v0.6.7 events | event-driven | 30d |

**Empty state**: "0 active workers · 47 completed last 24h · last spawn 14m ago (shell · e2e-test-1-commits-count · completed clean in 1.2s)" — recent context.

### Section 6 — Trust scopes + decisions

| Metric | Method | Poll | Retention |
|---|---|---|---|
| Active scopes | Store query | 30s | 24h |
| Scope grant rate (per hour) | Counter | event-driven | 24h |
| Scope expiration rate (per cause: timeout, action-cap, revoked) | Counter | event-driven | 7d |
| Actions per scope (current vs cap, per active scope) | Per-scope query | 30s | 24h |
| Scope grant latency p50 (propose → grant) | Histogram | event-driven | 7d |
| Forbidden-action blocks per scope | Counter | event-driven | 7d |
| Open decisions | Store query | 5s | 24h |
| Decision resolution time p50/p95 | Histogram | event-driven | 7d |
| Decision approval rate | Counter | event-driven | 30d |
| Default-fallback rate (timeout-triggered defaults) | Counter | event-driven | 7d |
| Decisions per hour (rate) | Counter | event-driven | 24h |

**Empty state**: "1 scope active (ts-... · 12/50 actions · expires in 23m) · 0 open decisions" — current state always shown.

### Section 7 — Event store + integrity

| Metric | Method | Poll | Retention |
|---|---|---|---|
| Event insertion rate (events/sec) | Counter | event-driven | 24h |
| Event by kind (counts per kind, last 1h) | Aggregation | rollup 60s | 24h |
| Storage size on disk | Stat `runestone.db` | 60s | always |
| Storage growth rate (MB/day) | Trend from size samples | rollup 1h | 30d |
| Retention prune rate (events deleted/min) | Counter | event-driven | 7d |
| Hash chain integrity (per ADR 036): valid | Periodic verify (last verified timestamp) | manual / nightly | always |
| Index hit rate (per common query) | sqlite query log | 60s | 24h |
| DB write latency p95 | Histogram | event-driven | 24h |
| DB read latency p95 (slow queries only, >50ms) | Histogram | event-driven | 24h |
| WAL size (when WAL mode) | File stat | 60s | 24h |
| Backup status (last successful, per ADR 037) | Backup job log | event-driven | always |

**Empty state**: "2922 events in store · 18MB on disk · last hash-chain verify clean at 14:01 GST · next nightly backup 03:00".

### Section 8 — Notifications + Self-heal (operator-actionable surfaces)

| Metric | Method | Poll | Retention |
|---|---|---|---|
| Notifications sent per channel (ntfy/email/telegram) | Counter | event-driven | 30d |
| Notification send failures per channel | Counter | event-driven | 7d |
| Reply rate (notifications that got operator response) | Counter | event-driven | 30d |
| Reply latency p50/p95 | Histogram | event-driven | 7d |
| Self-heal actions per category (process restart, validation retry, strategy adjustment, daemon-misbehavior-fix) | Counter | event-driven | 30d |
| Self-heal success rate | Counter | event-driven | 30d |
| Time-to-recover p50/p95 | Histogram | event-driven | 30d |

**Empty state**: "0 notifications last 24h · 0 self-heal actions · last manual operator action 3m ago" — show the operator's recent presence even when system-driven activity is low.

### Section 9 — Connectivity (clients in + peers out) ⭐ NEW

Connectivity is the operator's window into who is talking to their stavR (inbound clients) and what stavR planets they're connected to (outbound peers). Two distinct flows, both critical for diagnosing "why isn't this working":

#### 9a — Clients connected TO our stavR (inbound)

Things that connect to our stavR as MCP clients: Cowork-Claude, Claude Code (CC), Claude in Chrome, federated peer stavRs (their outbound = our inbound), future operator devices. Each is a "session" with its own identity.

| Metric | Method | Poll | Retention |
|---|---|---|---|
| Active client sessions (count + per-client breakdown) | MCP transport tracking | event-driven | 24h |
| Per-client connection state (initialized / streaming / idle / disconnected) | Session state machine | event-driven | always |
| Per-client identity (client_name + client_version from MCP initialize handshake) | Captured at session start | event-driven | always |
| Per-client last activity timestamp | Per-message tracking | event-driven | 24h |
| Per-client message rate (in/out per second) | Counter | event-driven | 24h |
| Per-client tool-call rate | Counter | event-driven | 24h |
| Per-client bytes in/out | Counter on the wire | event-driven | 24h |
| Per-client transport type (stdio / SSE / StreamableHTTP) | Captured at handshake | event-driven | always |
| Per-client roundtrip latency p95 (request → response) | Histogram | event-driven | 24h |
| Per-client error rate (4xx/5xx by route) | Counter | event-driven | 24h |
| Disconnects per cause (clean close / timeout / auth-fail / protocol-error) | Counter | event-driven | 7d |
| Reconnect attempts per client (sliding 5m window) | Counter | event-driven | 24h |
| Authentication state per client (pairing-token age, expiry) | Session state | 60s | always |

**Empty state**: "0 clients connected · Cowork-Claude last seen 12m ago · CC last seen 14:08 (Kstkoda/stavr feat/v0.6.6 dispatch)" — recent context.

#### 9b — Peer stavRs (outbound — our planets)

Federated peer stavRs we're connected to per ADR-035. Each peer is a "planet" — could be another operator's stavR (small team) or the operator's own other machine (laptop ↔ desktop sync).

| Metric | Method | Poll | Retention |
|---|---|---|---|
| Active peer count + per-peer state (online / handshaking / authenticating / unreachable / auth-failed) | Peer registry | 30s | always |
| Per-peer identity (peer_id + display_name + operator_pubkey_fingerprint) | Captured at pairing | always | always |
| Per-peer round-trip latency (ping-style, application-layer) | Active probe every 30s | 30s | 24h |
| Per-peer latency p50/p95/p99 over time | Histogram | event-driven | 7d |
| Per-peer network latency (TCP RTT estimate) | OS-native (`netstat -s` / `Get-NetTCPConnection`) | 60s | 24h |
| Per-peer bytes in/out (sustained vs peak) | Counter | event-driven | 24h |
| Per-peer bandwidth utilization (% of negotiated cap, if applicable) | Derived from byte rate | 60s | 24h |
| Per-peer send-queue depth (how many messages waiting to send) | In-flight queue | 5s | 24h |
| Per-peer last successful round-trip (heartbeat) | Timestamp | always | always |
| Per-peer auth token freshness (OAuth 2.1 expiry per ADR-035, time-to-refresh) | Token state | 60s | always |
| Per-peer auth-refresh rate + failures | Counter | event-driven | 7d |
| Per-peer protocol version compatibility (handshake-reported version match) | Captured at handshake | event-driven | always |
| Per-peer A2A message rate (in/out, per kind) | Counter | event-driven | 24h |
| Per-peer correlation_id thread count (active cross-boundary traces) | Active counter | 30s | 24h |
| Per-peer error rate (timeouts / 4xx / 5xx) | Counter | event-driven | 24h |
| Per-peer disconnect reason history (last 10 disconnects + why) | Ring buffer | event-driven | 7d |
| Per-peer quota usage (when sharing budgets per ADR-035 phase 4) | Counter | event-driven | 30d |

**Empty state**: "0 peer stavRs paired · pair a new planet → [Settings]" — link to take action. When peers exist but offline: "peer 'laptop-2' last seen 23m ago · attempting reconnect" — actionable info.

#### Cross-cutting network primitives (apply to both 9a and 9b)

| Metric | Method | Poll | Retention |
|---|---|---|---|
| TCP retransmits per remote address | `netstat -s` aggregate / per-conn breakdown | 60s | 24h |
| TLS handshake latency p95 (per remote) | Histogram on connect | event-driven | 24h |
| TLS certificate expiry per peer (warn at 30d) | Cert inspection on connect | 1h | always |
| DNS resolution time per remote (when applicable) | Resolver hook | event-driven | 24h |
| Connection pool stats (open/in-use/idle/queued) | undici Agent stats | 30s | 24h |
| Outbound HTTP request rate (when stavR initiates — to peers, LLM providers, etc.) | Counter | event-driven | 24h |
| Outbound HTTP error rate by destination | Counter | event-driven | 7d |
| Local listener health (loopback bind alive, port not stolen) | Periodic self-check | 30s | always |

#### The constellation mental model

The Section 9 panel should show the constellation shape even when empty — reinforces the architecture in the operator's head:

```
  [Inbound clients]                    [Outbound peers — your planets]
  ──────────────────                   ──────────────────────────────
  Cowork-Claude  ●  ←─── this stavR ───→  ◌  laptop-2 (your machine)
  Claude Code    ●        (primary)        ◌  desktop-prod (your machine)
  Chrome ext     ●                         ●  ops-alice@team (alice's stavR)
  CC worker      ◌  (idle)                 ◌  (no peers yet — pair one)
                                            
  ↑ Section 9a metrics              ↑ Section 9b metrics
```

Without this section, the operator can't answer:
- "Is my CC dispatch even connected to stavR right now?"
- "Why are commands to my laptop-2 not landing — is it offline, slow, or auth-expired?"
- "Has anyone in the team called my stavR's tools today?"
- "Is my network the bottleneck, or is it the peer?"

### Plus: Live trace tail (fixed)

Bottom of page — continuous SSE stream of events. ONE connection. Filter UX: kind dropdown, severity dropdown, correlation_id input. Default: last 200 events, auto-trim older.

---

## P1 · SSE multiplexer + bug fixes (PR #1, 2h)

**Files**:
- `src/dashboard/sse-client.ts` (new) — single page-level SSE client + client-side fan-out
- `src/dashboard/pages/diagnostics.ts` — use multiplexer
- `src/dashboard/widgets/live-trace-tail.ts` — subscribe via multiplexer; fix event filter
- `tests/dashboard/sse-multiplexer.test.ts`

### Acceptance

- One `/dashboard/stream` connection per page load (verified via network panel — was 8, should be 1)
- Live trace tail shows events within 1s of emission (test: spawn a worker, see worker_spawned event in tail)
- "received N" counter increments correctly
- 5+ tests passing

### Commit
`feat(diagnostics): single SSE multiplexer + live-trace-tail receives events`

---

## P2 · Throughput chart + always-render empty states (PR #1, 2h)

**Files**:
- `src/dashboard/widgets/throughput-chart.ts` — render with synthetic time-axis when data sparse
- `src/dashboard/widgets/section-card.ts` (new) — common empty-state pattern
- Edit existing sections in `pages/diagnostics.ts`

### Empty state pattern (per Hard rule #7)

Every section shows SOMETHING informative even when its specific metric source is empty:
- "0 MCPs registered" → also show "247 daemon events last min" (the daemon IS active)
- "0 active workers" → also show "47 completed last 24h, last spawn 14m ago"
- "No active conversations" → also show "last call 3h ago to anthropic/sonnet-4.6"

Operator always sees activity, never a wall of dashes.

### Acceptance

- All 8 sections (post-redesign) render meaningfully when "no data"
- Throughput chart renders with 1 data point (was: empty / broken)
- 6+ tests passing

### Commit
`feat(diagnostics): meaningful empty states + always-render throughput chart`

### Open PR #1

`feat(diagnostics): SSE multiplexer + live trace tail + meaningful empty states (closes v0.6.8 PR #1)`

---

## P3 · Host vitals + daemon internals collectors (PR #2, 2.5h)

**Files**:
- `src/metrics/collectors/host-vitals.ts` (new) — CPU/mem/disk/network per OS
- `src/metrics/collectors/daemon-internals.ts` (new) — RSS, GC, event loop, request rates
- `src/metrics/collector-runtime.ts` (new) — non-blocking scheduling
- `tests/metrics/collectors/*.test.ts`

### Cross-platform implementation

Use platform-specific commands wrapped in a uniform interface:
- Windows: PowerShell `Get-Counter`
- Linux: `/proc/*` reads
- macOS: `top -l 1` + `iostat` + `vm_stat`

For GPU: detect at boot (`nvidia-smi -L`, `rocm-smi`, Apple Silicon `system_profiler SPDisplaysDataType`); skip collector if absent.

### Acceptance

- All host vitals populate within 30s of collector start on Windows
- Daemon RSS / event-loop p99 / HTTP route rates populate
- Collector overhead measured: daemon p99 latency increases <5% with collectors enabled
- 8+ tests passing (one per metric category, on Linux + Windows + macOS where CI supports)

### Commit
`feat(metrics): host-vitals + daemon-internals collectors with non-blocking scheduler`

---

## P4 · MCP + LLM + Workers + Scope/Decision + Event-store collectors (PR #2, 2.5h)

**Files**:
- `src/metrics/collectors/mcp-traffic.ts`
- `src/metrics/collectors/llm-usage.ts` (largest — 15 metrics)
- `src/metrics/collectors/workers.ts` (reuses v0.6.6 lifecycle helpers)
- `src/metrics/collectors/scopes-decisions.ts`
- `src/metrics/collectors/event-store.ts`
- `migrations/00X_metric_rollups.sql` — additive table for time-bucketed rollups
- `tests/metrics/collectors/*.test.ts`

### Acceptance

- All collectors populate without errors
- LLM cost calculation verified against known token counts × current price-sheet
- Worker collector reads from v0.6.6 single-source helpers
- Rollup table receives 1-minute aggregates
- 12+ tests passing

### Commit
`feat(metrics): MCP + LLM + Workers + Scopes + EventStore collectors + rollup storage`

---

## P5 · Storage backend + retention + Prometheus export (PR #2, 1.5h)

**Files**:
- `src/metrics/storage.ts` — write samples to `metric_samples` + rollups to `metric_rollups`
- `src/metrics/retention.ts` — prune per-metric retention rules
- `src/metrics/prometheus-export.ts` — extend existing `/metrics` endpoint with new metrics (Prometheus exposition format)
- `tests/metrics/storage.test.ts`
- `tests/metrics/prometheus-export.test.ts`

### Acceptance

- Samples persist to DB with bounded growth (retention pruning works)
- Existing Prometheus `/metrics` endpoint now exposes the new metric families (operator can scrape with their own Grafana if desired)
- 6+ tests passing

### Commit
`feat(metrics): storage backend + retention + Prometheus export`

### Open PR #2

`feat(metrics): comprehensive metric collectors for host+daemon+MCP+LLM+workers+scopes+events (closes v0.6.8 PR #2)`

---

## P6 · Engine room layout — 9 sections (PR #3, 2.5h)

**Files**:
- `src/dashboard/pages/diagnostics.ts` — full redesign
- `src/dashboard/widgets/host-vitals-section.ts` (new)
- `src/dashboard/widgets/daemon-internals-section.ts`
- `src/dashboard/widgets/mcp-traffic-section.ts`
- `src/dashboard/widgets/llm-usage-section.ts`
- `src/dashboard/widgets/workers-section.ts`
- `src/dashboard/widgets/scopes-decisions-section.ts`
- `src/dashboard/widgets/event-store-section.ts`
- `src/dashboard/widgets/notifications-selfheal-section.ts`
- `src/dashboard/widgets/connectivity-section.ts` (new — 9a clients + 9b peers + constellation view)

### Layout

Iron palette compliance throughout. Density target: each section visible without scroll on 1080p; full page scrolls.

```
┌─────────────────────────────────────────────────────────────────┐
│ Diagnostics · Engine Room                  [5m] [1h] [24h] [7d] │
│ Top status: Backup ✓ · CI ✓ · Deploy ✓ · Retention ✓ · etc.    │
├─────────────────────────────────────────────────────────────────┤
│ 1. HOST VITALS                                                  │
│   CPU% (chart) · RAM (gauge) · Disk (gauge per device)          │
│   Net I/O (chart) · GPU (gauge + util) · Processes (n + handles)│
├─────────────────────────────────────────────────────────────────┤
│ 2. STAVR DAEMON                                                 │
│   RSS (chart) · Event loop p99 (gauge) · HTTP rate (chart)      │
│   SSE connections (n) · Watchdog · Uptime                       │
├─────────────────────────────────────────────────────────────────┤
│ 3. MCP TRAFFIC                                                  │
│   Per-MCP table: qps · p95 · err · last call                    │
│   Top tools (last 1h) chart                                     │
├─────────────────────────────────────────────────────────────────┤
│ 4. LLM USAGE ★                                                  │
│   Per-provider: calls/min · tokens · cost ($) · TTFT · p95     │
│   Fallback rate · cache hit · capability heat-map               │
├─────────────────────────────────────────────────────────────────┤
│ 5. WORKERS                                                      │
│   Active (n by type) · spawn rate · completion-mix              │
│   Duration p95 · AV blocks · concurrent peak                    │
├─────────────────────────────────────────────────────────────────┤
│ 6. TRUST + DECISIONS                                            │
│   Active scopes (table w/ progress bars) · open decisions       │
│   Recent grant/expiry/revoke timeline                           │
├─────────────────────────────────────────────────────────────────┤
│ 7. EVENT STORE                                                  │
│   Insert rate · By-kind breakdown · Storage (gauge)             │
│   Hash chain status · Backup status                             │
├─────────────────────────────────────────────────────────────────┤
│ 8. NOTIFICATIONS · SELF-HEAL                                    │
│   Notify sent/failure/reply per channel · Self-heal actions     │
├─────────────────────────────────────────────────────────────────┤
│ 9. CONNECTIVITY · clients in ←→ peers out (the constellation)   │
│   9a Inbound: Cowork-Claude · CC · Chrome ext · workers         │
│      per-client: state · last activity · msg rate · p95 · auth  │
│   9b Outbound peers (your planets):                             │
│      per-peer: state · RTT · bandwidth · auth-expiry · errors   │
│   Network primitives: TCP retrans · TLS handshake · DNS · pool  │
├─────────────────────────────────────────────────────────────────┤
│ LIVE TRACE TAIL  [kind ▾] [severity ▾] [cid input]   received N │
│ 14:27:01  worker_spawned   stress-8       ...                   │
│ ...                                                              │
└─────────────────────────────────────────────────────────────────┘
```

### Acceptance

- Page renders all 8 sections + live tail
- Iron palette compliance (halos for status, .glass panels)
- Each section drill-down link to related page (e.g., Workers section → /dashboard/streams)
- Empty states meaningful per Hard rule #7
- 8+ tests passing (one per section)

### Commit
`feat(diagnostics): 8-section engine-room layout + drill-down links`

---

## P7 · Cross-platform GPU + per-AV branch (PR #3, 1.5h)

**Files**:
- `src/metrics/collectors/host-vitals.ts` — GPU detection + per-vendor implementation
- `src/dashboard/widgets/host-vitals-section.ts` — render GPU panel conditionally

### Acceptance

- NVIDIA GPU detected + populated via nvidia-smi
- Apple Silicon detected (system_profiler) + populated
- AMD GPU detected (rocm-smi) — best-effort, may skip if rocm not installed
- No-GPU case: section shows "No GPU detected" without breaking

### Commit
`feat(diagnostics): cross-platform GPU vitals (NVIDIA/AMD/Apple Silicon)`

---

## P8 · Docs + tooltips + operator guide (PR #3, 1.5h)

**Files**:
- `docs/diagnostics.md` (new) — operator's engine-room guide; what each metric means + threshold heuristics
- Tooltips on every metric label
- `CHANGELOG.md` v0.6.8 entry

### Acceptance

- Operator can hover any metric label and get a short definition
- First-time operator can read docs and understand all 8 sections
- CHANGELOG entry comprehensive

### Commit
`docs(diagnostics): operator engine-room guide + per-metric tooltips`

### Open PR #3

`feat(diagnostics): engine-room layout + cross-platform GPU + operator docs (closes v0.6.8)`

---

## Budget

- **Time**: 15–20h CC across 3 PRs (operator merges between)
- **API cost**: ~$25–40
- **LOC change**: ~3,000–4,500 net
- **Token cap**: 2M (split across 3 worker runs)
- **New deps**: maybe `systeminformation` (npm — wraps OS-native metric queries cross-platform); evaluate if pure-spawn approach suffices first
- **Schema change**: 2 additive tables (metric_samples + metric_rollups)

---

## Footgun appendix

1. **Collector overhead** — Windows `Get-Counter` is slow (~100ms per call). Cache results, sample at 5s intervals, NOT per-request.
2. **GPU metric attribution** — `nvidia-smi` shows global GPU usage; attributing to specific stavR process requires PID matching. Best-effort; document limitations.
3. **LLM cost calculation** — provider price sheets change. Bake in a `pricing.json` config refreshable without daemon restart. Stale prices → flag in UI.
4. **Hash chain verify cost** — verifying 100k events takes ~10s on operator hardware. Don't verify on every page render. Nightly + on-demand "verify now" button.
5. **Live trace tail with high event rate** — 1000 events/sec render-bombs the browser. Cap at 50 events/sec render rate; queue overflow shown as "5237 events dropped (rate limit) — view streams page for full".
6. **Cross-OS collector contracts** — write tests on Linux CI; have a manual smoke test checklist for Windows + macOS for each release.
7. **WAL mode prerequisite** — DB collector assumes SQLite WAL mode (better concurrent reads). Verify in init-db.ts.
8. **Metric sample table growth** — 50 metrics × 5s polling × 86400s/day = ~860k samples/day. Aggregate to 1min after 1h. Storage cost negligible but query plans matter.
9. **SSE multiplexer reconnect** — if connection drops, all subscribers should auto-reconnect via the multiplexer's single connection, not each independently.
10. **Privacy boundary for federation metrics** — when federation lands, peer metrics aggregate (count of peers) is fine; peer-internal metric details are out of bounds per ADR 041.

---

## Open questions (FLAGGED — do not pre-answer)

### §1 — Should the page auto-refresh, or operator-triggered "Refresh"?

Default: auto via SSE (live update), with manual "Pause live" toggle for incident review.

### §2 — Should there be alerts/thresholds in the page?

Default: NO in v0.6.8 (display only). Alerting is a separate concern; expose Prometheus + let operator wire their own Alertmanager / Grafana if they want.

### §3 — Should the page support resize / collapse of sections?

Default: yes, collapse via section header click; persist preference to localStorage. Operator can hide sections they don't care about.

### §4 — How should LLM cost display when multiple operators share an instance (team mode)?

Default: per-operator breakdown + total. Cost attribution by `source_agent` field on LLM events.

### §5 — Should the page poll all sections at the same rate, or per-section?

Per-section is more efficient (host vitals every 5s; LLM cost every 60s). Default: per-section rates, configurable in code.

---

## Run prompt for CC (PR #1, paste at start)

```
Read CLAUDE.md first. Then read proposed/v0_6_8-diagnostics-engine-room-bom.md and execute P0-P2 sequentially.

Sensitivity: HIGH. Operator approval gate between PR #1, #2, #3. Status-check before every mutating git op (CLAUDE.md §8).

Work on a NEW branch: `git checkout -b feat/v0.6.8-diagnostics-pr1` from latest main. Never commit to main.

Rules:
- One commit per phase, DCO -s
- Don't pause for approval between phases inside this PR
- For any file >15KB after edit, `stat -c %s file` + `tail -5 file` BEFORE git add
- `npm test` must pass after every commit
- After P2 opens PR, output final delta report and STOP. Don't auto-merge. Don't proceed to PR #2.

Investigation context: the 2026-05-17 audit found 8 separate /dashboard/stream connections per page load (one expected). Live trace tail empty despite events flowing. Throughput chart empty despite sparse-but-present events. Workers section 0 active despite Helm L2 showing 6. Open questions §1-§5 flagged — pick conservative default.

Go.
```

## Run prompts for CC (PR #2 and #3)

```
[PR #2]
Read CLAUDE.md first. Then read proposed/v0_6_8-diagnostics-engine-room-bom.md.

PR #1 merged. Your scope: P3 (host + daemon collectors), P4 (MCP/LLM/Workers/Scopes/Events collectors), P5 (storage + Prometheus export). Open PR at end of P5.

Same rules as PR #1. Sensitivity: HIGH (metric collection touches daemon hot path). Go.
```

```
[PR #3]
Read CLAUDE.md first. Then read proposed/v0_6_8-diagnostics-engine-room-bom.md.

PRs #1 and #2 merged. Your scope: P6 (engine-room layout), P7 (GPU collectors), P8 (docs + tooltips). Open PR at end of P8.

Same rules. Go.
```

---

## End of brief
