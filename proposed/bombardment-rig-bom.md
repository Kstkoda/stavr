# BOM: stavR Bombardment Rig — Build

**Owner:** CC
**Sensitivity:** `careful` — builds test / CI / harness infrastructure and the daemon container image; may add minimal, additive daemon instrumentation for oracles. It does not change daemon business logic. Status check before/after every commit; report after each phase.
**Verification window:** `targeted` per phase; `full` for the soak (Phase 2) and chaos (Phase 4) phases.
**Branch:** `feat/bombardment-rig`.
**Base:** `main` — Phases 0-2 are merged (Phase 0 = PR #74, Phases 1-2 = PR #79).
**Estimated scope:** 8 phases (0-7), 6 PRs, multi-week — this is the stability cycle, not a side task.

> **Reshaped 2026-05-24.** Docker is now the rig substrate (was: raw Linux `ip netns` + hand-rolled `tc`). A Docker container *is* a network namespace, so this is the same single-box federation decision realised with portable, maintained tooling. The reshape also makes the daemon container image a first-class deliverable — that one image is the rig **and** the real gateway — and adds Phase 7, a real multi-site soak on the operator's two Synology NAS. Phases 0-2, already merged, are unaffected.

---

## Why this BOM exists

stavR's defects cluster as **unit-tests-green, never-exercised-end-to-end**. The recon (`proposed/hardening-recon.md`) quantified it: 4 of 198 test files boot a real subprocess; 0 exercise two daemons over a real network. The 1614 green tests are in-process loopback on `:memory:` SQLite — structurally blind to wiring-seam, install, and cross-machine defects.

This BOM builds the **bombardment rig**: the forge that hardens stavR by pounding it end-to-end — sustained load, fault injection, generated adversarial input — with **oracles** that catch the instant an invariant breaks, and a **resilience score** that turns stability into a number that ratchets up. Every flaw the rig finds becomes a permanent regression so the floor only ever rises.

## Operator priorities — locked this cycle

- **Stability is #1.** The rig exists to make the daemon stable and keep it stable. Every phase serves that; the resilience score is stability quantified.
- **Federation must be testable on a single box.**
- **The rig substrate is the production substrate.** One container image is built once and serves both the reproducible rig (Track 1) and the real federated gateway (Track 2). Hardening the rig hardens the thing the family actually runs.

## Decisions already locked (do not re-litigate)

- **Docker is the substrate (reshaped 2026-05-24).** A Docker container is a network namespace, so N daemon containers give the netns federation harness directly; Docker networks are the subnets; **Pumba** injects `netem` latency / loss / jitter / partition and does mid-load container kills. This *realises* the single-box-federation decision — it does not abandon it. Raw `ip netns` + hand-rolled `tc` is dropped in favour of docker-compose + Pumba: the same compose topology runs on WSL2, a bare Linux box, or the Synologys.
- **One container image.** The daemon is containerized once (Phase 3a). That image is Track 1 (the rig) and Track 2 (the real gateway). Containerizing is the first deliverable of the remaining work.
- **Two tracks.** Track 1 — the reproducible torture rig: docker-compose + Pumba on a controlled host (WSL2 on the operator's PC, or a spare Linux box); seeded, deterministic, escalating, destructive. Track 2 — real multi-site federation soak: the same image on the two Synologys via Container Manager; real WAN / NAT / DNS; non-destructive; continuous; also the family-mode production substrate, instrumented.
- **Single-box federation.** The harness runs N daemons + a relay hub on one machine — now as Docker containers, network namespaces given by Docker, subnets given by Docker networks, `netem` given by Pumba. NOT a multi-VM / multi-CI-runner fleet. True OS heterogeneity + physical NAT is Phase 7's job (real Synologys), not Track 1's.
- **ADR-036 hash chain is deferred.** Tamper-evident audit is audit-integrity, not stability — its own cycle. The oracle layer is built so the hash-chain oracle can be added later without rework.
- **The eventStore fix is NOT in this BOM.** `proposed/mcp-session-stability-bom.md` owns it. The rig will *exercise* resumability once that fix lands.
- **The rig has a real home** — the `bombardment/` directory.

## Reference reading (CC, at Phase 3)

- `CLAUDE.md` — invariants.
- `proposed/hardening-recon.md` — the foundation map; §3 (salvageable assets), §5 (layer assessment), §6 (oracle/invariant set).
- Existing rig code merged in Phases 0-2: `bombardment/{oracles,observability}/*`, `bombardment/{seed,capture,load-runner,install-smoke}.*`, `.github/workflows/{soak,peer-smoke}.yml`.
- Pumba — `github.com/alexei-led/pumba` — the Docker chaos tool used from Phase 3c on.

## Don't-touch

This BOM OPENS `tests/`, `.github/workflows/`, the `bombardment/` directory, and — new with the reshape — a `Dockerfile`, `docker-compose*.yml`, and a container entrypoint / healthcheck. It MAY add minimal, additive daemon instrumentation where an oracle needs a signal not already exposed — but it must NOT change daemon business logic, the broker, the transport, persistence, or security primitives. eventStore wiring and ADR-036 are out of scope.

---

## Phase 0 — Immediate wins — MERGED (PR #74)

`peer-smoke` lifted into CI; the install-smoke job asserts `/status` version == `package.json`.

## Phase 1 — Oracle foundation + reproducibility — MERGED (PR #79)

The reusable oracle module (`bombardment/oracles/`), `STAVR_HARDENING_SEED` seeded-RNG, preserve-on-failure capture.

## Phase 2 — Soak / endurance upgrade — MERGED (PR #79)

Multi-mode `load-runner.mjs` workload, growth-shape oracles, the oracle layer running continuously through the soak (`soak.yml`).

## Phase 3 — Containerize the daemon + Docker-Compose federation harness

The "test federation on a single box" deliverable, Docker-native.

- **3a — Containerize the daemon.** A `Dockerfile`: multi-stage build; the daemon runtime on Node + `node:sqlite` (no native module to compile — if `better-sqlite3` is still present, confine build tooling to the build stage); a non-root runtime user; the event-log / WAL DB on a named volume; env-based config; an exposed `/healthz` and a container `HEALTHCHECK`. The image boots, `/healthz` passes, `/status` reports the right version. This image is the unit for everything below and for Phase 7.
- **3b — Compose federation topology.** A `docker-compose` file standing up N daemon containers + a relay-hub container, each with an isolated `STAVR_HOME` and a generated `peers.yaml`. Per-"site" Docker networks act as separate subnets; mDNS is blocked across networks so discovery is forced through `peers.yaml` — the real cross-subnet failure shape.
- **3c — Pumba chaos driver.** Integrate Pumba as a sidecar: `netem` latency / loss / jitter applied at the container veth, per network edge. (Phase 4 extends it to kills + partitions.)
- **3d — Federation oracles.** Mutual visibility, peer-state convergence, `peer_unreachable` -> recovery within timeout, operator-identity propagation.

Ships as PR 3.

## Phase 4 — Fault-injection / chaos (Pumba-driven)

- **Container kill:** Pumba `kill` / `stop` the daemon container mid-load; verify the supervisor restarts it (the Docker `restart` policy is the in-container supervisor), in-flight decision recovery via `startupDecisionSweep`, clean SSE reconnect.
- **Network chaos:** Pumba partition, latency spikes, packet loss applied at the Docker-network edge between federation segments.
- **Projection corruption:** mutate the SQLite projection out of band, verify the rebuild-from-log path.

## Phase 5 — Adversarial fuzz

Add `fast-check`; write properties over the stability-critical surfaces: JSON-RPC envelope parsing (malformed, oversized, recursive, unknown method), the decision-respond gate, the host-exec allowlist, tool-call scope resolution. Generative, seeded. Once the scope-aware enforcement lands (`proposed/worker-dispatch-bom.md` Phase 4), the decision-respond properties should also cover `actor x source_agent x grant-scope` — federated grants are a stability-critical surface.

## Phase 6 — The ratchet, the score, the lock

- **Escalation ratchet:** each run climbs load + fault-rate until an oracle fails; the breaking point is recorded and becomes the floor the next run must beat.
- **Resilience score:** the visible number — survives X hours at intensity Y with zero oracle violations. It must monotonically improve; a regression is a hard CI failure. Surface it as a report artifact (a dashboard tile is a stretch goal).
- **Regression-locking:** every failure the rig finds is captured automatically as a permanent seeded regression case + an oracle.
- **Continuous run:** a scheduled nightly escalating bombardment — this is **Track 1**, on the controlled host, separate from per-PR CI.

## Phase 7 — Track 2: real multi-site federation soak

The real-world half — what containers on one box structurally cannot test: real WAN, real NAT, real DNS, OS heterogeneity.

- Deploy the Phase 3a container image to the two Synology NAS (a DS1819+ and an RS-series rackmount) via Container Manager — one as each site's relay hub, with daemon containers alongside.
- Run a continuous, **non-destructive** instrumented soak across the real link between the two sites: the Phase 1 oracle layer + the Phase 2 growth-shape oracles + the Phase 3 federation oracles, sampled continuously.
- Feed a Track-2 section of the resilience report — real-world endurance, distinct from Track 1's escalation score.
- **Hardware placement:** neither Synology hosts Track 1 — destructive chaos and disk-filling heap snapshots never run on the boxes holding the family's backups. Put each container's data volume on a quota'd share so a runaway event log cannot eat backup space.
- Track 2 is the family-mode production substrate, dogfooded — it ties to the family-mode milestone.

Ships as PR 6.

## Sensitivity & cadence

`careful`. Status check before/after every commit; report after each phase. Per-phase commits, DCO sign-off (`-s`). Phases 2 and 4 get a `full` verification window.

## PR grouping

- PR 1 — Phase 0 (immediate wins). MERGED (#74).
- PR 2 — Phases 1-2 (oracles + soak). MERGED (#79).
- PR 3 — Phase 3 (containerize + docker-compose federation harness + Pumba). **NEXT.**
- PR 4 — Phases 4-5 (chaos + fuzz).
- PR 5 — Phase 6 (ratchet + score + lock).
- PR 6 — Phase 7 (Track 2 real multi-site soak).

## Definition of done

1. The daemon ships as a Docker image — boots, `/healthz` passes, `/status` version == `package.json`.
2. A docker-compose N-daemon + relay-hub federation topology stands up on one box, with per-site Docker networks and Pumba-injected `netem`.
3. Pumba chaos verifies recovery from container kill, network partition, latency, loss; projection corruption is caught.
4. Adversarial fuzz covers the named stability-critical gates.
5. The escalation ratchet runs, the resilience score is produced and visible, and every rig-found failure auto-locks as a permanent regression.
6. The same image runs as a real multi-site soak (Track 2) across the two Synologys, with the oracle layer reporting continuously.

## Run prompt for CC

```
Read CLAUDE.md, then proposed/bombardment-rig-bom.md and proposed/hardening-recon.md. Phases 0-2 are merged to main. Execute Phase 3 ONLY — containerize the daemon (3a), build the docker-compose federation topology (3b), integrate Pumba (3c), add the federation oracles (3d) — then STOP for operator review. Ship as PR 3.

Sensitivity: careful. Status check before/after every commit; report after each phase. May add minimal additive daemon instrumentation only if an oracle needs a signal — no daemon business-logic / broker / transport / persistence / security changes. eventStore fix and ADR-036 are OUT of scope.

Skarp och hangslen: git status --short + git symbolic-ref HEAD before every mutating git op. One commit per logical change, DCO sign-off (-s). Branch feat/bombardment-rig, synced to current main HEAD first.

Go — Phase 3 only.
```

---

## End of BOM
