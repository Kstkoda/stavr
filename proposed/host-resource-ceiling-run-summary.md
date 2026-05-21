# Host Resource Ceiling — overnight run summary (2026-05-20 → 21)

**Branch:** `feat/host-resource-ceiling` (pushed to `origin`)
**Base:** `main` at `6382c55`
**Commits:** 7 (one per phase, all DCO `-s`)
**Final test state:** 1460 passed, 1 skipped. `npm run build` clean.
**Approval gates fired:** 0 (autonomous local-only run as designed).
**PR opened / merged:** none (per execution mode).

## Phase commits

| Phase | SHA | Subject |
|---|---|---|
| 0 | `dba706a` | docs — recon of pollers, spawn path, OS metrics |
| 1 | `7c3c059` | ceiling config schema + conservative defaults |
| 2 | `52e30c8` | host-level headroom poller |
| 3 | `64f89e1` | admission control on worker_spawn |
| 4 | `e5ade22` | OS-level hard cap (best-effort) |
| 5 | `71155ed` | load-shedding watchdog |
| 6 | `08ba839` | dashboard surface + synthetic verification |

## What the BOM asked for vs what landed

| BOM DoD | Status |
|---|---|
| 1. Configured host-resource ceiling with conservative defaults | ✅ `src/types/host-ceiling.ts`, defaults documented in `docs/host-resource-ceiling.md`. |
| 2. Daemon refuses/queues work that would breach the ceiling | ✅ Refuses (queue not implemented — explicit v1 choice; see "Open follow-ups" below). |
| 3. Daemon's process tree is OS-capped (cannot exceed the ceiling) | 🟡 Best-effort: cgroup-v2 self-managed on Linux when a delegated subtree is available; opt-in Windows Job Object via `bin/stavr-jobobject.ps1`; macOS documented (no auto-install). PM2 `max_memory_restart` stays as soft-cap surrogate. Recon §5 explains the v1 posture. |
| 4. Runtime load-shedding triggers when the host is stressed | ✅ `src/governor/load-shedder.ts`, terminates the most-recent worker, with cool-down. |
| 5. Synthetic over-ceiling test is refused/shed, not a crash | ✅ `tests/integration/host-resource-ceiling.test.ts` — four cases including the load-shed-vs-crash assertion. |
| 6. Branch pushed, every phase committed, no PR | ✅. |

## Files touched

```
adr/                                          # untouched
bin/stavr-jobobject.ps1                       # new (Phase 4)
docs/host-resource-ceiling.md                 # new (Phase 1)
proposed/host-resource-ceiling-bom.md         # the BOM itself (kept as docs)
proposed/host-resource-ceiling-recon.md       # new (Phase 0)
proposed/host-resource-ceiling-run-summary.md # this file
src/config.ts                                 # additive: host_ceiling block + coherence check
src/daemon.ts                                 # wired poller + setHostCeilingContext + OS cap + shedder
src/dashboard/data/host-ceiling.ts            # new (Phase 6)
src/dashboard/pages/diagnostics.ts            # additive panel insertion + CSS
src/event-types.ts                            # +4 event kinds
src/governor/load-shedder.ts                  # new (Phase 5)
src/governor/os-cap.ts                        # new (Phase 4)
src/observability/host-headroom-poller.ts     # new (Phase 2)
src/server.ts                                 # setHostCeilingContext + getOrchestrator accessor
src/transports.ts                             # diagnosticsData() carries hostCeiling
src/types/host-ceiling.ts                     # new (Phase 1)
src/workers/orchestrator.ts                   # admission check + shedWorker + accessors

tests/dashboard/host-ceiling-data.test.ts     # new (Phase 6)
tests/governor/load-shedder.test.ts           # new (Phase 5)
tests/governor/os-cap.test.ts                 # new (Phase 4)
tests/integration/host-resource-ceiling.test.ts # new (Phase 6 — DoD #5)
tests/observability/host-headroom-poller.test.ts # new (Phase 2)
tests/types/host-ceiling.test.ts              # new (Phase 1)
tests/workers/admission-control.test.ts       # new (Phase 3 + extended in Phase 5)
```

