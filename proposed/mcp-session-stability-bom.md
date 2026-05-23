# BOM: MCP Session Stability — In-flight call durability

**Owner:** CC
**Sensitivity:** `careful` — touches `src/transports.ts` (the live MCP transport, daemon request path) and `src/observability/retention.ts`. Status check before/after every commit, report after each phase. Not a per-phase operator gate, but Phase 0 has a hard STOP.
**Verification window:** `full` for Phase 2 (transport durability — stability-sensitive per the verification-window rule); `targeted` for the rest.
**Branch:** `fix/mcp-session-stability` (already exists; holds the recon).
**Base:** current `main`.
**Estimated scope:** 4 phases (0-3), 1 PR after the Phase 0 STOP, ~1 working day of CC time.

---

## Why this BOM exists

Gated MCP calls are intermittently lost. The operator triggers a write (`await_decision`, a gated `github_*`), the daemon-side handler blocks waiting for approval — and sometimes the result never reaches the caller, with no error in stavR's logs. The `await_decision` self-test on 2026-05-23 reproduced it: the call vanished, no decision row, no log line.

The recon (`proposed/mcp-session-stability-recon.md`) found the root cause. stavR's `StreamableHTTPServerTransport` is constructed **without an `eventStore`** (`transports.ts:782-784`). Without one, the SSE response stream is **non-resumable**: if the connection drops while a tool handler is blocked, the SDK client cannot replay from `last-event-id` because no events with IDs were ever emitted. The client-side request promise hangs forever; the server-side result resolves into a closed stream and is dropped silently. A secondary, unrelated find: retention is silently broken for 5 event kinds (`daemon_host_headroom` at 2s cadence is ~43k rows/day piling into the un-prunable `unknown` bucket).

This BOM makes the **current blocking call pattern rock-solid**. It does **not** redesign the pattern — see "Out of scope" below.

## Design criteria (operator's explicit ask — honor these per phase)

- **Event-driven.** No new poll loops (`[[feedback_no_poll_loops]]`, ADR-012). The event log (ADR-036) stays the source of truth; the eventStore is an event *replay* buffer, not a state poller. The one timer added — the SSE heartbeat — is a transport keepalive, not a state poll.
- **Loosely connected.** The eventStore decouples a call's lifetime from its connection's lifetime: a dropped socket no longer means a dropped call. The transport becomes resumable in its own right, independent of any caller's reconnect behaviour.
- **Future-proof.** The eventStore buffer is **bounded at creation** (count + age), not janitor-swept — the v0.6.x memory-leak class does not recur. The buffer is also forward-compatible with the event-driven decision redesign (the result event is already in the store when that BOM lands).
- **Rock solid.** Bounded buffers, full verification on the transport phase, and the daemon-process-safety invariant held (CLAUDE.md §10 — no long-running logic added to the request path; the eventStore is a fixed-size ring, the heartbeat is a cheap periodic write).

## Decisions already locked (from the recon's open questions — do not re-litigate)

- **Q1 — primary affected client:** Cowork. It talks to stavR through the raw MCP client (no shim reconnect ladder); CC goes through the shim and survives recycles. Cowork is the desktop app — we **cannot instrument inside it**. Server-side observability (Phase 3) is how we measure the failure instead.
- **Q3 — eventStore bound:** accept the default **256 events OR 5 minutes per stream**, whichever fires first. The bound *existing* is safety-critical; the exact number is not — Phase 3's counter gives data to tune it later.
- **Q4 — cadence verification:** **yes, do it first** (Phase 0). Confirm whether the ~15-min session recycle is a fixed timer or idle-driven before building the fix, so Phase 2 aims at the right layer.
- **Q2 — early-return / event-driven decision pattern:** **deferred to its own BOM** (see Out of scope). This BOM hardens the blocking pattern; the next removes the need to block.

## Reference reading (CC, at Phase 0)

