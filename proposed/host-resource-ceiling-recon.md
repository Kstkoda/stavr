# Recon: Host Resource Ceiling — what exists, what's missing, what the OS gives us

**Phase 0 of `proposed/host-resource-ceiling-bom.md`.** Notes only — no code changes in this phase.

## 1. The pollers we have (and what they observe)

All four observability pollers are **process-scoped** (they look at `process.memoryUsage()` / per-endpoint stats). None of them know what's going on with the *host*.

| File | What it samples | Interval | Where it fires |
|---|---|---|---|
| `src/observability/memory-poller.ts` | `process.memoryUsage()` → `daemon_memory` event | 60s | broker publish |
| `src/observability/rss-watchdog.ts` | `process.memoryUsage().rss` vs `STAVR_RSS_WATCHDOG_MB` (default 4000) — heap snapshot + `daemon_rss_watchdog` event on **leading edge** | 30s | broker publish + `tmp/rss-watchdog-snapshots/*.heapsnapshot` |
| `src/observability/perf-poller.ts` | per-endpoint p50/p95/p99 latency snapshot → `perf_sample` | 60s | broker publish |
| `src/observability/event-loop.ts` | event-loop lag / ELU (process-internal) → Prom + `daemon_eventloop` | 5s prom / 60s event | both |

All four follow the same shape (scheduler seam, `process.memoryUsage` seam, `.unref()` on the handle, `dispose()` return) — that's the pattern Phase 2 should reuse for the host-level poller.

Observation: **none of these refuse work, queue work, or shed load**. They observe and emit. The RSS watchdog is closest to enforcement — it writes a snapshot — but doesn't block the worker-spawn path either.

## 2. The worker-spawn path

Single entry point: `WorkerOrchestrator.spawn()` in `src/workers/orchestrator.ts:102`.

Current sequence:

1. `spawners.get(type)` — fail fast on unknown type.
2. `store.nameIsAvailable(name)` — refuse duplicate names.
3. `spawner.paramsSchema.safeParse(params)` — refuse invalid params.
4. **`this.gate(spawnReq, spawner.tier)`** — tier gate (`never` blocks; `auto` skips; `confirm` opens a `decision_request` or auto-approves under a trust scope).
5. `spawner.spawn(validated, ctx)` — actually fork the worker.
6. `store.upsertWorker(record)` — persist.
7. Wire event handlers, publish `worker_spawned`.

The gate is the natural place to splice **admission control** (Phase 3). It already returns `'approve' | 'reject' | 'skipped'` and we already have an `OrchestratorError` class with codes — adding a `headroom_exceeded` code on top of that fits the existing shape.

`dispatch()` and `terminate()` paths also call `gate()`; admission control should apply at `spawn()` (the resource-allocating action), not `dispatch()` (sending bytes to an already-running worker). `terminate()` should never be admission-controlled — terminating is what we do *to free resources*.

The orchestrator already keeps a `Map<workerId, LiveWorker>` (`this.live`) which Phase 5 (load-shedding) needs to pick a victim from.

## 3. Daemon wiring

`src/daemon.ts:startDaemonForeground` already wires the four observers (`startMemoryPoller`, `startPerfPoller`, `startRssWatchdog`, `startEventLoopMonitor`) with a uniform `try { …Stop = startX(broker) } catch { logger.error(...) }` pattern. Each `*Stop` is invoked during `shutdown(sig)`. The host-headroom poller (Phase 2) should be wired the same way.

PM2 ecosystem already has a *process-level* soft cap: `ecosystem.config.cjs:74 max_memory_restart: '7000M'`. That cap applies only to the daemon process, not to spawned workers, and it's a *restart* on breach — not a *prevent*-the-breach. It is complementary to the OS-level hard cap in Phase 4, not a substitute.

## 4. What the OS gives us for host metrics (cross-platform)

Node built-ins (all platforms, no native dep):

| Call | Returns | Win | macOS | Linux |
|---|---|---|---|---|
| `os.totalmem()` | total physical RAM in bytes | ✓ | ✓ | ✓ |
| `os.freemem()` | free RAM in bytes (note: Linux reports "free", not "available" — see below) | ✓ | ✓ | ✓ |
| `os.cpus()` | per-core `times` snapshot | ✓ | ✓ | ✓ |
| `os.loadavg()` | 1/5/15-min load average | returns `[0,0,0]` | ✓ | ✓ |
| `process.cpuUsage()` | µs cumulative user+system for *this* proc | ✓ | ✓ | ✓ |

