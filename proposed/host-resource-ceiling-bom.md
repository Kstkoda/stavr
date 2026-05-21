# BOM: Host Resource Ceiling — stavR Must Not Kill the Host

**Owner:** CC
**Sensitivity:** `careful` — touches the daemon's worker-spawn path + the observability pollers; no security primitives, no irreversible infra.
**Verification window:** `targeted`.
**Branch:** `feat/host-resource-ceiling`
**Base:** `main`
**Estimated scope:** 7 phases (0-6), ~8-12h.

---

## Execution mode — AUTONOMOUS, LOCAL-ONLY (overnight run)

This BOM is built to run unattended after a single up-front operator kickoff. CC works **entirely on the local branch** `feat/host-resource-ceiling`: one commit per phase, push the branch at the end. CC does **NOT** open a PR, does **NOT** merge anything, and does **NOT** call any gated tool (`github_create_pr`, `github_merge_pr`, `worker_*`, any `switch` write tool). There are therefore **zero approval gates after kickoff** — the operator's only approval is the decision to start it. The operator reviews the finished branch in the morning and opens the PR then. **Nothing ships unattended.** Worst case is a branch the operator discards.

## Why this BOM exists

2026-05-20: a CC-worker spawn overloaded the host — the PC hung, PM2 died, every Claude Code session was killed. stavR has no resource ceiling: nothing stops the daemon, its workers, or the work it drives from consuming all host RAM/CPU and taking the machine down. The OS-native governor decided the same day brings the daemon *back* after a crash — it does not *prevent* one. This BOM builds the prevention.

## The design

stavR gains a **host-resource ceiling** — a configured cap on how much of the host stavR and everything it spawns may consume — enforced by the daemon three ways:

- **Admission control** — before spawning a worker or starting heavy work, check host headroom against the ceiling; if the action would breach it, refuse or queue.
- **OS-level hard cap** — the daemon's process tree runs under a Windows Job Object / Linux cgroup memory+CPU limit, so even a runaway physically cannot exceed the ceiling.
- **Load-shedding** — if host headroom drops below a runtime threshold, stop accepting new work; if still over, terminate the most-expensive/most-recent worker.

## Reference reading

- `CLAUDE.md` — invariants.
- `src/observability/memory-poller.ts`, `rss-watchdog.ts`, `perf-poller.ts`, `perf-metrics.ts` — extend these from observing to enforcing.
- `src/workers/` (the spawn path), `src/daemon.ts`, `adr/020-daemon-watchdog.md`.
- Memory: `stavr-independent-governor-decision-2026-05-20` (this is the resource-governance that Governor Option A deliberately left out).

## Don't-touch

- Security primitives, persistence schema, the permission model.
- Gated tools — see execution mode.

## Phases

- **Phase 0 — recon:** the existing pollers, the worker-spawn path, what host-level (not process-level) metrics are reachable on Windows/macOS/Linux. Output `proposed/host-resource-ceiling-recon.md`.
- **Phase 1 — ceiling config:** a schema for the ceiling — max % host RAM, min free RAM (GB), max sustained CPU %, max concurrent workers — with conservative defaults.
- **Phase 2 — host headroom monitoring:** extend the pollers from process-level to host-level free RAM / CPU.
- **Phase 3 — admission control:** gate worker spawns and heavy operations on headroom vs the ceiling; refuse or queue when an action would breach it.
- **Phase 4 — OS-level hard cap:** Windows Job Object + Linux cgroup; the daemon's process tree capped so it physically cannot exceed the ceiling.
- **Phase 5 — load-shedding:** a runtime headroom watchdog — stop accepting work, then shed, when the host is stressed.
- **Phase 6 — dashboard + verification:** surface the ceiling + current headroom on Diagnostics; tests including a synthetic over-ceiling scenario that must be refused/shed, never crash.

## Constraints

- Local-only — no PR, no merge, no gated tools (execution mode).
- One commit per phase, DCO sign-off (-s).
- `npm test` + `npm run build` pass after every phase commit. If a phase regresses irrecoverably, revert that commit and continue — do not cascade.
- `git status --short` + `git symbolic-ref HEAD` before every mutating git op.

## Definition of done

1. A configured host-resource ceiling with conservative defaults.
2. The daemon refuses/queues work that would breach the ceiling (admission control).
3. The daemon's process tree is OS-capped (Job Object / cgroup) — it physically cannot exceed the ceiling.
4. Runtime load-shedding triggers when the host is stressed.
5. A synthetic over-ceiling test is refused/shed, not a crash.
6. Branch `feat/host-resource-ceiling` pushed, every phase committed, a summary left for morning review. No PR opened.

## Run prompt for CC (paste this when launching CC)

```
Read CLAUDE.md, then proposed/host-resource-ceiling-bom.md, and execute it end to end — all 7 phases.

EXECUTION MODE: autonomous, local-only. Work entirely on branch feat/host-resource-ceiling off main. One commit per phase (DCO -s). Push the branch when done. Do NOT open a PR, do NOT merge, do NOT call any gated tool (github_create_pr/merge, worker_*, any switch write tool). There must be zero approval gates after this kickoff. Leave an end-of-run summary for morning review.

Sensitivity: careful. npm test + npm run build must pass after every phase commit; if a phase regresses irrecoverably, revert that commit and continue — do not cascade.

Skärp och hängslen: git status --short + git symbolic-ref HEAD before every mutating git op.

Stop conditions: npm test baseline regresses unrecoverably, or npm run build fails unrecoverably. Otherwise run all 7 phases to completion. Go.
```

---

## End of BOM
