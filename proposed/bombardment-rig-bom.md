# BOM: stavR Bombardment Rig — Build

**Owner:** CC
**Sensitivity:** `careful` — builds test / CI / harness infrastructure and may add minimal, additive daemon instrumentation for oracles. It does not change daemon business logic. Status check before/after every commit; report after each phase.
**Verification window:** `targeted` per phase; `full` for the soak (Phase 2) and chaos (Phase 4) phases.
**Branch:** `feat/bombardment-rig`.
**Base:** `chore/hardening-recon` (carries the recon findings + this BOM).
**Estimated scope:** 7 phases (0-6), 5 PRs, multi-week — this is the stability cycle, not a side task.

---

## Why this BOM exists

stavR's defects cluster as **unit-tests-green, never-exercised-end-to-end**. The recon (`proposed/hardening-recon.md`) quantified it: 4 of 198 test files boot a real subprocess; 0 exercise two daemons over a real network. The 1614 green tests are in-process loopback on `:memory:` SQLite — structurally blind to wiring-seam, install, and cross-machine defects.

This BOM builds the **bombardment rig**: the forge that hardens stavR by pounding it end-to-end — sustained load, fault injection, generated adversarial input — with **oracles** that catch the instant an invariant breaks, and a **resilience score** that turns stability into a number that ratchets up. Every flaw the rig finds becomes a permanent regression so the floor only ever rises.

## Operator priorities — locked this cycle

- **Stability is #1.** The rig exists to make the daemon stable and keep it stable. Every phase serves that; the resilience score is stability quantified.
- **Federation must be testable on a single box.**

## Decisions already locked (do not re-litigate)

- **Single-box federation.** The harness runs N daemons + a relay hub as processes on one machine, using Linux **network namespaces** + `netem` to simulate separate subnets, latency, loss, and mDNS-blocked segments. NOT a multi-VM / multi-CI-runner fleet — one box covers it. The residual (true OS heterogeneity, physical NAT) is the family-mode milestone's final real-3-machine test, not this rig's job.
- **ADR-036 hash chain is deferred.** Tamper-evident audit is audit-integrity, not stability — its own cycle. The oracle layer is built so the hash-chain oracle can be added later without rework.
- **The eventStore fix is NOT in this BOM.** `proposed/mcp-session-stability-bom.md` owns it. Do not duplicate. The rig will *exercise* resumability once that fix lands.
- **The rig has a real home** — a `bombardment/` directory. The `tmp/perf/*` assets are salvaged into it, not left orphaned.

## Reference reading (CC, at Phase 0)

- `CLAUDE.md` — invariants.
- `proposed/hardening-recon.md` — the foundation map; §3 (salvageable assets), §5 (layer assessment), §6 (oracle/invariant set), §9 (the shortlist this BOM refines).
- `proposed/mcp-session-stability-bom.md` — so you know the eventStore fix is owned elsewhere.
- Assets: `tmp/perf/{peer-smoke,load-runner,freeze-probe}.mjs`, `tmp/perf/spin-peer.ps1`, `scripts/leak-repro.ts`, `scripts/smoke/*`, `tests/chaos.test.ts`, `tests/soak/leak-soak.test.ts`, `tests/transports/oneshot-mcp-leak.test.ts`, `.github/workflows/{ci,soak,governor-build,governor-release}.yml`.

## Don't-touch

This BOM OPENS `tests/`, `.github/workflows/`, and the new `bombardment/` directory. It MAY add minimal, additive daemon instrumentation where an oracle needs a signal not already exposed (e.g. a read-only count endpoint) — but it must NOT change daemon business logic, the broker, the transport, persistence, or security primitives. The eventStore wiring and ADR-036 implementation are explicitly out of scope.

---

## Phase 0 — Immediate wins

The two cheapest defensive moves, shippable in days:

- Lift `tmp/perf/peer-smoke.mjs` into CI as an opt-in job (`STAVR_RUN_PEER_SMOKE=1`), 5-minute ceiling, on every PR. This is also the first slice of single-box federation testing.
- Add an **install-smoke** job to CI: after `npm run build`, boot `dist/cli.js daemon start --port 0`, hit `/status`, assert the reported version equals `package.json#version`, kill. Catches the stale-`/status` defect and a chunk of the install-shape gap.

Phase 0 ships as its own PR — independently valuable, no reason to hold it.

## Phase 1 — Oracle foundation + reproducibility

The detection layer. The recon is explicit: nothing else produces interpretable failures without it.

