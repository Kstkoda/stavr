# stavR OS-native governor — operator install guide

This document is the cross-platform install guide for the
**os-native-governor** BOM. It supersedes the PM2-based install path
documented previously in `README.md` and `docs/governor.md`.

> **What changed (2026-05).** PM2 is no longer the documented supervisor.
> Each platform's native init system (systemd / launchd / Windows
> Service via WinSW) now starts the daemon at boot, restarts it on
> crash, and applies crash-loop backoff. The Tauri Tray Governor
> remains as an observability companion (tray icon, tooltip, toasts)
> but no longer drives crash recovery on fresh OS-native installs.
> See [`proposed/os-native-governor-bom.md`](../proposed/os-native-governor-bom.md)
> for the why.

---

## Before you install (all platforms)

1. **Node ≥ 20** must be on the operator's `PATH`. The service unit
   captures the full path to `node` at install time; if you replace
   Node later (Homebrew update, NVM switch), re-run the install
   script so the unit picks up the new path.
2. **Build the daemon** in the repository root:
   ```sh
   npm install
   npm run build
   ```
   The service unit references `dist/cli.js`; without a successful
   build, the install script will refuse to run.
3. **stavR data directory.** The default is `~/.stavr` (or
   `%USERPROFILE%\.stavr` on Windows). To override, set
   `STAVR_HOME=<path>` in your shell **before** running the install
   script; the service unit writes that value into its env directives.

## Accepted gap — read this first

The OS-native governor brings the daemon **back** after a crash. It
does **not** prevent the kind of resource overload that caused the
2026-05-20 crash (a CC-worker spawn explosion took down the host, PM2,
and the daemon together).

Worker-spawn resource caps — capping concurrency / memory, refusing
overloading spawns — are a SEPARATE concern owned by the daemon itself
and the family-mode work, not by this BOM. The host-resource-ceiling
work (see [`docs/host-resource-ceiling.md`](./host-resource-ceiling.md))
adds the OS-level hard cap; the daemon's own admission control adds the
soft cap.

**If your host is at capacity and you spawn a runaway worker, this
install does not save you.** It makes recovery automatic after the
fact; it does not make the daemon un-crashable.

---

## Linux (systemd, user instance)

### Install

```sh
cd <your stavR repo root>
npm run build
bin/install-systemd.sh

# Reload + enable + start (the install script PRINTS these — the operator
# runs them):
systemctl --user daemon-reload
systemctl --user enable --now stavr.service
```

The install script writes `~/.config/systemd/user/stavr.service` with
the operator's resolved values (node binary, install dir, `STAVR_HOME`,
`HOME`, `PATH`). The unit:

- Runs `node dist/cli.js daemon start --port 7777 --db <STAVR_HOME>/runestone.db --log-format json` in the FOREGROUND (no `--detach`).
- Restarts on non-zero exit after `RestartSec=30`.
- Halts after 5 starts in 5 minutes via `StartLimitBurst=5` + `StartLimitIntervalSec=300` (the BOM-mandated crash-loop guard).
- Memory ceiling `MemoryHigh=7G` (matches the retired PM2 `max_memory_restart`).
- Logs to journald (no rotation needed — journald handles it).

### Verify

```sh
systemctl --user status stavr.service
journalctl --user -u stavr.service -f
curl -s http://127.0.0.1:7777/healthz
```

The `/healthz` endpoint should return JSON with `"ok": true`.

### Reboot smoke (DoD verification)

The Definition of Done requires `install → reboot → daemon auto-
returns`. To verify on Linux:

```sh
# 1. Confirm the service is enabled and active before reboot.
systemctl --user is-enabled stavr.service     # → enabled
systemctl --user is-active  stavr.service     # → active

# 2. Reboot.
sudo reboot

# 3. After the system is back up, log in, then:
systemctl --user status stavr.service          # → active (running)
curl -s http://127.0.0.1:7777/healthz          # → {"ok": true, ...}
journalctl --user -u stavr.service --since "5 minutes ago"
```

If the service does NOT come up at login, the most common cause is
**lingering** is not enabled on a headless host. Enable it once:

```sh
sudo loginctl enable-linger $USER
```

This lets the user-systemd instance run before any interactive login,
which is what you want for a host that auto-restarts after a power
event without anyone logging in.

### Uninstall