- `CLAUDE.md` — invariants (§10 process safety especially).
- `proposed/mcp-session-stability-recon.md` — the full recon; §1 (recycle paths), §2 (in-flight failure walk), §4 (retention gap), §5 (fix plan this BOM executes).
- ADR-012 (event-driven over polling), ADR-036 (audit-integrity-baseline — event log = source of truth), ADR-030 (event retention), ADR-044 (streamable-http transport migration), ADR-008 (write-actions-await-decision).
- Code: `src/transports.ts` (lines 752-892 the `/mcp` handler; 782-784 the transport construction; 1064-1101 the janitor), `src/observability/retention.ts`, `tests/observability/retention.test.ts`, `src/tools/decisions.ts`, `src/host-headroom-poller.ts`.

## Don't-touch

- This BOM OPENS `src/transports.ts` and `src/observability/retention.ts` — they are in scope. Outside that: no broker logic, no decision-store semantics, no dashboard data fetchers/adapters.
- Do not change `await_decision`'s public contract or timeout semantics — making the *transport* under it durable is the whole job; changing the *tool* is the next BOM.
- Do not touch `node:sqlite` / `src/db/` — that is family-mode-phase-2, a different branch.

---

## Phase 0 — Cadence verification (output a findings doc, then STOP)

The recon found **no code in stavR** that recycles sessions on a 15-minute clock — the trigger is external. Before building the fix, confirm which kind it is, because it changes Phase 2's emphasis:

- **Fixed interval** (a client-side timer, almost certainly Cowork's) → the fix must make calls *survive* a planned recycle: eventStore + resumption carry the weight.
- **Idle-driven** (a network-stack timeout) → a keepalive heartbeat *prevents* the recycle from happening at all: the heartbeat carries the weight.

Write a small log-parser (throwaway script under `tmp/`) over `pm2 logs stavr` history: measure the gap between consecutive `MCP session ${id} connected` lines (transports.ts:858) per client agent. Exactly 15 min ± seconds = fixed timer. Drifts ± minutes = idle-driven. Output `proposed/mcp-session-stability-cadence-findings.md` with the measured distribution and the verdict. **Operator reviews before Phase 1.**

## Phase 1 — Retention classification (low risk, immediate value)

Per recon §4. In `src/observability/retention.ts`, classify the 5 confirmed orphan kinds plus `peer_left` (check `federation/reporter.ts` emits it; classify symmetrically with `peer_joined`):

- `daemon_host_headroom`, `mcp_oneshot_cleanup` → **operational** (telemetry / aggregated heartbeat, no audit value).
- `peer_joined`, `peer_left`, `capability_override_changed`, `host_ceiling_os_cap` → **audit** (federation lineage and policy mutations must be preserved).

Update `tests/observability/retention.test.ts` to assert each kind classifies correctly (tests follow the spec — CLAUDE.md §1). ~20-line diff, one commit, no behaviour change beyond retention.

## Phase 2 — Transport durability: bounded eventStore + SSE heartbeat (the core fix)

Per recon §5 Phase 2. Two complementary pieces, implemented together so the fix is observable end-to-end. `full` verification window.

**2a — Bounded in-memory `EventStore`.** Implement the MCP SDK `EventStore` interface, keyed by `streamId` + monotonic `eventId`. Bound **at creation**: 256 events OR 5 minutes per stream, whichever fires first — a fixed-size ring, evicted on insert, never a janitor sweep. Wire it into `StreamableHTTPServerTransport` at `transports.ts:782` (currently passes only `sessionIdGenerator`). On reconnect with `last-event-id`, the SDK replays what the store still holds. This is **permanent infrastructure**, not a band-aid: chokepoint-gated tools must hold their connection by design (the gate is transparent to the caller), so a resumable transport is required for them regardless of any future redesign.

**2b — SSE heartbeat on the blocked stream.** While a tool handler is blocked, emit a periodic SSE keepalive (`:keepalive\n\n` comment) every ~20s so idle-timeout disconnects never fire. **Spike first:** does the SDK transport expose a hook, or must we write a low-cost progress notification through `transport.send`? Decide in the spike, document the choice in the commit. Phase 0's findings set the emphasis between 2a and 2b.

**Risk control:** the eventStore retains events in memory per session — uncapped this is exactly the v0.6.x leak. The bound is enforced on every insert, proven by a test that opens a stream, pushes >256 events, and asserts the buffer never exceeds the cap. Also add `docs/integrating-mcp-clients.md` (short): the durability contract for any MCP client doing long-blocking calls against stavR.

## Phase 3 — Failure-mode observability

Per recon §5 Phase 4. So the fix is measurable and the eventStore bound is tunable from data:

- Counter: `stavr_tool_response_delivery_failed_total` — result computed but `transport.send` threw or dropped into a closed stream.
- Histogram: tool-handler duration when the transport closed before send — surfaces the exact long-call cases this BOM protects.
- Wire both into `/dashboard/diagnostics/engine`.

---

## Out of scope — the next BOM (the future-proof direction)

The genuinely event-driven, loosely-coupled design is to stop blocking at all for explicit operator asks: `await_decision` returns **immediately** with a correlation_id; the result is published as a `decision_resolved` event on the log; the caller **subscribes** via `subscribe_to_events` (event-driven primary) or polls `get_events` (fallback). No long-held connection means nothing to drop.

It is deferred — not dismissed — because it is a real API redesign with a design split that deserves its own 10-3-1: it applies cleanly to **explicit** `await_decision`, but **chokepoint-gated tools** (where the gate is transparent and the caller expects the real tool result) cannot early-return without becoming gate-aware. That split needs deliberate design. This BOM's eventStore is the forward-compatible foundation for it. Recommend `proposed/event-driven-decision-flow-bom.md` after this lands; consider an ADR for the transport-durability decision.

## Sensitivity & cadence

`careful`. Status check (`git status --short` + `git symbolic-ref HEAD`) before/after every commit. Report after each phase. Phase 0 ends in a hard STOP for operator review of the cadence findings; Phases 1-3 then run through.

## PR grouping

- Phase 0 — cadence findings doc; operator reviews, no PR.
- PR 1 — Phases 1-3 (retention + eventStore/heartbeat + observability), per-phase commits, DCO sign-off (`-s`), one PR.

## Definition of done

1. Phase 0 findings doc states fixed-timer vs idle-driven, with measured data.
2. The 6 orphan event kinds classify correctly; retention test asserts each.
3. `StreamableHTTPServerTransport` is built with a bounded eventStore; a test proves the buffer never exceeds 256 events / 5 min.
4. A blocked handler emits SSE keepalives; an idle stream survives past the observed recycle window.
5. An in-flight call survives a connection drop + reconnect — replayed from `last-event-id`, result delivered.
6. Delivery-failure counter + handler-duration histogram live on `/dashboard/diagnostics/engine`.
7. Full test suite green; `npm run build` + `tsc --noEmit` clean.

## Run prompt for CC

```
Read CLAUDE.md, then proposed/mcp-session-stability-bom.md and proposed/mcp-session-stability-recon.md. Execute Phase 0 (cadence verification) ONLY — output proposed/mcp-session-stability-cadence-findings.md and STOP. Wait for operator review before Phase 1.

Sensitivity: careful. Status check before/after every commit. Report after each phase. Phase 2 is full verification window (live transport).

Honor the design criteria in the BOM: event-driven (no new poll loops), loosely coupled, future-proof (eventStore bounded at creation, not janitor-swept), rock solid. Do NOT redesign await_decision's contract — that is the next BOM.

Skärp och hängslen: git status --short + git symbolic-ref HEAD before every mutating git op. One commit per phase, DCO sign-off (-s). Stay on fix/mcp-session-stability. Verify files >30KB with stat + tail before commit.

Go — Phase 0 only.
```

---

## End of BOM
