# BOM: OS-Native Governor — Cross-Platform Boot + Supervision

**Owner:** CC
**Sensitivity:** `careful` — produces OS-service definitions + install scripts. CC does NOT register services itself (system-modifying — operator-run). Status check per commit; report per phase.
**Verification window:** `targeted` — per-platform install + reboot smoke.
**Branch:** `feat/os-native-governor`
**Base:** `main`
**Estimated scope:** 6 phases (0-5), 3 PRs.

---

## Why this BOM exists

On 2026-05-20 a CC-worker spawn overloaded the host; the PC hung and **PM2 itself died** along with everything else. PM2 was never an independent supervisor — when the machine struggled, the supervisor went down with it, the stavR daemon stayed dead, and recovery was fully manual. This is the recurring hands-on burden: the 2026-05-19 reboot that didn't auto-resume, the errored `pm2-windows-startup` module, the orphan-daemon pattern.

Decided 2026-05-20 via 10-3-1 (memory `stavr-independent-governor-decision-2026-05-20`): **Option A — OS-native service, direct.** The OS init system on each platform — systemd, launchd, Windows SCM — IS the governor. These are kernel-adjacent, effectively never die, and start services at boot before login. PM2 is dropped entirely.

## Accepted scope boundary (read this — it is deliberate)

Option A is **restart-on-crash + boot-start only.** It deliberately does NOT prevent the resource overload that caused the 2026-05-20 crash — that was a conscious trade against Option B (the resource-governing supervisor). Worker-spawn resource caps — cap concurrency/memory, refuse overloading spawns — are a **separate concern** belonging in the daemon itself / family-mode Phase 1's enforcement work, and are explicitly OUT of scope here. This BOM makes the daemon *come back*; it does not make it *un-crashable*.

## What CC builds vs. what the operator runs

CC produces the service definitions, install/uninstall scripts, crash-loop config, tests, and docs. **CC does NOT register OS services itself** — `systemctl enable`, `launchctl load`, `sc.exe create` are system-modifying actions and are operator-run. The deliverable is turnkey install scripts + a step-by-step operator install doc, not an autonomous system change.

## Reference reading

- `CLAUDE.md` — invariants.
- `adr/020-daemon-watchdog.md`, `adr/033-stavr-tray-companion.md` (the Governor — note: A does NOT use the Tauri Governor as the supervisor).
- `ecosystem.config.cjs` (the PM2 config being retired), `src/cli.ts` (`stavr daemon start`).
- Memory: `stavr-independent-governor-decision-2026-05-20`.

## Phases

- **Phase 0 — recon:** the daemon's actual start command, the current PM2 setup (`ecosystem.config.cjs`), env vars and working directory a service needs, log destinations. Output `proposed/os-native-governor-recon.md`.
- **Phase 1 — Linux (systemd):** a systemd unit pointing at the daemon, with `Restart=on-failure` + `StartLimitBurst` / `StartLimitIntervalSec` crash-loop backoff. Install/uninstall scripts.
- **Phase 2 — macOS (launchd):** a LaunchDaemon plist (`KeepAlive` + throttle interval), install/uninstall scripts.
- **Phase 3 — Windows (Service):** a Windows Service via WinSW (bundled) — boot-start, pre-login, auto-restart with escalating-delay failure actions. Install/uninstall scripts. Removes the broken `pm2-windows-startup` approach.
- **Phase 4 — drop PM2:** deprecate `ecosystem.config.cjs`; remove PM2 from the documented install path; confirm nothing else depends on it.
- **Phase 5 — docs + verification:** one cross-platform operator install guide; per-platform smoke — install the service, reboot the machine, confirm the daemon returns pre-login.

## Crash-loop guard (mandatory)

Even an OS service will restart a crash-looping daemon forever. Each platform's config MUST include backoff: systemd `StartLimitBurst` / `StartLimitIntervalSec`, launchd throttling, Windows SC failure-actions with escalating delay. A daemon that fails N times in M minutes backs off rather than hammering.

## Supersedes

Family-mode Phase 2's **Phase 6 — Windows Service boot persistence**. That phase is now redundant — trim it to reference this BOM when Phase 2 is next revisited.

## Sensitivity & cadence

`careful`. Status check before/after commits; delta report per phase.

## PR grouping

- PR 1 — Phase 0 recon + Phase 1 (Linux).
- PR 2 — Phases 2-3 (macOS + Windows).
- PR 3 — Phases 4-5 (PM2 removal + docs + verification).

## Definition of done

1. systemd / launchd / Windows Service definitions, each starting the daemon at boot, pre-login, with crash-loop backoff.
2. Turnkey install/uninstall scripts + one operator install guide, per the "CC builds, operator installs" split.
3. PM2 removed from the install path; `ecosystem.config.cjs` deprecated.
4. Per-platform: install → reboot → daemon auto-returns, verified.
5. The accepted gap (no overload prevention) is documented in the install guide, not silently dropped.

## Run prompt for CC

```
Read CLAUDE.md, then proposed/os-native-governor-bom.md. Execute Phase 0 (recon) and continue through the phases.

Sensitivity: careful. Status check before/after commits; delta report per phase.

You build service definitions + install scripts + docs. You do NOT run systemctl / launchctl / sc.exe yourself — service registration is operator-run; your deliverable is turnkey scripts + an operator install doc.

Skärp och hängslen: git status --short + git symbolic-ref HEAD before every mutating git op. One commit per phase, DCO sign-off (-s). Branch feat/os-native-governor off main.

Go.
```

---

## End of BOM