- Build a reusable **oracle module** under `bombardment/oracles/` — continuously-assertable invariants, each a pure check against daemon state / the event log. Seed set (recon §6): SQLite projection ≡ event-log replay; no orphaned broker sessions after teardown; every revoked scope leaves no live grant; every spawned worker reaches a terminal state; `/healthz` 200 implies subsystems are actually live; retention bounds hold.
- Seeded-RNG infrastructure: a single `STAVR_HARDENING_SEED` that fans out to every workload and fault generator, so any failure replays to a minimal repro.
- Preserve-on-failure capture: event-stream dump, heap-snapshot deltas, peer-state YAMLs, fault config.

## Phase 2 — Soak / endurance upgrade

- Replace the serial soak pump with the multi-mode `load-runner.mjs` workload (`mcp_request`, `sse_churn`, `mixed_rw`, `page_nav`), seeded.
- Growth-shape oracles: RSS slope (not just ceiling), broker-session and SSE-tap baseline-return, heap-snapshot per-class diff, event-loop-lag sampling.
- The soak runs the Phase 1 oracle layer continuously, not only at end. `full` verification window.

## Phase 3 — Single-box federation harness

The "test federation on a single box" deliverable.

- Scale `peer-smoke` to an N-daemon + relay-hub topology, processes on one host, isolated `STAVR_HOME` + generated `peers.yaml` per peer.
- Linux **network-namespace** driver: each peer in its own netns on its own subnet; `netem` for latency / loss / jitter; mDNS deliberately blocked across segments to force `peers.yaml` discovery — the real cross-subnet failure shape.
- Federation oracles: mutual visibility, peer-state convergence, `peer_unreachable` → recovery within timeout, operator-identity propagation.

## Phase 4 — Fault-injection / chaos

- Real process-kill: `SIGKILL` the daemon mid-load; verify governor-watchdog restart, in-flight decision recovery via `startupDecisionSweep`, clean SSE reconnect.
- A fault-injecting proxy between federation peers — partition, latency spikes, packet loss applied at the netns edge.
- Projection corruption: mutate the SQLite projection out of band, verify the rebuild-from-log path.

## Phase 5 — Adversarial fuzz

- Add `fast-check`; write properties over the stability-critical surfaces: JSON-RPC envelope parsing (malformed, oversized, recursive, unknown method), the decision-respond gate (`actor × source_agent × scope` → expected outcome), the host-exec allowlist, tool-call scope resolution. Generative, seeded.

## Phase 6 — The ratchet, the score, the lock

The forge mechanism — what makes this coal-to-diamond rather than a test suite.

- **Escalation ratchet:** each run climbs load + fault-rate until an oracle fails; the breaking point is recorded and becomes the floor the next run must beat.
- **Resilience score:** the visible number — survives X hours at intensity Y with zero oracle violations. It must monotonically improve; a regression is a hard CI failure. Surface it as a report artifact (a dashboard tile is a stretch goal).
- **Regression-locking:** every failure the rig finds is captured automatically as a permanent seeded regression case + an oracle. The rig's own catch-list becomes the growing corpus.
- **Continuous run:** a scheduled nightly escalating bombardment, separate from per-PR CI.

## Sensitivity & cadence

`careful`. Status check before/after every commit; report after each phase. Per-phase commits, DCO sign-off (`-s`). Phases 2 and 4 get a `full` verification window.

## PR grouping

- PR 1 — Phase 0 (immediate wins). Ship fast.
- PR 2 — Phases 1-2 (oracles + soak).
- PR 3 — Phase 3 (single-box federation harness).
- PR 4 — Phases 4-5 (chaos + fuzz).
- PR 5 — Phase 6 (ratchet + score + lock).

## Definition of done

1. `peer-smoke` runs in CI; the install-smoke job asserts `/status` version == `package.json`.
2. A reusable oracle layer exists; `STAVR_HARDENING_SEED` makes every run replayable.
3. The soak runs the multi-mode workload with growth-shape oracles, continuously.
4. An N-peer + hub federation spins up on one box, including netns separate-subnet topology with `netem`.
5. Process-kill chaos verifies recovery; the fault proxy exercises federation under partition/latency/loss; projection corruption is caught.
6. Adversarial fuzz covers the named stability-critical gates.
7. The escalation ratchet runs, the resilience score is produced and visible, and every rig-found failure auto-locks as a permanent regression.

## Run prompt for CC

```
Read CLAUDE.md, then proposed/bombardment-rig-bom.md and proposed/hardening-recon.md. Execute Phase 0 (immediate wins) ONLY — lift peer-smoke into CI + add the install-smoke job — then STOP for operator review.

Sensitivity: careful. Status check before/after every commit; report after each phase. The eventStore fix and ADR-036 are OUT of scope (owned elsewhere / deferred).

Skärp och hängslen: git status --short + git symbolic-ref HEAD before every mutating git op. One commit per logical change, DCO sign-off (-s). Branch feat/bombardment-rig off chore/hardening-recon.

Go — Phase 0 only.
```

---

## End of BOM
