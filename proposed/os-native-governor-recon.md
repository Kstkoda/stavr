# Recon: OS-Native Governor — pre-implementation findings

**Status:** Phase 0 output. Phase 1 (Linux systemd) follows in the same branch.
**Branch:** `feat/os-native-governor` (off `origin/main` @ `20e1439` — includes the family-mode-phase-1 merge).
**Sensitivity:** `careful` — service definitions + install scripts; CC does not register services itself.

This document pins the facts the rest of the BOM depends on so each per-platform Phase doesn't have to re-derive them. Where a decision is needed beyond what the BOM specified, it's flagged at the bottom for the operator to resolve.

---

## 1. The daemon's canonical start command

**CLI entry:** `stavr daemon start` →
[`src/daemon.ts:722`](../src/daemon.ts) (`startDaemon(opts)`).

```ts
export async function startDaemon(opts: DaemonOptions): Promise<{ pid: number; detached: boolean }> {
  if (opts.detach) return spawnDetachedDaemon(opts);
  await startDaemonForeground(opts);
  await new Promise(() => {}); // blocks until SIGINT/SIGTERM
  return { pid: process.pid, detached: false }; // unreachable
}
```

For an OS-native service supervisor, the **foreground** mode is what's wanted — the supervisor needs a process to watch. The `--detach` flag forks a detached child and exits the parent immediately, which would defeat the supervisor's "is the process alive?" check.

**Canonical service exec line:**
```
node dist/cli.js daemon start --port 7777 --db <STAVR_HOME>/runestone.db
```

Optional supplementary flags (already supported by the CLI):
- `--bind-host <host>` — default `127.0.0.1` (ADR-006; family-mode Phase 5 preserved the default).
- `--allow-non-local-without-auth` — documented escape hatch; should not be the default in any installed service.
- `--log-format json` — recommended for service mode so journald/launchd/WinSW capture structured logs.

`--force` and `--detach` are **not** appropriate in service mode — the supervisor owns the process lifecycle.

## 2. Working directory + node args

From [`ecosystem.config.cjs:36`](../ecosystem.config.cjs) (the PM2 config being retired):

| Setting | Current PM2 value | Carries over to OS service |
|---|---|---|
| `cwd` | `__dirname` (project root) | yes — the project root, so `dist/cli.js` resolves relative to it |
| Node args | `--max-old-space-size=8192 --heapsnapshot-near-heap-limit=2 --report-on-fatalerror --report-directory=./tmp/diag-reports` | yes — same heap ceiling + diagnostics on fatal-error apply to OS-supervised mode |
| `STAVR_DEBUG_ENABLED` | `"1"` | yes (per current PM2 default; comment in ecosystem.config.cjs:38-40 calls this "personal-machine + loopback-only safe") |

## 3. Env vars + paths the daemon expects at runtime

Grep across `src/`:

| Env var | Purpose | Default | Where read |
|---|---|---|---|
| `STAVR_HOME` | All persisted state location | `~/.stavr` | [`src/devices-storage.ts:18`](../src/devices-storage.ts), [`src/config.ts:80`](../src/config.ts), [`src/daemon.ts:115`](../src/daemon.ts) |
| (DB path via `--db`) | SQLite path | `<STAVR_HOME>/runestone.db` | [`src/paths.ts:4`](../src/paths.ts) |
| (Port via `--port`) | HTTP/SSE listen port | `7777` | CLI defaults |
| `STAVR_DEBUG_ENABLED` | Gate diagnostic endpoints | unset | `transports.ts` |
| `STAVR_VERSION` | Version override (status reporting) | package.json | `transports.ts` |
| `STAVR_LOG_LEVEL`, `STAVR_LOG_PRETTY` | pino config | `info` / off | `observability/logger.ts` |
| `STAVR_PEER_ID` | Federation peer id (mDNS) | `'stavr-self'` (collision risk on LAN — family-mode Phase 5 §5.d flagged) | `federation/index.ts` |
| `STAVR_WEBAUTHN_RP_ID`, `STAVR_WEBAUTHN_RP_NAME`, `STAVR_WEBAUTHN_ORIGINS` | WebAuthn RP config | `localhost` family | `security/webauthn.ts` |
| `STAVR_NOTIFY_SECRET` | Notify HMAC sigil | unset → notify off | `notify/wiring.ts` |
| `STAVR_OTEL_EXPORTER_OTLP_ENDPOINT` | OTel exporter | unset → no-op | `observability/otel.ts` |
| `STAVR_RSS_WATCHDOG_MB` | RSS-watchdog ceiling | 4000 | `transports.ts` |
| `HOME` (POSIX) / `USERPROFILE` (Windows) | Used to resolve default `STAVR_HOME` | — | `node:os` `homedir()` |
| `PATH` | Subprocess lookup (`git`, `gh`, `node` for workers, `claude` for steward) | inherited | various adapters |

