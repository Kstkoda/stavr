# stavR Governor — operator guide

> **Architecture note (post-os-native-governor BOM):** the daemon's
> primary supervisor is now the OS init system on each platform
> (systemd / launchd / Windows Service via WinSW). See
> [`proposed/os-native-governor-bom.md`](../proposed/os-native-governor-bom.md)
> and the per-platform installers in `bin/`. The Tray Governor described
> in this document is now an OPERATOR-FACING COMPANION — its tray icon /
> tooltip / OS toasts surface daemon state from `/healthz` + the
> `/dashboard/stream` SSE feed.
>
> The Tray Governor's INTERNAL crash-recovery code still shells out to
> `pm2 start ecosystem.config.cjs` (the Rust binary at `governor/src/`
> is unchanged by the os-native-governor BOM — that cutover is tracked
> for a follow-up BOM that rebuilds the signed Tray Governor release).
> This means: on a fresh OS-native install, the Tray Governor's restart
> mechanism is non-functional (no PM2 present) but its observability
> features (state icon, toasts, dashboard launcher) work normally. The
> OS supervisor handles the actual restart.

> **The Governor is the third party in stavR's three-process architecture
> (ADR-040)**. Engine = the daemon. Supervisor = the OS init system (per
> the os-native-governor BOM; legacy installs still use PM2).
> Governor = the operator-facing tray companion that observes daemon
> health and surfaces operator-relevant events as native OS toasts.
>
> If you just want to *try* the daemon, you don't need the Governor at all.
> The dashboard is the canonical operator surface. The Governor is what
> makes the daemon's health visible *ambient* — tray icon color, hover
> tooltip, OS toast — so you can leave the dashboard tab closed and still
> know when something needs your attention.

## Why a tray companion

Before the Governor, the daemon's runtime story had three failure modes the
operator only noticed after the fact:

1. **PM2 doesn't auto-restart on every crash** — dump.pm2 corruption,
   "daemon already running" port-orphan, post-freeze restart. The Governor
   detects → auto-restarts within ~15 s.
2. **No OS-level signal of daemon health.** Operator only knew stavR was
   down when the dashboard failed to load. The Governor's tray icon turns
   amber → red on transitions, and the hover tooltip explains why.
3. **Decisions, host_exec denials, scope changes** lived only on the
   dashboard. Operator had to keep a browser tab open. The Governor pulls
   them out via SSE and renders OS toasts (debounced — no notification
   storms).

## What it does

| Surface | What you see |
|---|---|
| **Tray icon** | Raido rune (ᚱ) — green = Healthy, amber = Degraded, red = Down, gray = Paused, pulsing red = GiveUp (operator action needed) |
| **Hover tooltip** | `stavR · <state> · uptime <duration> · last check <N>s ago` (+ "needs operator action" when in GiveUp) |
| **OS toast** | Operator-awareness events: decision requests, host_exec denials, trust-scope lifecycle, worker crashes, etc. Debounced to ≤1 per 10 s per kind. |
| **Right-click menu** | Open Dashboard / View Logs / View Decide Queue / Restart Daemon / Pause / Mute notifications · 1 h / 1 d / Unmute / Quit Governor |

## Installation

### Step 1 — install a signed Governor binary

See [docs/governor-install.md](./governor-install.md) for the verified
release flow (`install-from-release.{ps1,sh}` — downloads, SHA256-checks,
Sigstore-verifies, stages the binary in `~/.stavr/governor/`).

If you're building locally for development, see
[docs/governor-local-dev.md](./governor-local-dev.md) instead — and skip
the next step (autostart from a debug build creates a noisy startup loop).

### Step 2 — enable autostart at user login

Optional but recommended. Run the installer for your platform:

#### Windows (PowerShell)

```powershell
cd C:\dev\cowire\governor\installers
.\stavr-governor-install.ps1
```

This writes `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\stavR Governor` →
`%USERPROFILE%\.stavr\governor\stavr-governor.exe`.

Flags:

- `-BinaryPath <path>` — if your binary is somewhere else
- `-DashboardBase <url>` — non-default port (default `http://127.0.0.1:7777`)
- `-LogPath <path>` — non-default log location for the "View Logs" tray
  menu item
