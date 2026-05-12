# ADR 020 — Standalone daemon watchdog via OS scheduler

**Status**: Accepted
**Date**: 2026-05-12

## Context

ADR-019 made the shim self-healing for transient errors but explicitly punted on "the daemon is genuinely down" — at that point the shim exits 1 and waits for someone to restart the daemon. Spec 44's invariant 3 ("daemon supervision") says no human should have to do that: the daemon must restart within 30 seconds of dying, even after a hard kill or a host reboot.

The natural place to put supervision is the OS — every supported platform ships one (Task Scheduler on Windows, launchd on macOS, systemd --user on Linux). The decision is whether to lean on the OS supervisor directly, or whether to add a small Node-level companion that lives in front of it.

## Decision

Ship a small standalone watchdog process at `src/watchdog.ts` → `dist/watchdog.js`, and a `cowire daemon install / uninstall / watchdog-status` CLI that registers it with the per-platform scheduler:

- **Windows**: `schtasks /Create /TN CowireWatchdog /SC ONSTART` and a sibling `/SC ONLOGON` task, both running the watchdog as the current user.
- **macOS**: `~/Library/LaunchAgents/com.cowire.watchdog.plist` with `RunAtLoad=true` and `KeepAlive=true`, loaded via `launchctl load -w`.
- **Linux**: `~/.config/systemd/user/cowire-watchdog.service`, enabled with `systemctl --user enable --now`.

The watchdog itself pings `http://127.0.0.1:7777/healthz` every 30s. After 3 consecutive failures, and provided more than 60s has passed since the last restart attempt, it runs `cowire daemon stop` (best-effort) followed by `cowire daemon start --detach --log-format=json`. It writes a newline-delimited JSON log at `~/.cowire/watchdog.log` and a PID file at `~/.cowire/watchdog.pid` so `cowire daemon watchdog-status` can answer "is it registered? is it running? when did it last restart the daemon?"

We keep the watchdog as a separate process rather than:
1. **Letting the OS supervisor restart the daemon directly.** systemd / launchd can do exit-code-based restart, but they can't ping `/healthz` and react to a *hung* daemon (one that is still alive but no longer serving). The watchdog covers both "process died" and "process locked up" with one mechanism.
2. **Hosting the watchdog inside the daemon.** Same process; can't supervise itself.

The deepened `/healthz` (spec 44 §3) is critical to this design: it returns 503 if the SQLite DB becomes unreachable or read-only, which means the watchdog catches "the daemon is up but its persistence is broken" instead of waiting for the daemon to crash on the next write.

## Consequences

- One extra long-lived process per host. The watchdog does nothing but ping and sleep — RAM and CPU footprint is negligible.
- The watchdog and daemon are coupled via the CLI: if `cowire daemon start` changes its flags, the watchdog needs to be rebuilt and re-installed. Acceptable: re-running `cowire daemon install` is idempotent.
- A 60s restart cooldown means a daemon that crashes immediately on boot will see at most one restart per minute, not a tight loop. Worst case: the user manually inspects `~/.cowire/watchdog.log` and `~/.cowire/crash-*.json` to figure out why startup is failing.
- Install is per-user (LaunchAgent / `systemctl --user` / schtasks RU current user), not system-wide. The watchdog can therefore restart only the current user's daemon, which is what we want — Cowire is a per-user tool, not a shared service.
- On Linux, the watchdog stops when the user logs out unless they `loginctl enable-linger`. Documented in README, not enforced — users on multi-user hosts may prefer that behavior.

## Alternatives considered

- **PowerShell / systemd / launchd as the *only* watchdog.** Rejected: can't do deep healthz checks, only process liveness.
- **PM2 / forever / nodemon.** Adds a dependency and a fleet management layer we don't need. The point of this watchdog is to be trivially auditable (~150 LOC) and dependency-free.
- **systemd `Type=notify` + watchdog timer in the daemon.** Linux-only and assumes the daemon code is well-behaved enough to call `sd_notify` reliably under load. The standalone watchdog has no such coupling.