```sh
systemctl --user stop stavr.service
systemctl --user disable stavr.service
bin/uninstall-systemd.sh --force
systemctl --user daemon-reload
```

---

## macOS (launchd LaunchAgent)

### Install

```sh
cd <your stavR repo root>
npm run build
bin/install-launchd.sh

# Bootstrap + enable + kickstart (the install script PRINTS these):
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.stavr.daemon.plist
launchctl enable    gui/$(id -u)/com.stavr.daemon
launchctl kickstart gui/$(id -u)/com.stavr.daemon
```

The install script writes `~/Library/LaunchAgents/com.stavr.daemon.plist`
with the operator's resolved values and runs `plutil -lint` to validate
the plist before printing the operator commands. The agent:

- Runs `node dist/cli.js daemon start --port 7777 --db <STAVR_HOME>/runestone.db --log-format json` in the foreground.
- `KeepAlive{SuccessfulExit=false}`: restart only on non-zero exit; a
  clean SIGTERM via `launchctl bootout` stays stopped.
- `ThrottleInterval=30` — throttle relaunches to once per 30 seconds.
- `RunAtLoad=true` — boot-start at user login.
- Logs to `~/Library/Logs/stavr/stdout.log` and `stderr.log`.

### Verify

```sh
launchctl print gui/$(id -u)/com.stavr.daemon | head -40
curl -s http://127.0.0.1:7777/healthz
tail -F ~/Library/Logs/stavr/stderr.log
```

### Reboot smoke (DoD verification)

```sh
# 1. Confirm the agent is loaded before reboot.
launchctl print gui/$(id -u)/com.stavr.daemon | grep -E "state|pid"
# Expect: state = running; pid = <number>

# 2. Reboot.
sudo shutdown -r now

# 3. After login, the LaunchAgent should auto-load:
launchctl print gui/$(id -u)/com.stavr.daemon | grep state
curl -s http://127.0.0.1:7777/healthz
```

A LaunchAgent (per-user) loads on the first GUI login after reboot.
If your Mac is in autologin mode, the agent loads as soon as the
session is up. If you require a manual login, the agent waits until
you log in.

### macOS crash-loop limitation (documented gap)

launchd has no burst-cap equivalent of systemd's `StartLimitBurst`.
If the daemon crashes repeatedly, launchd will keep restarting it
every 30 seconds indefinitely. The `~/Library/Logs/stavr/stderr.log`
file will fill with the per-restart noise. If you see this:

1. `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.stavr.daemon.plist`
2. Investigate the crash via `~/Library/Logs/stavr/stderr.log` +
   `dist/cli.js daemon status`.
3. Re-bootstrap after the fix.

### Uninstall

```sh
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.stavr.daemon.plist
bin/uninstall-launchd.sh --force
```

---

## Windows (Windows Service via WinSW)

### Prerequisites

Place the WinSW binary at `bin/winsw/StavrDaemon.exe`. See
[`bin/winsw/README.md`](../bin/winsw/README.md) for the pinned
WinSW version, the SHA256 hash you must verify after download, and
the PowerShell snippet that does the verify-then-place sequence.

### Install (elevated PowerShell at the repo root)

```powershell
npm run build
.\bin\install-windows-service.ps1

# Register + start the service (the install script PRINTS these):
.\bin\winsw\StavrDaemon.exe install
.\bin\winsw\StavrDaemon.exe start
```

The install script writes `bin\winsw\StavrDaemon.xml` with the
operator's resolved values (`USERPROFILE` is captured at install
time so the LocalSystem service still reads/writes the operator's
data directory). The service:

- Runs `node dist/cli.js daemon start --port 7777 --db <STAVR_HOME>/runestone.db --log-format json` in the foreground.
- `<startmode>Automatic</startmode>` + `<delayedAutoStart>true</delayedAutoStart>` — boot-start, after critical Windows services.
- Crash-loop guard: 3 escalating `<onfailure action="restart" delay="30 sec | 1 min | 5 min"/>` entries, then `<onfailure action="none"/>` halt. `<resetfailure>1 hour</resetfailure>` resets the counter after an hour of healthy uptime.
- Logs to `<install>\logs\StavrDaemon.{out,err,wrapper}.log`, size-rotated at 10 MB, keeping 5 files.

### Verify

```powershell
Get-Service StavrDaemon
.\bin\winsw\StavrDaemon.exe status
Get-Content -Wait -Tail 30 .\logs\StavrDaemon.err.log
curl.exe -s http://127.0.0.1:7777/healthz
```

