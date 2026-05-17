# stavR · v0.6.5 — Governor MVP (Tauri 2 tray companion + auto-restart + OS toast)

> Foundation PR. Builds Governor v1.0 as defined in ADR-040 — the third party in the three-process architecture. Operator-facing tray application that supervises stavR (auto-restart on crash), subscribes to the daemon's event bus, renders OS-level toast notifications, and provides the operator's escape hatch when stavR is misbehaving. Replaces the operator's need to manually `pm2 start` after every crash.

**Why this is the v0.6 series cornerstone**: stavR has had multiple "didn't start" incidents in a single day (PM2 corruption, post-freeze restart needed, env-var divergence). Every other planned feature (v0.6.6 worker fidelity, v0.6.7 spawn hygiene, v0.6.8 engine room, v0.6.9 tool catalog) assumes a daemon that's ACTUALLY RUNNING. The Governor is what makes that reliable.

**Architecture per ADR-040**: Engine ↔ Governor via HTTP loopback (dashboard reads) + IPC socket (event subscription + control). Initial MVP uses HTTP polling + SSE subscription only — defers full IPC socket to v0.6.5.1 if needed.

**Estimated wall-clock**: 8–12 hours CC sequential across 2 PRs (one for core + one for OS integration polish).

**Sensitivity**: `high` per CLAUDE.md section 9. Touches process supervision, OS-level UI integration, autostart configuration. Operator approval gate between PRs.

**Stop conditions**: end of any phase if the Governor process itself becomes unstable (>3 crashes in 1h during dev test), the auto-restart cascade hits infinite loop (Governor restarts daemon, daemon crashes, Governor restarts again with no backoff — bad), or any acceptance test demonstrates Governor can be killed by stavR daemon (the supervision relationship must be one-way).

**Do NOT pause for approval** between phases within a PR.

---

## Why this matters

Today's reality (2026-05-17 session):
1. **PC freeze** at ~14:15 GST took the daemon down. Operator manually restarted via PowerShell.
2. **PM2 dump.pm2 corruption** hit twice earlier in the day. Each time required operator PowerShell intervention.
3. **Env var divergence** across PowerShell windows caused the notify fabric to init without secrets — operator had to figure out the User-level vs session-level distinction.
4. **No OS-level signal** of daemon health. Operator only knows stavR is down when the dashboard fails to load.

The Governor fixes all four:
- Detects daemon crash within 5s, auto-restarts with exponential backoff
- Surfaces OS-toast on state changes ("stavR daemon crashed · restarting" / "stavR daemon back up after 3s")
- Tray icon color shows current state at a glance (green/yellow/red/gray)
- Provides a single source of truth for "is stavR alive right now" that survives PM2 / env-var / OS issues
- Operator sees the tray icon BEFORE opening the dashboard — instant operational signal

**Lex Insculpta posture**: Governor strengthens the "I shall not act unseen" promise by ensuring the operator's PRIMARY operational signal (tray icon + OS toast) doesn't require the dashboard or browser to be open. Daemon emit → Engine broker → Governor subscribes → OS toast. The operator's awareness becomes ambient, not pull-based.

---

## Reference reading

