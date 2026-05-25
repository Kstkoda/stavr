# BOM: Bombardment Phase 4 — chaos slices to green (local debug)

**Owner:** CC — runs **locally on a real Docker host** (WSL2, or a spare Linux box), NOT via CI round-trips.
**Sensitivity:** `careful` — touches the `bombardment/` rig + `.github/workflows/bombardment-docker.yml`; may add minimal **additive** daemon instrumentation (peer-client debug logging) but no daemon business logic.
**Verification window:** the local rig **is** the verification — each slice must be observed green on a real `docker compose` run before its CI step is re-armed.
**Branch:** `feat/bombardment-chaos-green`.
**Base:** `main` (after PR #82 merges).
**Estimated scope:** 5 phases, 2-3 PRs.

---

## Why this BOM exists

PR #82 shipped bombardment Phases 4 (chaos — 4a container-kill, 4b network-chaos, 4c projection-corruption) and 5 (adversarial fuzz). **Phase 5 is solid** — pure vitest, green, reviewed. **The Phase 4 chaos slices never ran green.** They were code-reviewed and unit-tested (the oracle *shape* tests pass) but never integration-tested against the real Docker topology. Discovering that one CI run at a time surfaced three sequential walls in the kill-slice alone:

1. `/opt/bombardment-chaos` mount missing — the in-container helpers weren't on the peer containers. Fixed (base-mount on `docker-compose.yml`).
2. `better-sqlite3` unresolvable — helpers at `/opt/...` could not reach the daemon's `/app/node_modules`. Fixed (mount moved to `/app/bombardment-chaos`).
3. `/events/sse` → HTTP 403 — the daemon's loopback-only operator-audit fence. Not patchable — see the invariant-3 decision below.

Debugging Docker-integration code through CI round-trips is the slowest possible loop. This BOM moves the work where it belongs: a real Docker host, iterating in seconds. The rig was designed for exactly this (Track 1).

## Decisions locked (do not re-litigate)

- **Debug locally.** `docker compose -f docker-compose.yml -f chaos.yml up -d` + each `run-*-slice.mjs` driven directly on a Docker host. Iterate locally until green; only then re-arm the CI step. CI is the final confirmation, never the debug loop.
- **Already fixed — do not redo:** the `/app/bombardment-chaos` mount path and the base-mount of the helpers (committed in PR #82).
- **The SSE loopback fence is by design.** `/events/sse` (and `/dashboard/*`) is restricted to loopback callers — `transports.ts` ~538-561, the family-mode-phase-1 Phase 5 fence — because it exposes the operator's audit log. A containerized daemon reached via a published host port sees the caller as non-loopback → 403. Correct daemon behaviour; it will **not** be weakened to suit a test.

## Decision (locked 2026-05-25) — kill-recovery oracle invariant 3

The kill-recovery oracle asserts three invariants on one kill cycle: (1) the restart policy brings `/healthz` back, (2) `startupDecisionSweep` produces a `decision_late_response` event, (3) an SSE consumer reconnects with `?since_id=` across the kill. Invariants 1-2 are sound. **Invariant 3 is structurally incompatible** with the containerized topology + the SSE loopback fence: from the host → 403; inside the container → the consumer dies *with* the container at kill; a netns-sharing sidecar (`network_mode: service:peer-a`) would read as loopback but loses its namespace when the target container is SIGKILL'd → also fails.

**Decision: option (a) — drop invariant 3 from the kill oracle.** Verified independently: there is no consumer that is *both* loopback to the daemon *and* survives a SIGKILL of the daemon's container — the topology makes it impossible, not merely awkward. Coverage is not lost — `tests/chaos.test.ts` already exercises the SSE `since_id` reconnect-and-resume logic in-process ("disconnected client can reconnect and resume from since_event_id"); only the across-a-container-kill wrapper, the impossible part, is dropped. Option (b) (rework so the consumer is loopback *and* kill-surviving) would add a daemon-side test seam for a path already covered in-process — not worth the daemon surface. Option (c) (env-gated exception to the SSE loopback fence) is rejected outright: that fence is the family-mode-phase-1 Phase 5 operator-audit boundary — it is not weakened for test convenience. The kill oracle keeps invariants 1-2, which need no `/events/sse`. (The `docker/hub-mcp` reference Dockerfile — clean multi-stage, non-root, `ENTRYPOINT ["node","dist/index.js"]`, no init-system, restart left to Docker's policy — reinforces this: keep container and daemon clean; let the restart policy do recovery, which is exactly invariants 1-2. It offers nothing that rescues invariant 3, because the SSE fence is a daemon-level loopback check, not a container concern.)

## Phases

**Phase 0 — local rig bring-up.** On a Docker host: build `stavr:ci`, `docker compose -f docker-compose.yml -f chaos.yml up -d`, confirm three daemons healthy and the federation oracles + Phase 3c pumba-slice pass locally. This establishes the fast loop everything else runs in.

**Phase 1 — kill-slice (4a) to green.** Apply the invariant-3 decision. Drive `run-kill-slice.mjs` locally; get invariants 1-2 passing against the real topology (RestartCount snapshot, the in-container `find-late-response` helper); iterate to green. Re-arm the CI kill-recovery step.

**Phase 2 — netchaos-slice (4b) to green** locally; re-arm its CI step.

**Phase 3 — projection-corruption slice (4c) to green** locally; re-arm its CI step.

**Phase 4 — the intermittent convergence finding.** `peerStateConvergence` intermittently catches a real non-convergence — on some runs 1 of the 4 reachable peer pairs never reaches `online` for the whole run, with no daemon error logged. Two enablers, then diagnose: (a) `bombardment-docker.yml`'s failure step collects `bombardment/artifacts/*.json` (the oracle's per-pair evidence — currently not uploaded); (b) add peer-client probe debug logging to the daemon (minimal, additive). Then determine daemon-bug vs. topology-issue (suspect: multi-homed-hub Docker DNS) and fix or file with a reproduction.