### Reboot smoke (DoD verification)

```powershell
# 1. Confirm the service is set to start automatically.
Get-Service StavrDaemon | Select-Object Name, Status, StartType
# Expect: Status=Running, StartType=Automatic (or AutomaticDelayedStart)

# 2. Reboot.
Restart-Computer -Force

# 3. After the system is back up — BEFORE LOGGING IN, if possible —
#    confirm the daemon is responding:
curl.exe -s http://127.0.0.1:7777/healthz
# Expect: {"ok": true, ...} pre-login.
```

The Windows Service starts pre-login (that's the whole point of
`<startmode>Automatic</startmode>`), so `/healthz` should respond
before any interactive user session starts.

### LocalSystem vs your account

By default the service runs as `LocalSystem`. The plist sets
`USERPROFILE` / `HOME` / `STAVR_HOME` to your account's values
explicitly, so the daemon reads/writes the right data directory
regardless of the service account.

If you prefer the service to run **as your account** (e.g. for
SSH key access, GitHub CLI credential resolution), open
`services.msc`, right-click `StavrDaemon` → Properties → Log On →
"This account" → enter your credentials. Windows stores the
password in LSA secrets after this; you'll need to re-enter it if
you change the account password.

### Uninstall (elevated PowerShell)

```powershell
.\bin\winsw\StavrDaemon.exe stop
.\bin\winsw\StavrDaemon.exe uninstall
.\bin\uninstall-windows-service.ps1 -Force
```

The WinSW binary at `bin\winsw\StavrDaemon.exe` is left in place
after uninstall — delete it manually if no longer needed.

---

## Cross-platform comparison

| Concern | Linux (systemd) | macOS (launchd) | Windows (WinSW) |
|---|---|---|---|
| Service scope | user instance | LaunchAgent (per-user) | Windows Service (LocalSystem by default) |
| Boot-start | `WantedBy=default.target` + lingering for headless | `RunAtLoad=true` (loads at user login) | `<startmode>Automatic</startmode>` (pre-login) |
| Restart trigger | non-zero exit | non-zero exit (`KeepAlive{SuccessfulExit=false}`) | non-zero exit + `<onfailure action="restart"/>` |
| Restart delay | `RestartSec=30s` | `ThrottleInterval=30s` | escalating: 30s / 1m / 5m |
| Crash-loop guard | `StartLimitBurst=5` / `StartLimitIntervalSec=300s` → halt | (none — OS limitation, documented) | 3 onfailure restarts then `<onfailure action="none"/>` |
| Memory ceiling | `MemoryHigh=7G` (cgroup-v2 soft) | (none in plist — node `--max-old-space-size=8192` is the only ceiling) | (none in XML — same) |
| Log destination | journald | `~/Library/Logs/stavr/{stdout,stderr}.log` | `<install>\logs\StavrDaemon.{out,err}.log` (size-rotated, keep 5) |
| Log tail command | `journalctl --user -u stavr.service -f` | `tail -F ~/Library/Logs/stavr/stderr.log` | `Get-Content -Wait .\logs\StavrDaemon.err.log` |
| Headless requirement | `loginctl enable-linger $USER` | none (LaunchAgent waits for login) | none (boots pre-login) |

---

## Migration from PM2

If you previously ran the daemon under PM2 (`pm2 start ecosystem.config.cjs`),
migrate in this order:

```sh
# 1. Stop the PM2-managed daemon.
pm2 stop stavr
pm2 delete stavr
pm2 save                     # so PM2's persisted process list doesn't try to restart it

# 2. (Optional) remove the PM2 startup script if you registered one.
#    Linux:    pm2 unstartup systemd
#    macOS:    pm2 unstartup launchd
#    Windows:  pm2-windows-startup uninstall  (note: this module is in the
#                                              "errored loop" failure mode
#                                              the BOM specifically calls
#                                              out; if `pm2 list` shows it,
#                                              uninstalling the npm
#                                              package is the cleanest fix:
#                                              `npm uninstall -g pm2-windows-startup`)

# 3. Install the OS-native service per your platform (see above).

# 4. Verify the new service handles a crash:
#    Linux:    pkill -KILL -f 'dist/cli.js daemon start' && sleep 35 && curl http://127.0.0.1:7777/healthz
#    macOS:    same
#    Windows:  Stop-Process -Force -Name node ; Start-Sleep -Seconds 35 ; curl.exe http://127.0.0.1:7777/healthz
#    Expected: daemon comes back within ~30 seconds (the per-platform restart delay)
```