**For a service unit:**

- `WorkingDirectory` / `cwd` = the stavR install dir (where `dist/` lives).
- `Environment=HOME=<operator's home>` (systemd) so `homedir()` resolves correctly — systemd doesn't inherit `HOME` by default for `User=` services.
- The systemd user instance (`--user`) inherits `HOME` cleanly. ADR-020's existing watchdog uses user-systemd; the daemon supervisor will do the same.
- `Environment=PATH=...` — explicit PATH including `/usr/local/bin` (Homebrew on macOS), `/opt/homebrew/bin` (Apple Silicon Homebrew), the operator's `~/.npm/bin` if used. Each platform script will compose this.
- macOS launchd inherits very little env by default — the plist must set `PATH` and `HOME` via `EnvironmentVariables`.
- Windows Services run as `LocalSystem` by default — wrong for a per-user tool. Must run as the operator's account (`Local Account` or specific named user). WinSW exposes `<serviceaccount>` for this.

## 4. Log destinations

Current PM2 sinks:
- `./tmp/pm2-stavr.out.log` (stdout)
- `./tmp/pm2-stavr.err.log` (stderr)

For OS-supervised mode the natural platform sinks are:

| Platform | Stdout | Stderr | Operator query |
|---|---|---|---|
| Linux systemd | journald | journald | `journalctl --user -u stavr.service` |
| macOS launchd | `~/Library/Logs/stavr/stdout.log` | `~/Library/Logs/stavr/stderr.log` | `tail -F` directly |
| Windows Service via WinSW | `<install>/logs/stavr.out.log` (size-rotated) | `<install>/logs/stavr.err.log` | tail / Notepad / dashboard "View Logs" |

stavR's own pino sink (`observability/logger.ts`) writes structured JSON to **stderr** when `STAVR_LOG_PRETTY` is off (default). systemd/launchd/WinSW capture stderr correctly. For pino-pretty output during dev, the operator can set `STAVR_LOG_PRETTY=1` outside service mode.

## 5. The current PM2 setup (what's being retired)

[`ecosystem.config.cjs`](../ecosystem.config.cjs) defines **two** PM2 apps:

### 5.a `stavr` app — the daemon

```js
{
  name: 'stavr',
  script: 'dist/cli.js',
  args: ['daemon', 'start'],
  node_args: ['--max-old-space-size=8192', '--heapsnapshot-near-heap-limit=2',
              '--report-on-fatalerror', '--report-directory=./tmp/diag-reports'],
  cwd: __dirname,
  env: { STAVR_DEBUG_ENABLED: '1' },
  max_restarts: 5,
  min_uptime: 30000,
  restart_delay: 30000,
  exp_backoff_restart_delay: 5000,
  autorestart: true,
  kill_timeout: 10000,
  out_file: './tmp/pm2-stavr.out.log',
  error_file: './tmp/pm2-stavr.err.log',
  merge_logs: true,
  time: true,
  max_memory_restart: '7000M',
}
```