1. `CLAUDE.md` — invariants
2. `adr/033-stavr-tray-companion.md` — original tray sketch (Governor MVP IS this ADR's implementation)
3. `adr/040-three-process-architecture.md` — Engine ↔ Governor IPC contract + killswitch design
4. `adr/041-universal-signal-trace.md` — event taxonomy + privacy boundary (Governor follows same rules)
5. `proposed/v0_6_5-notify-wire-up-bom.md` — `notification_requested` event kind that Governor will subscribe to (lands first if not already merged)
6. `ecosystem.config.cjs` — current PM2 config (Governor wraps PM2 in MVP; replaces in v1.1+)

---

## Don't touch

- The Engine daemon itself (`src/*` except for one tiny export in P3 to expose a new HTTP endpoint)
- PM2 ecosystem config (Governor uses PM2 as the underlying process supervisor in MVP; full replacement is v1.1+)
- Existing dashboard pages — Governor is a NEW companion, doesn't change web UI
- Trust scope / notification fabric / worker code — Governor is a SUBSCRIBER, not a publisher
- The `~/.stavr/keys/` directory — Governor reads operator pubkey for identity display only; doesn't write
- `package.json` runtime deps — Governor is a separate Rust binary, doesn't ship with the npm package

---

## Hard rules

1. **Tests are derivative** — no existing tests should break (Governor is purely additive; doesn't change Engine surface)
2. **Never lose files** — `stat -c %s` + `tail -5` for any file >15KB
3. **Status-check before every git op** (CLAUDE.md §8)
4. **Governor MUST NOT be killable by the Engine** — the supervision relationship is one-way. Engine crash should not take Governor down. (Verified via test: kill -9 the daemon, Governor stays alive and reports the death.)
5. **Auto-restart MUST have exponential backoff** — 1s, 2s, 4s, 8s, 16s, 32s, then 60s cap. After 5 failed restarts in 5 minutes, Governor stops auto-restarting and shows red tray + "stavR keeps crashing — operator intervention required" toast.
6. **Restart MUST use existing PM2** (in MVP) — `pm2 start ecosystem.config.cjs` shell-out. Replacement of PM2 is v1.1+.
7. **OS toast MUST be debounced** — no more than 1 toast per 10s for the same event kind. Operator should never get a notification storm.
8. **Privacy boundary** (ADR 041) — Governor subscribes to events but respects "our universe" only. Never logs or displays federated peer internals.
9. **The tray icon MUST use the Raido rune (ᚱ, U+16B1)** as the operator-recognizable brand mark, per stavR's iron-palette visual identity
10. **DCO -s, per-phase commits, push at end of each phase. 2 PRs.**

---

## Phase-group structure (2 PRs)

| PR | Phases | Scope | Wall-clock |
|---|---|---|---|
| #1 — Core | P0, P1, P2, P3 | Tauri scaffolding + rune tray icon + health polling + auto-restart + state-driven icon color | 5–7h |
| #2 — OS integration | P4, P5, P6 | SSE event subscription + OS toast rendering + tray menu actions + cross-platform packaging + docs | 3–5h |

PR #1 alone gives the operator the supervision win. PR #2 adds the notification layer + operator interaction surface.

---

## P0 · Pre-flight (Kenneth, before CC kicks off)

~10 min:
1. Confirm Rust toolchain installed (`rustup --version`); if not: `winget install Rustlang.Rustup` (Windows) / `brew install rustup` (macOS) / `curl https://sh.rustup.rs -sSf | sh` (Linux)
2. Install Tauri CLI: `cargo install tauri-cli --version "^2.0"`
3. Confirm WebView2 runtime installed on Windows (`reg query "HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\ClientState\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"`); usually pre-installed on Win10+
4. `git status` clean on `main`; verify v0.5 Steward portability + v0.6 notifications PRs already merged
5. `npm test --run` baseline = current passing
6. Decide: tray-only MVP vs window-on-click? Default: tray-only (right-click for menu, left-click to open dashboard in browser). Document in P0.
7. Dispatch CC with PR #1 brief

---

## P1 · Tauri scaffolding + rune tray icon (PR #1, 2.5–3h)

**Files**:
- `governor/` (new top-level directory) — Rust workspace
- `governor/Cargo.toml`
- `governor/tauri.conf.json`
- `governor/src/main.rs`
- `governor/src/tray.rs`
- `governor/icons/raido-16.png`, `raido-32.png`, `raido-128.png`, `raido-icon.ico`, `raido-icon.icns`
- `governor/icons/raido-base.svg` — source SVG of the Raido rune (U+16B1) styled per iron palette
- `.github/workflows/governor-build.yml` — cross-platform build matrix

### Tauri 2 setup

```bash
cd governor
cargo tauri init  # or use the project structure directly
```

Initial `tauri.conf.json`:
- `productName`: "stavR Governor"
- `version`: "0.6.5"
- `identifier`: "tech.stavr.governor"
- `app.windows`: `[]` (tray-only; no main window in MVP)
- `bundle.icon`: array pointing to multi-size raido icons
- `app.trayIcon`: `{ id: "main", iconPath: "icons/raido-32.png", iconAsTemplate: false }`

### Rune icon

The Raido rune ᚱ (U+16B1) rendered as the operator-recognizable brand. Source SVG:
- Glyph: ᚱ in `Noto Sans Runic` or vectorized version (no font dependency)
- Color: iron-palette rust orange (#fa9c4c) on transparent background
- 4 PNG sizes (16, 32, 64, 128) generated from SVG via build script or asset-prep script
- Windows `.ico` + macOS `.icns` generated from the 128px source

### Acceptance

- Governor builds and runs on Windows / macOS / Linux dev machines
- Tray icon visible after launch (Raido rune in chosen iron palette color)
- Process keeps running in background; quitting via tray-menu "Quit" cleanly exits
- Cargo build artifacts under 15MB per platform (Tauri 2 is small)
- 3+ Rust unit tests passing (icon-loading, config-parsing, basic startup)
- GitHub Actions workflow `governor-build.yml` produces artifacts for win-x86_64, win-aarch64, macos-x86_64, macos-aarch64, linux-x86_64

### Commit
`feat(governor): tauri 2 scaffolding + raido rune tray icon + cross-platform build`

---

## P2 · Health polling + state machine + auto-restart with backoff (PR #1, 1.5–2h)

**Files**:
- `governor/src/supervisor.rs` (new) — daemon supervision logic
- `governor/src/state.rs` (new) — Governor state machine
- `governor/src/restart.rs` (new) — PM2 invoker for restart
- `governor/tests/supervisor_test.rs`

### State machine

```rust
enum DaemonState {
    Unknown,           // before first health check
    Healthy,           // /healthz returns 200, last check < 10s ago
    Degraded,          // /healthz returns non-200 OR last check 10-30s ago
    Down,              // last check > 30s ago, or connection refused
    Restarting,        // restart in progress (PM2 start command running)
    StoppedManually,   // operator explicitly paused via tray menu
    GiveUp,            // >5 failed restarts in 5min; needs human
}
```

### Health polling

- HTTP GET `http://127.0.0.1:7777/healthz` every 5s
- Connection timeout: 2s
- Response timeout: 1s
- 3 consecutive failures → transition to `Down`
- Successful response → transition to `Healthy`

### Restart with exponential backoff

When state becomes `Down`:
- Wait 1s, attempt `pm2 start ecosystem.config.cjs` via subprocess
- If still Down after 10s: wait 2s, retry
- Then 4s, 8s, 16s, 32s, 60s cap
- After 5 retries in 5min window: `GiveUp` state, no more auto-restart, red tray, toast: "stavR keeps crashing — operator action required"
- Operator can reset via tray menu "Reset & Restart"

### Acceptance

- Kill daemon manually (`pm2 stop stavr`), confirm Governor detects within 15s
- Governor calls `pm2 start ecosystem.config.cjs`, daemon comes back, state returns to `Healthy`
- Repeated kills + restarts demonstrate backoff timing (1s, 2s, 4s, 8s, 16s)
- After 5 failed restarts, Governor enters `GiveUp` and stops auto-restarting
- Governor process itself stays alive throughout daemon kill cycles
- 6+ Rust tests passing (mocked PM2 subprocess + mocked health endpoint)

### Commit
`feat(governor): health polling + state machine + auto-restart with exponential backoff`

---

## P3 · State-driven tray icon color + status display (PR #1, 1.5–2h)

**Files**:
- `governor/src/tray.rs` — extend with state-driven icon swapping
- `governor/icons/raido-{green,yellow,red,gray,orange-pulse}-{16,32}.png` — color variants
- `governor/src/main.rs` — wire state → tray icon

### Icon color states (iron palette)

| State | Icon variant | Color |
|---|---|---|
| Unknown / Restarting | pulse (animated) | iron orange (#fa9c4c) blink |
| Healthy | solid green halo | iron green (#5fd987) |
| Degraded | solid yellow halo | iron amber (#ffd95a) |
| Down | solid red halo | iron red (#ff7a7a) |
| StoppedManually | solid gray halo | iron neutral (#8a8a8a) |
| GiveUp | solid red + pulsing | iron red + alert pattern |

### Tray tooltip

Hovering the icon shows: `stavR · {state} · uptime {duration} · last check {N}s ago`

### Acceptance

- Tray icon color reflects state within 1s of state change
- Tooltip shows current state + uptime + last-check timestamp
- Animated states (Restarting, GiveUp) loop smoothly without CPU spike
- 4+ tests passing

### Commit
`feat(governor): state-driven tray icon color + tooltip with uptime`

### Open PR #1

`feat(governor): MVP — tauri 2 tray + auto-restart + state-driven icon (closes v0.6.5 PR #1)`

Body must include:
- Screenshot of tray icon in all 5 states
- 2-minute video / GIF of kill-and-recover demo
- Build artifact links per platform
- ADR 033 + ADR 040 reference

---

## P4 · SSE event subscription + OS toast (PR #2, 2h)

**Files**:
- `governor/src/event-bridge.rs` (new) — SSE client to `/dashboard/stream`
- `governor/src/notification.rs` (new) — OS toast renderer via `tauri-plugin-notification`
- `governor/src/event-router.rs` — maps subscribed event kinds to toast templates
- `governor/tests/event-bridge_test.rs`

### Subscribed event kinds

Per ADR 041, Governor subscribes to events relevant to operator awareness:
- `notification_requested` (per v0.6.5 wire-up BOM) — explicit operator alert from any party
- `daemon_health_changed` (new event kind to add in v0.6.5 BOM addendum if not present) — internal daemon state transitions
- `worker_failed` / `worker_blocked_by_av` — high-severity worker outcomes
- `scope_expired` (operator should know their scope just expired)
- `decision_required` — open decision in queue (also shows on dashboard)

NOT subscribed (too noisy):
- `progress`, `tool_called`, `event_received`, generic worker_progress
- Aggregate metric events (those belong in dashboard, not OS toast)

### Toast rendering

Per-platform native:
- Windows: WinRT ToastNotification via `tauri-plugin-notification`
- macOS: UNUserNotificationCenter
- Linux: libnotify (D-Bus)

### Toast template

Title: short event-kind label (e.g., "stavR · operator needed")
Body: event payload's title field + first line of body, truncated to 120 chars
Severity → priority mapping:
- info → default priority
- warn → high priority
- crit → critical (sound + persistent on macOS)

Click action: opens `http://127.0.0.1:7777/dashboard/decide` in default browser

### Debouncing

Per Hard rule #7: no more than 1 toast per 10s for the same event kind. Counter in `event-router.rs`. Suppressed events are logged (operator can still see them on dashboard /streams page).

### Acceptance

- SSE connects to `/dashboard/stream` on launch
- Manual `emit_event` of `notification_requested` produces OS toast within 2s
- Toast click opens browser to dashboard
- Debouncing test: emit 5 `worker_failed` events in 1s → only 1 toast renders
- 5+ tests passing (mocked SSE + mocked OS notification)

### Commit
`feat(governor): SSE event subscription + OS toast with debouncing`

---

## P5 · Tray menu + operator actions (PR #2, 1–1.5h)

**Files**:
- `governor/src/tray-menu.rs` (new) — menu items + handlers
- `governor/src/actions.rs` — operator action implementations

### Tray menu (right-click)

```
┌────────────────────────────────────┐
│ stavR · Healthy · 12m uptime       │
├────────────────────────────────────┤
│ Open Dashboard                      │  → opens 127.0.0.1:7777/dashboard/helm
│ View Logs                           │  → opens tmp/pm2-stavr.out.log in $EDITOR
│ View Decide Queue                   │  → opens /dashboard/decide
├────────────────────────────────────┤
│ Pause Daemon                        │  → pm2 stop stavr (state → StoppedManually)
│ Restart Daemon                      │  → pm2 restart stavr
│ Reset & Restart (clear GiveUp)      │  → clears retry counter + restart
├────────────────────────────────────┤
│ Disable Auto-restart                │  → toggle; persists in governor config
│ Mute Notifications (1h / 1d)        │  → submenu
├────────────────────────────────────┤
│ About stavR Governor                │  → shows version + operator pubkey fingerprint
│ Quit Governor                       │  → graceful shutdown (does NOT stop daemon)
└────────────────────────────────────┘
```

### Acceptance

- All menu items work as labeled
- "Pause Daemon" stops PM2; tray turns gray; manual "Restart Daemon" brings it back
- "Reset & Restart" clears the GiveUp counter
- "Quit Governor" cleanly exits Governor WITHOUT stopping the daemon (operator can run daemon without Governor if they choose)
- 4+ tests passing

### Commit
`feat(governor): tray menu with operator actions (pause/restart/mute)`

---

## P6 · Auto-launch + docs + cross-platform install (PR #2, 1–1.5h)

**Files**:
- `governor/installers/stavr-governor-install.ps1` (Windows)
- `governor/installers/stavr-governor-install.sh` (macOS / Linux)
- `docs/governor.md` (new) — operator setup + troubleshooting
- `docs/governor-icon-design.md` — explains the rune choice for branding
- `CHANGELOG.md` — v0.6.5 entry

### Auto-launch at user login

- Windows: registry key under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
- macOS: LaunchAgent in `~/Library/LaunchAgents/tech.stavr.governor.plist`
- Linux: systemd-user unit in `~/.config/systemd/user/stavr-governor.service`

Operator can opt-out via tray menu "Disable autostart" — defers to manual launch.

### Operator setup docs

- "Why a tray companion" (one paragraph)
- Install per platform (one section each)
- First-launch checklist (verify rune icon, hover for tooltip, confirm color)
- Auto-restart explanation (5-attempt backoff, GiveUp state)
- Troubleshooting (icon not appearing, PM2 not found, daemon won't start despite restart attempts)
- How to uninstall

### Acceptance

- Operator can install via single command per platform
- Auto-launch survives reboot
- Docs cover the 5 most likely failure modes
- CHANGELOG entry comprehensive

### Commit
`docs(governor): operator setup + autostart per platform`

### Open PR #2

`feat(governor): SSE events + OS toast + tray menu + autostart + docs (closes v0.6.5)`

---

## Budget

- **Time**: 8–12h CC across 2 PRs
- **API cost**: ~$10–18 (Rust is verbose; lots of code generation)
- **LOC change**: ~1,800–2,500 net (mostly new Rust files in `governor/`)
- **Token cap**: 1.5M (split across 2 PRs)
- **New deps**: Tauri 2 crates (one-time pull); no npm dep changes
- **Build infra**: GitHub Actions cross-platform matrix builds (5 targets)
- **Schema change**: none

---

## Footgun appendix

1. **WebView2 prerequisite on Windows** — Tauri 2 needs WebView2 runtime. Pre-installed on Win10+ usually; older Windows needs install. Detect at P6 install script + offer to install.
2. **Tauri 2 vs Tauri 1 API differences** — make sure CC uses Tauri 2.x crates throughout (not mixing 1.x examples).
3. **Tray icon transparency on Windows** — Windows tray treats some PNG transparency poorly; test on multiple Windows versions + use `.ico` with proper alpha layers.
4. **Auto-restart cascade loop** — if daemon crashes immediately on start (config error), Governor restarts → daemon crashes → Governor restarts → infinite loop. The 5-retries-in-5-min `GiveUp` state prevents this. Test specifically.
5. **PM2 vs Governor ownership confusion** — PM2 still supervises in MVP; Governor calls `pm2 start`. If operator runs `pm2 stop` from PowerShell while Governor is paused, state can drift. Reconciliation: every minute, check actual PM2 status + reconcile Governor state.
6. **SSE connection lifecycle** — Governor maintains ONE long-lived SSE connection to `/dashboard/stream`. Reconnect with backoff on drop. Don't spam reconnects (avoids the 8-SSE-connections bug from v0.6.8 BOM investigation).
7. **OS toast quotas** — Windows enforces toast limits per app (10 visible max). macOS does the opposite (stacks indefinitely). Test both for edge cases.
8. **Operator pubkey fingerprint in "About" dialog** — useful identity display. Read from `~/.stavr/keys/operator.ed25519.pub` (or wherever ADR 036 puts it). Skip cleanly if key doesn't exist.
9. **Update path** — Governor MVP has no auto-update. Operator manually updates via reinstall. v1.1 adds Sigstore-verified auto-update (ADR 038). Document in P6 docs.
10. **The Raido rune (ᚱ U+16B1)** — operator brand mark. Don't recolor without operator consent. Iron palette rust orange (#fa9c4c) is the canonical color.

---

## Open questions (FLAGGED — do not pre-answer)

### §1 — Should Governor have a main window (clickable from tray "Open" → in-app window) OR always open external browser to dashboard?

Default: external browser only (MVP). In-app window adds complexity and operators usually have dashboard bookmarked anyway. v1.1+ candidate if requested.

### §2 — Should Governor disable itself when daemon is StoppedManually for >24h?

Default: NO — Governor stays alive showing gray icon so operator remembers to restart. Auto-disable could lose operator context.

### §3 — Should the rune icon use animated SVG or static PNG?

Default: static PNG per size (16/32/64/128). Tauri 2 tray icon API takes raster. Animation for "Restarting" / "GiveUp" via icon-swap loop (no SVG anim needed).

### §4 — Should Governor track operator activity (last-active timestamp) for the "Mute notifications" auto-detection?

Default: NO in MVP. Operator explicitly mutes via tray menu. Activity-based muting is v1.1+ candidate.

### §5 — Should Governor pre-publish a "Governor will be quitting" event before shutdown so dashboard can show it?

Default: YES. Emit `governor_quitting` event via HTTP POST to a small new endpoint on daemon before exit. 1-line addition.

---

## Run prompt for CC (PR #1, paste at start)

```
Read CLAUDE.md first. Then read proposed/v0_6_5-governor-mvp-bom.md and execute P0-P3 sequentially.

Sensitivity: HIGH. Operator approval gate between PR #1 and PR #2. Status-check before every mutating git op (CLAUDE.md §8).

Work on a NEW branch: `git checkout -b feat/v0.6.5-governor-mvp-pr1` from latest main. Never commit to main.

Rules:
- One commit per phase, DCO -s
- Don't pause for approval between phases inside this PR
- For any file >15KB after edit, `stat -c %s file` + `tail -5 file` BEFORE git add
- `npm test` must pass after every commit (no Engine-side changes expected, but verify)
- `cargo build --release` in `governor/` must succeed per platform target
- After P3 opens PR, output final delta report and STOP. Don't auto-merge. Don't proceed to PR #2.

The 2026-05-17 audit session (transcript + ~/.stavr/captures/bug.jsonl) is the operator's pain reference. Open questions §1-§5 flagged — pick conservative default.

The Raido rune (ᚱ U+16B1) is the brand mark — render it in iron palette rust orange (#fa9c4c) per CLAUDE.md visual conventions.

Go.
```

## Run prompt for CC (PR #2)

```
Read CLAUDE.md first. Then read proposed/v0_6_5-governor-mvp-bom.md.

PR #1 merged. Your scope: P4 (SSE + OS toast), P5 (tray menu), P6 (autostart + docs). Open PR at end of P6.

Same rules as PR #1. Sensitivity: HIGH. Go.
```

---

## End of brief