`ecosystem.config.cjs` is **kept on disk** with a deprecation banner —
it still functions for any tooling that depends on the file existing
(notably the Tauri Tray Governor's internal crash-recovery code, which
still shells out to `pm2 start ecosystem.config.cjs` until a follow-up
BOM rebuilds the Rust binary).

---

## What is NOT in scope for this install

The os-native-governor BOM deliberately does NOT cover:

1. **Resource overload prevention** — see [Accepted gap](#accepted-gap--read-this-first) above. The host-resource-ceiling work and family-mode worker-spawn caps own that concern.
2. **Steward agent subprocess** — `stavr-steward-agent` (the second PM2 app in the retired `ecosystem.config.cjs`) is not supervised by the OS-native installers here. The recon doc flagged this as Open Question Q1; the working assumption is "sibling OS services per platform" but the actual service definitions for the Steward agent are not part of this BOM.
3. **Tauri Tray Governor rebuild** — the Rust binary at `governor/` still shells out to PM2 for its internal restart logic. The tray icon / tooltip / toast features keep working on OS-native installs; the right-click "Restart Daemon" menu item is non-functional without PM2 present. A follow-up BOM rebuilds the Tray Governor to call the per-platform service-control commands.
4. **ADR-020 watchdog** — the standalone watchdog (`src/watchdog.ts`, registered via `stavr daemon install`) still calls `stavr daemon start --detach` on hang detection. With the OS supervisor expecting to own the daemon's lifecycle, that `--detach` spawns an orphan the OS sees as the daemon-having-died. A per-platform Phase update of the watchdog to call `systemctl --user restart` / `launchctl kickstart -k` / `WinSW restart` is a follow-up.

These gaps are intentional — the BOM's scope boundary was "make the daemon come back; do not make it un-crashable." Closure on each is its own BOM.

---

## Troubleshooting

### "Service starts but `/healthz` is unreachable"

The daemon is bound to `127.0.0.1:7777` by default. If you changed the
bind via `STAVR_BIND_HOST` or `--bind-host`, the daemon refuses
non-loopback binds without auth configured (family-mode Phase 5 hard
rule). Either pair a device first (`stavr pair bootstrap`) or restore
the default bind.

### "Daemon comes back but loses my settings after restart"

The unit file captures env vars at install time. If you change
`STAVR_HOME` or another stavR env var, re-run the install script
(idempotent) so the unit picks up the new value, then reload the
service (per-platform; see the cross-platform comparison table above).

### "Crash-loop hits the burst limit"

- Linux: `systemctl --user reset-failed stavr.service` to clear the
  start-limit counter and let the service try again.
- macOS: no burst-cap (documented limitation). Investigate the crash
  via `~/Library/Logs/stavr/stderr.log`.
- Windows: WinSW halts the service after 3 escalating restarts. Start
  manually via `StavrDaemon.exe start` after fixing the root cause.

### "I want to revert to PM2"

`ecosystem.config.cjs` is intact — the deprecation banner doesn't
disable the config. Stop the OS-native service first
(per-platform), then `pm2 start ecosystem.config.cjs`.

---

## Related

- [`proposed/os-native-governor-bom.md`](../proposed/os-native-governor-bom.md) — the BOM that drove this work.
- [`proposed/os-native-governor-recon.md`](../proposed/os-native-governor-recon.md) — the Phase 0 recon that pinned the daemon's start command, env vars, log destinations, and crash-loop budgets.
- [`docs/governor.md`](./governor.md) — the Tauri Tray Governor (operator-facing companion, separate from the OS-init supervisor described here).
- [`docs/host-resource-ceiling.md`](./host-resource-ceiling.md) — the OS-level memory + concurrency caps that prevent the overload this BOM does NOT prevent.
- [ADR-020 — Standalone daemon watchdog](../adr/020-daemon-watchdog.md) — the `/healthz`-polling watchdog (separate from the OS-init supervisor; complementary, with the deferred follow-up flagged above).
- [ADR-033 — stavR tray companion](../adr/033-stavr-tray-companion.md) — design of the Tauri Tray Governor.