For **host CPU %** cross-platform: poll `os.cpus()` at interval T, diff the `times.idle` vs total across cores, derive `1 - (idle_delta / total_delta)` as percent busy. This avoids `os.loadavg()` (not available on Windows). Pattern used by `pidusage`, `systeminformation`, etc.

For **host free RAM**: `os.freemem()` is "free pages", not "available" — on Linux, freshly-cached file pages are counted *not* free even though they would be reclaimed under pressure. For our purposes (refuse work when headroom is thin) we want a conservative number; `freemem()` is fine. If we want better, we'd read `/proc/meminfo` MemAvailable on Linux, but that's a platform branch. **Decision: use `os.freemem()` everywhere in v1; document the Linux conservatism.**

Worker RSS measurement is `process.memoryUsage()` *inside* the worker (we already capture metadata via the orchestrator's event channel). For accounting we don't strictly need per-worker RSS — admission control only needs current host headroom; the OS sums all stavR-spawned children naturally because we read host-level free RAM.

## 5. OS-level hard cap options (Phase 4)

The point of Phase 4 is: even if admission control has a bug, the daemon's process tree **physically cannot** exceed the configured ceiling. Per-platform options:

### Linux — cgroup v2

If `/sys/fs/cgroup` is cgroup v2 (default on modern distros), the daemon can place itself + descendants in a cgroup by writing PID to `cgroup.procs`. Memory cap via `memory.max`, CPU via `cpu.max`. Two flavours:

- **Systemd-managed**: `systemd-run --user --scope -p MemoryMax=… -p CPUQuota=… stavr daemon start`. Operator-driven; we document the recipe, don't auto-create the unit.
- **Self-managed**: at boot, detect cgroup v2, create a child cgroup under our delegated subtree, move ourselves into it. Requires the daemon to own a delegated subtree (systemd-user-session default for `user.slice`).

v1 plan: **self-managed best-effort** — try to write to a child cgroup, and if it fails (no delegated subtree, cgroup v1, permission denied), log a warning and continue with admission-control-only enforcement. **Don't refuse to boot** if OS cap can't be installed.

### Windows — Job Object

Job Objects are the right primitive: `JOB_OBJECT_LIMIT_PROCESS_MEMORY`, `JOB_OBJECT_LIMIT_JOB_MEMORY`, `JOB_OBJECT_LIMIT_PROCESS_TIME`. Creating one needs `kernel32.CreateJobObject` → `SetInformationJobObject` → `AssignProcessToJobObject`. There is no Node built-in.

Options:
- **Native addon (node-windows-job-object, etc.)**: adds a build-time native dep.
- **Spawn under a wrapper that pre-creates the Job Object**: `start-job.exe` that creates the Job, assigns itself, then ExecVE's into node. Most reliable but adds a binary.
- **PowerShell at startup**: `powershell.exe -Command "& { …Win32 Job Object via Add-Type…}"` to assign the daemon's PID. Doable but fragile.
- **Punt v1**: rely on PM2 `max_memory_restart` (already at 7000M) as the "OS-side" soft cap on Windows, document that hard-cap-via-Job-Object is a v2 improvement.

v1 plan for Windows: **document PM2 `max_memory_restart` as the Windows hard cap surrogate; ship an opt-in `bin/stavr-jobobject.ps1` helper that the operator can wrap their daemon-start command in if they want a real Job Object**. This keeps Phase 4 cross-platform without forcing a native dep into the daemon. Phase 6 verification will exercise admission control + load-shedding only (the deterministic paths); the OS cap is a backstop documented per platform.

### macOS

`launchd` `MemoryLimit` / `ResourceLimits` via launchd plist. Same posture as Linux: document the plist, don't auto-install. `prlimit` / `ulimit -v` works for address space but is per-process not per-tree.

### Cross-platform pragmatic v1

Phase 4 ships:
1. A `src/governor/os-cap.ts` module that *attempts* to install the OS cap on boot, returns `{ installed: true, kind: 'cgroup-v2' | 'job-object' | 'launchd' | 'none', reason?: string }`.
2. On Linux: cgroup-v2 self-managed write if a delegated subtree is available.
3. On Windows/macOS: returns `kind: 'none', reason: 'platform-not-implemented-v1'` and emits an event. The PM2 `max_memory_restart` already in `ecosystem.config.cjs` is documented as the practical surrogate.
4. Surface the result on Diagnostics in Phase 6 so the operator can see "OS cap: installed (cgroup-v2)" vs "OS cap: not installed (Windows — PM2 max_memory_restart in effect)".

This satisfies the BOM ("daemon's process tree capped so it physically cannot exceed the ceiling") on the platform we can do it cleanly (Linux/cgroup-v2) and is honest about the limitation elsewhere.

## 6. Defaults to settle in Phase 1

Conservative defaults proposed for the schema:

| Knob | Default | Rationale |
|---|---|---|
| `max_host_ram_pct` | `0.75` | Refuse new work above 75% host RAM consumption (sum of all procs, not just stavR). |
| `min_free_ram_gb` | `2.0` | Always keep 2 GB free physical RAM. Whichever of `max_host_ram_pct` / `min_free_ram_gb` is *more restrictive* wins. |
| `max_sustained_cpu_pct` | `0.85` | Refuse new work above 85% host CPU sustained over the headroom window (cf. §4 — `os.cpus()` delta). |
| `max_concurrent_workers` | `4` | Hard worker count cap; this is what the 2026-05-20 incident actually breached (spawn explosion). |
| `headroom_window_ms` | `10_000` | EWMA window for CPU/RAM smoothing — we don't want one spike to refuse, but a sustained 10s of overrun is real. |
| `shed_threshold_pct` | `0.95` | Stop accepting + start shedding when host RAM crosses this. |
| `shed_min_free_ram_gb` | `0.5` | Or when free RAM drops below this. |

These are deliberately tighter than the PM2 `max_memory_restart: 7000M` (which is the *daemon process* ceiling). The host ceiling is about the **machine**.

## 7. What is explicitly NOT in this BOM

- Per-worker resource quotas. The ceiling is on the **host**, not per worker — if a single worker is greedy, load-shedding kills it; we don't pre-allocate.
- Token / cost budgets — those are governor-territory (separate ADR, separate BOM).
- Cross-machine federated headroom (i.e., "if my laptop is full, shift to my desktop") — that's federation/A2A territory.
- Replacing PM2 `max_memory_restart`. It stays. The ceiling is additional.

## 8. Files this BOM will touch

| Phase | Files |
|---|---|
| 1 | `src/types/host-ceiling.ts` (new), `src/config.ts` (additive schema), `docs/host-resource-ceiling.md` (new) |
| 2 | `src/observability/host-headroom-poller.ts` (new), `src/daemon.ts` (wire + dispose) |
| 3 | `src/workers/orchestrator.ts` (admission gate in `spawn()`), `src/workers/types.ts` (error shape) |
| 4 | `src/governor/os-cap.ts` (new), `src/daemon.ts` (install on boot), `bin/stavr-jobobject.ps1` (Windows helper) |
| 5 | `src/governor/load-shedder.ts` (new), wire into the host-headroom poller |
| 6 | `src/dashboard/data/diagnostics.ts` (surface ceiling + headroom), `src/dashboard/pages/diagnostics.ts` (render), `tests/governor/over-ceiling.test.ts` (synthetic refusal) |

All paths confined to: observability + workers + (new) governor + dashboard surface. **No persistence schema change**, **no security primitive touch**, **no transport surface change**. Consistent with the BOM's "Don't-touch" list.

## 9. Verification posture

- After every phase: `npm test` + `npm run build` green.
- Phase 3 needs a unit test that proves a `spawn()` call is *refused* when the host headroom poller says we're over the ceiling — without spawning anything. Inject a mock poller into the orchestrator.
- Phase 5 needs a unit test that triggers the shed path with a synthetic over-ceiling sample and observes the orchestrator terminate the most-recent worker.
- Phase 6 ships an integration test that wires the real poller (with `os.freemem` mocked) end-to-end through the spawn path.

## 10. Risk / unknowns

- Cgroup v2 self-management without root: works only when the user session has a delegated subtree. The `subtree_control` write may EPERM. We swallow and log, run admission-control-only.
- Job Object via PowerShell at boot adds startup latency and is the single most fragile piece of Phase 4. Putting it in an *opt-in* helper script lets us punt without compromising the cross-platform story.
- `os.cpus()` delta math has a known edge case: if the cores list changes between samples (CPU hotplug, virtualization rescaling), the delta is bogus. Guard with: if `cpus().length` changes between samples, discard the sample and re-baseline.
- Tests around `os.freemem()` need a clean DI seam. We add `osMetrics?: { totalmem, freemem, cpus }` to the poller opts, default to `node:os`.

---

**End of recon.**
