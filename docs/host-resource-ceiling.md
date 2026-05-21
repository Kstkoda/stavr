# Host resource ceiling

A configured cap on how much of the host stavR and everything it spawns may consume. Enforced three ways so a single bug can't take the machine down.

## Why this exists

On 2026-05-20, a worker spawn explosion overloaded the host. The PC hung, PM2 died, and every running Claude Code session was killed with it. The OS-native governor work brings the daemon *back* after a crash — it does not *prevent* one. The host resource ceiling is the prevention.

## How it works

1. **Admission control** — before a worker spawn or other heavy op, the orchestrator checks current host headroom against the ceiling. Over-ceiling spawns are refused with a clear error.
2. **OS-level hard cap** — best-effort: cgroup-v2 on Linux when a delegated subtree is available; a wrapper PowerShell helper for Windows Job Objects; documented launchd plist on macOS. Where the OS cap can't be installed, PM2's `max_memory_restart` in `ecosystem.config.cjs` is the soft-cap surrogate.
3. **Load-shedding** — a runtime watchdog. When host headroom drops below the shed thresholds, the daemon stops accepting new work and terminates the most-recent worker.

## Configuration

`~/.stavr/stavr.yaml`, top-level key `host_ceiling`. All fields are optional — missing block applies the defaults below.

```yaml
host_ceiling:
  enabled: true                # master switch
  max_host_ram_pct: 0.75       # refuse new work above this fraction of host RAM in use
  min_free_ram_gb: 2.0         # AND keep at least this much free physical RAM
  max_sustained_cpu_pct: 0.85  # refuse new work above this fraction of host CPU sustained
  max_concurrent_workers: 4    # hard worker count cap (0 disables; advanced)
  headroom_window_ms: 10_000   # EWMA smoothing window for CPU/RAM
  shed_threshold_pct: 0.95     # load-shedding triggers above this RAM use
  shed_min_free_ram_gb: 0.5    # ... or below this free RAM
```

### Coherence rules

The loader validates two relationships that the per-field schema can't express alone:

- `shed_threshold_pct >= max_host_ram_pct` — shedding is the tighter threshold, not the looser one.
- `shed_min_free_ram_gb <= min_free_ram_gb` — shedding is the tighter floor.

Invalid combinations refuse-to-load with an explicit message.

## Defaults — why these numbers

| Knob | Default | Rationale |
|---|---|---|
| `max_host_ram_pct` | 0.75 | Leaves 25% headroom for the OS, the IDE, and the browser the operator reads dashboards in. |
| `min_free_ram_gb` | 2.0 | On a 64 GB host, 25% is 16 GB free which is generous; the floor is the safety. |
| `max_sustained_cpu_pct` | 0.85 | High enough not to refuse on a busy workload; low enough to leave responsiveness. |
| `max_concurrent_workers` | 4 | The 2026-05-20 incident was a spawn explosion. This knob alone would have prevented it. |
| `headroom_window_ms` | 10_000 | Reacts to real overruns; ignores 200 ms GC spikes. |
| `shed_threshold_pct` | 0.95 | By the time we're shedding, admission has been refusing for a while. |
| `shed_min_free_ram_gb` | 0.5 | Half a gigabyte of free RAM means the OS is about to swap; shed before that. |

## What this is NOT

- **Not per-worker quotas.** The ceiling is on the host, not per worker.
- **Not a cost / token budget.** Those live in a separate ADR.
- **Not a replacement for PM2 `max_memory_restart`.** It stays. The ceiling is *additional*.
- **Not federated.** Cross-machine headroom is federation/A2A territory.

## Operator escape hatches

- Set `host_ceiling.enabled: false` — admission control / OS cap / load-shedding all become no-ops (the host-headroom poller still runs for observability).
- Raise `max_concurrent_workers` to a high value if your machine has plenty of headroom and you know what you're doing.

## What you'll see when the ceiling trips

- A `worker_spawn` refused with `OrchestratorError` code `headroom_exceeded` — the message names the breached knob.
- An event `host_ceiling_refused` on the broker; the dashboard shows it on Diagnostics.
- Under shed: a `host_ceiling_shed` event naming the terminated worker, plus the standard `worker_terminated` event.
- The Diagnostics page surfaces `current_headroom` vs the ceiling at a glance.