The PM2 restart policy maps cleanly to:
- **systemd**: `Restart=on-failure`, `RestartSec=30s`, `StartLimitBurst=5`, `StartLimitIntervalSec=300s`, `MemoryHigh=7G`. Crash-loop guard via the burst limits — daemon that crashes 5 times in 5 minutes gets a `start-limit-hit` and stops being restarted; operator sees a clear signal.
- **launchd**: `KeepAlive`/`SuccessfulExit=false`, `ThrottleInterval=30` (10 minimum allowed; 30s matches PM2). launchd has no equivalent of `max_restarts` per window — it throttles per interval but will keep restarting indefinitely. Documented gap.
- **Windows Service (WinSW)**: `<onfailure action="restart" delay="30 sec"/>` × N + a final `<onfailure action="none"/>` to halt after the burst. WinSW supports escalating delays via multiple `<onfailure>` siblings.

### 5.b `stavr-steward-agent` app — Steward subprocess (ADR-032)

The second PM2 app runs `dist/steward-agent/main.js --daemon-url http://127.0.0.1:7777`. **The BOM does not address this directly.** Options for Phase 1–3:

1. **Add a sibling service** per platform (`stavr-steward.service`, `com.stavr.steward.plist`, `StavrSteward` Windows Service). Symmetrical with current PM2 setup; doubles the operator install steps.
2. **Roll the Steward into the daemon** — out of scope (would change ADR-032's subprocess decision).
3. **Document as a known gap**: Phase 4 drops PM2 entirely, so without per-Phase work the Steward subprocess is left unsupervised. Phase 5 docs would say "start manually via `node dist/steward-agent/main.js`" — not acceptable for a personal daemon.

**Flagged for operator decision** (§ Open questions below). My working assumption for Phases 1–3 is **Option 1** (sibling service per platform) because that preserves the ADR-032 subprocess architecture and matches the current PM2 dual-app pattern. Phase 4 (PM2 drop) is where this becomes load-bearing.

## 6. Existing supervision/install code in the tree

To avoid colliding with or duplicating prior work:

| File | Purpose | Phase 1–5 interaction |
|---|---|---|
| `src/watchdog.ts` (ADR-020) | Standalone watchdog that pings `/healthz` and restarts the daemon on hang | **Stays as-is.** ADR-020 explicitly chose a separate-process watchdog over OS-supervisor-only because OS supervisors can't detect a *hung* daemon (one that's alive but no longer serving). This BOM adds OS supervision OF THE DAEMON; ADR-020's watchdog adds deeper liveness via `/healthz`. They are complementary, not overlapping. **No change in Phases 1–3.** Phase 4 needs to verify the watchdog doesn't `pm2 start` anywhere — recon says it calls `stavr daemon start --detach`, which is fine for now but conflicts with the OS supervisor model (the OS supervisor wants the foreground; the watchdog's `--detach` spawns a child the supervisor will see as orphan). **Flagged as a follow-up** — not blocker for Phases 1–3. |
| `bin/stavr-jobobject.ps1` | Windows Job Object wrapper for memory ceiling (host-resource-ceiling Phase 4, not this BOM) | Unrelated — it's a hard-cap helper, not a supervisor. Leave alone. |
| `governor/` (Tauri 2 tray app, ADR-033) | Tray companion that detects daemon health + calls `pm2 start ecosystem.config.cjs` on restart | **Phase 4 concern:** the Governor currently shells out to `pm2`. After PM2 retirement, it needs to shell out to `systemctl --user restart stavr.service` / `launchctl kickstart -k gui/<uid>/com.stavr.daemon` / `sc stop && sc start` (or call the per-platform install script's `restart` action). Out of scope for Phase 1–3; explicitly Phase 4 work per the BOM. |
| `governor/installers/stavr-governor-install.ps1` | Installer for the Tauri tray app on Windows | Different concern — installs the TRAY app's autostart entry, not the daemon supervisor. Leave alone. |
| `ecosystem.config.cjs` | The retired PM2 config | Phase 4: deprecate (rename to `ecosystem.config.cjs.deprecated` or move to `deprecated/`) + document in install guide. |
| Docs that mention `pm2 …` | `README.md`, `docs/governor.md`, `docs/worker-spawn.md`, `docs/notifications.md`, `docs/host-resource-ceiling.md`, `CLAUDE.md §10` | Phase 4 + 5: update prose. Inline `pm2 restart stavr` → platform-specific service commands. Cross-platform install guide replaces the PM2 install section in README. |

## 7. Per-platform target choices (locked here so each Phase implements them)

### Linux (Phase 1)
- **systemd user instance** (`~/.config/systemd/user/stavr.service` — matches ADR-020's watchdog pattern).
  - Pros: no root needed; per-user state lives in `$HOME`; existing watchdog is also user-systemd.
  - Cons: stops at logout unless `loginctl enable-linger <user>`. Documented gap in install guide.
- **Unit kind:** `Type=simple` (the daemon doesn't fork).
- **Restart policy:** `Restart=on-failure`, `RestartSec=30s`, `StartLimitBurst=5`, `StartLimitIntervalSec=300s` (5 crashes in 5 min → start-limit hit).
- **Logging:** journald default.
- **Memory ceiling:** `MemoryHigh=7G` (PM2 surrogate); hard `MemoryMax=8G` for cgroup-v2 enforcement on systems with delegation (host-resource-ceiling concern, mentioned here for completeness, applied if delegation is detected).
- **Install script:** `bin/install-systemd.sh` (writes the unit + prints `systemctl --user daemon-reload && systemctl --user enable --now stavr.service` for the operator).

### macOS (Phase 2)
- **LaunchAgent** (`~/Library/LaunchAgents/com.stavr.daemon.plist`, loaded via `launchctl load -w`).
  - LaunchDaemon (system-wide, /Library/LaunchDaemons) is wrong for a per-user tool.
- **`KeepAlive`** = `<dict><key>SuccessfulExit</key><false/></dict>` (restart only on non-zero exit).
- **`ThrottleInterval`** = 30 seconds.
- **`RunAtLoad`** = `true` (boot-start).
- **`StandardOutPath`** / **`StandardErrorPath`** = `~/Library/Logs/stavr/stdout.log` / `stderr.log`.
- **`EnvironmentVariables`** dict for PATH + HOME + the stavR-specific vars from §3.
- **`ProgramArguments`** = `["/usr/local/bin/node", "<install>/dist/cli.js", "daemon", "start", "--port", "7777"]` (node path resolved at install time).
- **Install script:** `bin/install-launchd.sh` (writes the plist + prints `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.stavr.daemon.plist` for the operator).

### Windows (Phase 3)
- **Windows Service via WinSW** (`bin/winsw/StavrDaemon.exe` + `StavrDaemon.xml`).
  - WinSW is a single .NET exe (~2MB) that turns any executable into a Windows Service. Plain XML config — no PowerShell complexity.
  - Bundled approach: vendor the latest WinSW release binary into `bin/winsw/` (decision below — bundle vs. download-at-install).
  - **Drops the broken `pm2-windows-startup` approach** per the BOM.
- **Service properties:**
  - `<startmode>Automatic</startmode>` (boot-start).
  - `<onfailure action="restart" delay="30 sec"/>` × 3 + `<onfailure action="none"/>` (escalating delays via the delay attribute on consecutive failures, then halt).
  - `<resetfailure>1 hour</resetfailure>` (resets the failure counter after 1 hour of healthy uptime — equivalent to PM2's `min_uptime` reset).
  - `<serviceaccount>` set to the operator's account so the daemon runs as the operator, not LocalSystem.
  - `<log mode="roll-by-size">` — WinSW's built-in size-rotated logger to `<install>/logs/`.
- **Install script:** `bin/install-windows-service.ps1` (places the WinSW exe + the XML, then prints `StavrDaemon.exe install && StavrDaemon.exe start` for the operator).

## 8. Crash-loop guard summary (per the BOM's mandatory requirement)

| Platform | Burst | Window | After burst |
|---|---|---|---|
| systemd | `StartLimitBurst=5` | `StartLimitIntervalSec=300` (5 min) | Unit enters `failed` state; operator runs `systemctl --user reset-failed stavr.service` to retry |
| launchd | `ThrottleInterval=30` (per-restart throttle, no burst limit) | n/a | launchd will keep restarting indefinitely at 30s interval — documented gap; operator can `launchctl bootout` if needed |
| Windows Service (WinSW) | 3 onfailure entries with escalating `delay` (30s / 1m / 5m) | `<resetfailure>1 hour</resetfailure>` | After 3 restarts within an hour without an hour of healthy uptime: `<onfailure action="none"/>` — service stays stopped, operator sees it in `services.msc` |

launchd's lack of burst-cap is an OS limitation, not a BOM scope item — recorded here so the docs in Phase 5 explain the per-platform delta honestly.

## 9. Open questions (operator decision before Phase 1 work starts on them)

These are not blockers for Phase 1 (Linux systemd) but become load-bearing in Phases 3–4. Surfacing here so they don't sneak in:

**Q1. Steward agent subprocess (`stavr-steward-agent`).** Phases 1–3 add a sibling service per platform under the same crash-loop policy; Phase 4 drops PM2 entirely. Is the working assumption — sibling OS services for the Steward agent — correct, or do you want it deferred? My recommendation: **sibling services**, matching the current PM2 pattern; one extra unit file per platform, same crash-loop policy as the daemon's.

**Q2. WinSW: bundle vs. download.** Bundle the WinSW binary in `bin/winsw/` (operator gets it via `git clone`) or have the install script download a pinned WinSW release + verify a SHA256? My recommendation: **bundle**, with the SHA256 of the bundled binary recorded in `bin/winsw/WINSW_VERSION.md`. Operators on offline networks need install-without-internet; supply-chain integrity stays explicit.

**Q3. ADR-020 watchdog interaction.** The standalone watchdog calls `stavr daemon start --detach` on hang detection. Post-Phase-1 (Linux), the OS supervisor expects to own the daemon — a `--detach` from outside spawns an orphan the supervisor sees as the daemon-having-died, races. Three options:
  - (a) Watchdog calls `systemctl --user restart stavr.service` instead of `stavr daemon start --detach` (Phase 1 follow-up; same per-platform branching as the supervisor itself).
  - (b) Retire the watchdog entirely (loses the `/healthz` hang detection that prompted ADR-020).
  - (c) Document the conflict and defer (Phase 6 follow-up BOM).
  My recommendation: **(a)**, folded into Phases 1–3 incrementally. Each per-platform Phase replaces the watchdog's restart call with the corresponding service-control command.

**Q4. CLAUDE.md §10 PM2 guidance.** The project-instructions file has PM2-specific operator guidance. Phase 4 should rewrite that section. Pure-prose change, but it's a CLAUDE.md edit and worth flagging because it affects every future Claude Code session in the repo.

---

## Phase 1 entrypoint

Phase 1 (Linux systemd) implements per §7-Linux:
- `bin/install-systemd.sh` — writes `~/.config/systemd/user/stavr.service`, prints next-step operator commands.
- `bin/uninstall-systemd.sh` — symmetric.
- `bin/stavr.service.template` — the unit file template (envsubst-style placeholders for `EXEC`, `WORKING_DIR`, `MEMORY_HIGH`).
- The install script does NOT call `systemctl` itself — it writes the file and prints `systemctl --user daemon-reload && systemctl --user enable --now stavr.service` for the operator to run.

Operator review of this recon doc, then Phase 1 proceeds in the same branch.