Nothing in the BOM's don't-touch list was modified: security primitives, persistence schema, the permission model, and gated tools all stayed put. The transports surface only gained a single `hostCeiling` field on the existing `diagnosticsData()` getter.

## Conservative defaults applied

```yaml
host_ceiling:
  enabled: true
  max_host_ram_pct: 0.75
  min_free_ram_gb: 2.0
  max_sustained_cpu_pct: 0.85
  max_concurrent_workers: 4
  headroom_window_ms: 10_000
  shed_threshold_pct: 0.95
  shed_min_free_ram_gb: 0.5
```

Coherence rules enforced at load time:
- `shed_threshold_pct >= max_host_ram_pct`
- `shed_min_free_ram_gb <= min_free_ram_gb`

## Behaviour you'll see on the dashboard

A new panel in `/dashboard/diagnostics/engine` Health section:

- Halo dot: ok (green) / warn (amber) / crit (red) / idle (grey).
- Tiles: ceiling knobs (Enabled, Max RAM %, Min free RAM, Max sustained CPU, Max workers), current snapshot (RAM in use ewma, RAM free, CPU sustained), OS cap status, and Refused / Shed counts in the last hour.

Events the operator can `stavr tail` to see live activity:
- `daemon_host_headroom` — every 2s (host RAM/CPU snapshot).
- `host_ceiling_refused` — every refused admission, naming the breached knob.
- `host_ceiling_shed` — every load-shed event, naming the victim worker + the headroom number that triggered it.
- `host_ceiling_os_cap` — one at boot, describing the OS-cap install result.

## What I deliberately did NOT do

- **Queue instead of refuse.** The BOM said "refuse or queue". Refusing is simpler and matches the 2026-05-20 incident's real failure mode (we never wanted those extra spawns). Queueing would need a fairness policy + a back-pressure surface and a way for the operator to see the queue. Punt to a follow-up if it turns out the operator wants it.
- **Per-worker quotas.** The ceiling is on the host; the design says load-shed picks a victim instead.
- **A native node-windows-job-object addon.** Phase 4 ships a PowerShell trampoline `bin/stavr-jobobject.ps1` as the v1 Windows hard cap. The trade-off (no native dep vs operator-installed wrapper) is documented in `docs/host-resource-ceiling.md` and `proposed/host-resource-ceiling-recon.md` §5.
- **Auto-installing a systemd unit / launchd plist.** Recon §5 documents the recipe in `docs/host-resource-ceiling.md`. The operator owns service-manager files; we don't.
- **Touching the perf-poller, memory-poller, or rss-watchdog.** The host-headroom poller is a new sibling. The four existing pollers continue to observe their process-level signals unchanged.

## Open follow-ups (not in this BOM)

1. **Optional queueing mode** (`host_ceiling.refusal_mode: refuse | queue`) — adds a small async queue with TTL; on headroom recovery, dequeue oldest. Operator-facing event would be `host_ceiling_queued`.
2. **Tail-PowerShell native Job Object binding** to replace the trampoline (would require `node-windows-job-object` or our own native addon).
3. **Cross-machine federated headroom** — federation/A2A territory; out of scope per the BOM.
4. **Per-spawner cost weights** — admission control currently treats all spawn types equally. A cheap MCP-stdio spawn and a heavy long-context CC spawn are not the same load. The hooks are in place (`liveWorkerIdsInSpawnOrder`); next iteration could weight by spawner type.

## Validation in the morning

- `git log --oneline main..feat/host-resource-ceiling` should show 7 commits, all DCO-signed.
- `npm test` and `npm run build` should both be clean on the branch tip.
- The synthetic over-ceiling tests live in `tests/integration/host-resource-ceiling.test.ts` — they assert refusal-not-crash + load-shed-victim-selection + dashboard-data-flow.
- Visual check: start the daemon on this branch and open `/dashboard/diagnostics/engine` — the new "host ceiling: armed · …" panel should appear in the Health section.

— CC