- `-Uninstall` — remove the autostart entry (does NOT stop a running Governor)

#### macOS / Linux

```bash
cd ~/dev/cowire/governor/installers
chmod +x stavr-governor-install.sh
./stavr-governor-install.sh
```

- macOS: writes `~/Library/LaunchAgents/tech.stavr.governor.plist` and
  loads it via `launchctl`. Governor should be running immediately.
- Linux: writes `~/.config/systemd/user/stavr-governor.service`, enables
  + starts via `systemctl --user`.

Flags (same semantics as Windows):

- `--binary <path>`
- `--dashboard-base <url>`
- `--log-path <path>`
- `--uninstall`

**Linux only**: if you log in via a display manager that doesn't keep
your systemd-user session alive between sessions, enable lingering:

```bash
sudo loginctl enable-linger $USER
```

## First-launch checklist

1. Look for the Raido rune (ᚱ) in your system tray / menu bar.
   - Windows: bottom-right, near the clock (may be in the overflow ▲).
   - macOS: top-right, in the menu bar.
   - Linux: depends on your DE — KDE, GNOME with TopIcons, XFCE all have it.
2. Hover the icon. The tooltip should read `stavR · <state> · …`.
3. Right-click. You should see the menu shown in [What it does](#what-it-does).
4. Click "Open Dashboard". Your default browser should open
   `http://127.0.0.1:7777/dashboard/helm`.

## Auto-restart behavior

The state machine drives auto-restart with a 1s → 60s exponential backoff,
capped at 5 attempts within a 5-minute rolling window:

```text
Unknown → first health probe lands → Healthy   (most common path)

Healthy → probe fails 3× in a row → Down
       → wait 1 s, run `pm2 start ecosystem.config.cjs`
       → poll until Healthy or 10 s elapsed
       → if still Down: wait 2 s, retry (then 4, 8, 16, 32 — cap at 60)
       → 5 failed attempts inside any 5-min window → GiveUp
```

In `GiveUp`, the Governor stops auto-restarting and shows a pulsing red
icon plus the tooltip hint "needs operator action — right-click for Reset
& Restart". Click that menu item to clear the counter and try one more
time.

On Windows specifically, before each restart attempt the Governor probes
port 7777 (via `netstat -ano`) and kills any orphan Node process still
holding it — this is the `pm2 stop` → port-not-released failure mode from
the 2026-05-17 incident.

## Notifications (toasts)

The Governor maintains one long-lived Server-Sent-Events connection to the
daemon's `/dashboard/stream`. Per-kind debounce: no more than one toast
per 10 s for the same event kind. Suppressed events are NOT lost — they
still appear on `/dashboard/streams`.

Operator-awareness kinds that toast:

- `decision_request` / `decision_required` (Warn) — pending operator decision
- `host_exec_denied` (Crit) — shell action blocked by policy
- `trust_scope_proposed` / `_granted` / `_revoked` / `_completed`
- `worker_terminated` (filtered — routine `completed` is silent), `worker_failed`, `worker_blocked_by_av` (Crit) — legacy event names that still fire via dual-emit alongside the canonical `job_terminated` etc; see [event-taxonomy.md](./event-taxonomy.md) for the rename table
- `daemon_health_changed`, `scope_expired`, `cc_quota_warning`,
  `worker_dispatch_failed`, `notification_requested`

Routine kinds (progress, worker_progress / job_progress, file_written,
phase_started, command_run, tool_called) are silently dropped — they
belong on the dashboard, not in your OS notification center.

### Muting

Right-click the tray icon → choose a window:

- **Mute notifications · 1 h** — temporary quiet for a focus block
- **Mute notifications · 1 d** — quiet for the day
- **Unmute** — restore immediately

Mute windows extend (not shrink): if you click "1 h" then "1 d", you get
1 day, not 1 hour. Muting suppresses toasts only; the dashboard and the
daemon's `notify/*` fabric (Telegram, ntfy) are unaffected.

## Troubleshooting

### "I don't see the tray icon"

- **Windows**: check the overflow ▲ near the clock; drag the ᚱ icon out
  of the overflow into the always-visible tray for permanent display.
- **macOS**: the menu bar may be hiding it if you have many icons.
  Bartender users — make sure stavR Governor is in your visible list.
- **Linux**: on a fresh GNOME you need the `TopIcons Plus` or `AppIndicator
  and KStatusNotifierItem Support` extension. KDE has tray support built in.

### "Governor crashes on launch on Windows"

Almost always WebView2 missing. Install:

```powershell
winget install Microsoft.EdgeWebView2Runtime
```

Then re-launch.

### "The icon says Down but `curl http://127.0.0.1:7777/healthz` works"

Your daemon is listening but not on the default port the Governor probes.
Either:

- Restart the daemon on port 7777 (default), or
- Set `STAVR_HEALTH_URL=http://127.0.0.1:<your-port>/healthz` and
  `STAVR_DASHBOARD_BASE=http://127.0.0.1:<your-port>` in the user env,
  then re-run the autostart installer so the Run-key picks them up.

### "OS toast doesn't appear when I trigger a decision request"

- macOS: open System Settings → Notifications → stavR Governor → set
  "Allow Notifications" + style to Alerts. macOS asks once on first toast;
  if you missed that prompt, the system blocked future toasts.
- Windows: open Settings → System → Notifications. Make sure both global
  notifications and the "stavR Governor" app are on.
- Linux: requires libnotify + a notification daemon (`dunst`, `xfce4-notifyd`,
  GNOME / KDE built-ins). Test with `notify-send "test"` — if that doesn't
  show, fix it before debugging Governor.

### "PM2 says daemon is running but Governor says Down"

A real bug — the Governor's HTTP probe to `/healthz` is failing despite
PM2 reporting the process alive. Likely culprits:

- Daemon bound to a different port; see "Down but curl works" above.
- An orphan Node holding port 7777 from a previous crash. The Governor's
  Windows orphan-kill path handles this automatically on the next restart;
  on macOS/Linux check with `lsof -i :7777` and `kill -9` if needed.
- Daemon is alive but `/healthz` is unreachable (firewall, weird network
  config). Confirm with `curl -v http://127.0.0.1:7777/healthz` from the
  same user account that runs the Governor.

### "How do I uninstall completely?"

```powershell
# Windows
.\stavr-governor-install.ps1 -Uninstall
# Then quit the running Governor: right-click ᚱ → Quit Governor.
# Then optionally remove the binary:
Remove-Item -Recurse "$env:USERPROFILE\.stavr\governor"
```

```bash
# macOS / Linux
./stavr-governor-install.sh --uninstall
# Quit the running Governor from the tray menu.
# Optionally remove the binary:
rm -rf ~/.stavr/governor
```

## What the Governor does NOT do

- It does **not** replace the OS init supervisor introduced by the
  os-native-governor BOM. On OS-native installs (systemd / launchd /
  WinSW), the OS supervisor handles the actual restart with platform-
  native crash-loop guards (see `proposed/os-native-governor-bom.md`).
  The Tray Governor's auto-restart code (which historically shelled out
  to `pm2 start ecosystem.config.cjs`) is retained in the Rust binary
  for legacy PM2 installs during migration, and is tracked for
  replacement with per-platform service-control calls in a follow-up
  BOM. Replacement of PM2 as the underlying supervisor is complete in
  the daemon install path; the Tray Governor's internal restart logic
  follows separately.
- It does **not** auto-update. Updates ship via the signed-release
  pipeline (`docs/governor-install.md`); re-run `install-from-release.{ps1,sh}`
  then `stavr-governor-install.{ps1,sh}` to point at the new binary.
- It does **not** modify the daemon's data. The Governor reads `/healthz`
  and `/dashboard/stream`; it never writes daemon state. Quitting the
  Governor does NOT stop the daemon.

## Related reading

- [ADR-040 — three-process architecture](../adr/040-three-process-architecture.md)
- [ADR-033 — stavR tray companion](../adr/033-stavr-tray-companion.md)
- [ADR-041 — universal signal trace](../adr/041-universal-signal-trace.md) — event taxonomy + privacy boundary
- [docs/governor-icon-design.md](./governor-icon-design.md) — why the
  Raido rune
- [docs/governor-install.md](./governor-install.md) — signed-release
  install + verification flow
- [docs/governor-local-dev.md](./governor-local-dev.md) — building from source