**Phase 5 — re-arm `bombardment-docker` as a gate.** Once 4a/4b/4c and the convergence oracle are reliably green locally and in CI, restore `bombardment-docker` as a required status check.

## Interim posture

Until this BOM completes, `bombardment-docker` is **not a gating check** — its Phase 4 chaos-slice steps fail on WIP code. PRs merge on the strength of `ci.yml` (vitest, incl. the Phase 5 fuzz suite), `peer-smoke`, and `daemon-sea`. If the red `bombardment-docker` becomes noisy on unrelated PRs before Phase 5, add `continue-on-error: true` to the three chaos-slice steps as an interim measure.

## Definition of done

1. `run-kill-slice.mjs`, `run-netchaos-slice.mjs`, `run-projection-corruption.mjs` all pass on a real Docker host **and** in CI.
2. Invariant 3's fate is decided and implemented; the kill oracle's remaining invariants are sound.
3. The intermittent convergence failure is diagnosed and fixed, or filed as a daemon bug with a deterministic reproduction.
4. `bombardment-docker` is green and re-armed as a required check.

## Run prompt for CC

```
Read CLAUDE.md, then proposed/bombardment-chaos-debug-bom.md. This BOM runs LOCALLY — you need a working Docker host (WSL2 or Linux). Do NOT debug via CI.

Invariant 3 is DECIDED — dropped (option a); see "Decision (locked)" above. Apply it, do not re-litigate. Then execute Phase 0 (local rig bring-up) and Phase 1 (kill-slice to green) ONLY. Iterate against `docker compose` locally until run-kill-slice.mjs passes, then STOP for operator review before Phases 2-5.

Sensitivity: careful. Skärp och hängslen: git status --short + git symbolic-ref HEAD before every mutating git op. Branch feat/bombardment-chaos-green off main. Per-phase commits, DCO sign-off (-s).

Go — Phase 0 + Phase 1 only.
```

---

## End of BOM
