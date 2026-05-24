# BOM: stavR Governor — Polish (icon · About · heartbeat)

**Owner:** CC
**Sensitivity:** `careful` — Cluster C touches the **live daemon** (`src/` — a new HTTP route + the Diagnostics fetcher). Kenneth's daemon is in production (~90k events, serving 7777). Status check before/after every commit; report after each cluster. Clusters A/B/D are Governor-side / scripts only, but the BOM runs at one sensitivity.
**Verification window:** `targeted` — Governor: `cargo build --release` + `cargo test`. Daemon: `npm test` + `npm run build`. CC does NOT deploy to the live daemon — the operator restarts the `StavrDaemon` service onto the new build and runs the runtime smoke (Phase E).
**Branch:** `feat/governor-polish` off `main` (currently `c501304`).
**Base:** `main`.
**Estimated scope:** recon + 4 clusters + verify. One PR.

---

## Why this BOM exists

The observe-only refactor (PR #77, merged `c501304`) turned the Governor into a clean observer. Three things surfaced in operator smoke:

1. **The tray icon is wrong.** It is the original bare rune with a status-colour circle *overlapping* the glyph — it reads as messy at 16 px. Kenneth chose **concept 6** ("bare glyph") from `dock-icon-mockups.html`, with one override: **no circle** — status is shown by the colour of the rune itself.
2. **No way to see the version.** The Governor has no About surface; the operator cannot read which Governor version is running.
3. **The dashboard lies about the Governor.** The Diagnostics -> engine "Build & Versions" tile shows `GOVERNOR · v0.6.5 · NOT-RUNNING` even while the Governor is running. Diagnosis: `src/dashboard/data/build-versions.ts` reports `not-running` unless handed a `governorHeartbeat`. The `v0.6.5` is read straight off `governor/Cargo.toml` on disk. **Nothing ever produces a heartbeat** — no daemon route receives one, `diagnostics.ts` / `diagnostics-overview.ts` call `snapshotBuildVersions()` with no arguments, and the observe-only Governor only does GET `/healthz` + the SSE stream. The heartbeat path was scaffolded daemon-side and never wired. It will *always* read `not-running` until the loop is built end-to-end.

This BOM closes all three, plus folds in the two hardening items the PR #77 security review handed us.

---

## Phases / Clusters

### Phase 0 — Recon

Pin current state:
- Governor: `icons.rs`, `scripts/gen_icons.py`, `icons/raido-base.svg` + the `raido-*.png` set, `tray.rs` menu construction + menu-event dispatch, `main.rs` thread wiring, `Cargo.toml` / `tauri.conf.json` version + window config.
- Daemon: `src/dashboard/data/build-versions.ts`, the `snapshotBuildVersions()` call sites in `src/dashboard/pages/diagnostics.ts` (~line 1232) and `diagnostics-overview.ts` (~line 192), and **where the daemon's loopback HTTP routes are registered** (`/healthz`, `/status`) so the heartbeat route slots in beside them with the same bind/loopback posture.

One findings paragraph in the PR description. Proceed unless reality diverges materially from this BOM.

> **Pre-made fix already on the branch.** `feat/governor-polish` already carries an operator-verified commit `fix(governor): suppress console-window flash …` — `CREATE_NO_WINDOW` on the three Windows subprocess spawns in `service.rs` (`sc query` poll, restart, upgrade) + a `windows_subprocesses_suppress_console_window` anchor test. Do not revert it; build on it.

### Cluster A — New tray / app icon (concept 6, status-by-colour)

- **Redraw the rune.** Adopt the `dock-icon-mockups.html` `#rune` geometry — vertical stem + triangular bowl + diagonal leg, `stroke-width` ~11 on a 100-unit grid, round caps and joins. It is a cleaner rune than the one currently on disk. Bare glyph: **no tile, no circle, no halo.**
- **Status = glyph colour.** Five variants, the whole rune coloured:
  - `Brand` / idle — iron-palette rust (`#fa9c4c`, per `CLAUDE.md` §5).
  - `Healthy` — green. `Degraded` — amber. `Down` — red. `StoppedManually` — grey.
- **Operator decision — record it in the PR description.** For the single tray icon, status is signalled by **glyph colour**, not a halo. This is a deliberate, operator-approved exception to `CLAUDE.md` §5 ("status = halo ring … never use colour to signal status"). §5 governs **topology nodes** in the dashboard graph; a 16 px tray icon has no room for a halo, and Kenneth explicitly chose "no circle." **CC must not "correct" this back to a halo / ring.**
- Update `icons/raido-base.svg` + `scripts/gen_icons.py` to emit the colour-variant glyph set; regenerate every `raido-*.png` size + `raido-icon.ico`. Drop the now-dead circle-overlay assets and the unused `raido-orange-dim-*` pulse pair.
- `icons.rs` — the `IconVariant` enum + `bytes_16/32` mapping stays; the PNG bytes behind it change. Update the stale "circle / halo" language in the icons.rs doc comment.
- Commit `dock-icon-mockups.html` into `design-mockups/` — it is the canonical source of the chosen design (`CLAUDE.md` §6).
- **Tests are derivative (`CLAUDE.md` #1):** update any icon test asserting on the old asset bytes / shape in the same commit.
- **Acceptance:** `cargo build` + `cargo test` green; the tray icon renders as a clean bare rune whose colour tracks status; operator confirms visually.

### Cluster B — About dialog

- New tray menu item **"About stavᚱ Governor"** (place it just above Quit).
- It opens **one** small, fixed-size `WebviewWindow`, created on demand (the app currently defines no windows — this adds exactly one, not at startup). Closing it does not quit the app; the tray keeps running.
- Content: the 128 px brand glyph (`icons::BRAND_128` — already embedded for exactly this), the product name, the **Governor version** (`env!("CARGO_PKG_VERSION")`), the **daemon version + git SHA** (fetched live from the daemon's health / status surface — Phase 0 recon identifies the field; show "daemon unreachable" on failure), one line of description ("Observes the stavR daemon over `/healthz`. The OS service supervises the daemon — the Governor never restarts it on its own."), and a "View on GitHub" link.
- **Bump the version.** `governor/Cargo.toml` + `tauri.conf.json` are stuck at `0.6.5`, which predates the entire observe-only refactor. Bump to align with the daemon's line (`0.6.11`) or `0.7.0` — CC picks the smaller surprise and records the choice in the PR description.
- **Acceptance:** `cargo build` + `cargo test` green; clicking About opens the window with the correct Governor + daemon versions; closing it leaves the tray alive.

### Cluster C — Governor heartbeat  ⚠ DAEMON-TOUCHING

**This cluster deliberately opens daemon `src/`** — a new HTTP route + the Diagnostics fetcher wiring. The observe-only BOM listed daemon `src/` as don't-touch; **this BOM explicitly opens it for the heartbeat path only.** Nothing else in `src/` may change.

**Daemon side:**
- New route **`POST /governor/heartbeat`**, registered beside the existing loopback routes. Body: a small JSON object `{ version: string, signing?: string, rust_version?: string }` — matching the existing `GovernorHeartbeat` interface in `build-versions.ts`.
- **Security — this is the one new attack surface.** The PR #77 security review explicitly recorded that PR #77 added *no* new HTTP endpoints and *no* new deserialization paths. This route is precisely that new surface, so it must be got right:
  - **Loopback-only.** Reject any caller that is not `127.0.0.1` / `::1`. Match whatever the existing local-only routes do; the heartbeat route must never become remotely reachable.
  - **Strict input validation.** Cap `Content-Length` (<= 1 KB). Parse against the fixed schema; reject unknown fields, oversized strings, and a `signing` value outside the enum. Length-bound `version` / `rust_version`.
  - No auth token is required *given* loopback-only — but the loopback check is mandatory, not optional.
- **In-memory store.** Hold the latest heartbeat + its receipt timestamp in a small module-level holder (no DB, no persistence — it is live state, not init-cached config). Apply a **staleness window**: if the last heartbeat is older than ~3x the send interval (send 10 s -> stale at ~35 s), treat the Governor as not-running.
- **Wire it.** `diagnostics.ts` (~line 1232) and `diagnostics-overview.ts` (~line 192) currently call `snapshotBuildVersions()` with no arguments. Change them to pass `{ governorHeartbeat }` from the store, applying the staleness check (stale -> pass `null` -> the fetcher honestly renders `not-running`).
- **Tests are derivative (`CLAUDE.md` #1):** update the `build-versions` / diagnostics tests in the same commit.

**Governor side:**
- A **heartbeat thread** — a sibling to the `health-monitor` / `service-poll` / `event-bridge` / `tray-watcher` threads in `main.rs` — that POSTs to `http://127.0.0.1:7777/governor/heartbeat` every ~10 s with `{ version: env!("CARGO_PKG_VERSION"), rust_version, signing }`. Use the existing `ureq` dependency, short timeouts (same posture as `HttpProbe`). A failed POST is logged and absorbed — a heartbeat failure must **never** crash the tray.

CC may split this cluster into a daemon commit and a Governor commit if that keeps each commit's own test suite (`npm test` / `cargo test`) green; otherwise one commit.

- **Acceptance:** `npm test` + `npm run build` green (daemon); `cargo build` + `cargo test` green (Governor). Operator-verified in Phase E: with both running, the Diagnostics "Build & Versions" tile shows `GOVERNOR · RUNNING` with the live version; quitting the Governor flips it to `not-running` within ~35 s.

### Cluster D — Hardening (from the PR #77 security review)

The PR #77 security review raised two sub-0.8 observations. Both are cheap; fold them in.

- **`service.rs` — validate the public name / script-path inputs.** Add a defensive whitelist (`[A-Za-z0-9._-]`, plus the path separators / `:` the script path legitimately needs) on `SystemServiceController.name` and the public upgrade-script path *before* they reach a `format!` into a PowerShell string. The review called `pub name: String` "fragile for a future caller." On violation, return a `ServiceError` rather than building the command.
- **`bin/upgrade-daemon.sh` — promote `set -u` -> `set -euo pipefail`.** The review flagged a future fail-fast regression risk. Verify the existing explicit `$?` / `||` rollback routing still holds under `pipefail` — adjust any step whose exit semantics change.
- **Acceptance:** `cargo test` green; re-run the upgrade script's forced-build-failure case — it must still roll back to the pre-upgrade commit.

### Phase E — Build + verify

- **CC:** `cargo build --release` + `cargo test` (Governor); `npm test` + `npm run build` (daemon). One PR, per-cluster commits, DCO sign-off (`-s`). Push at the end of each cluster.
- **Operator smoke (Kenneth):**
  1. New icon renders as a clean bare rune; colour tracks status.
  2. About opens with correct Governor + daemon versions; closes cleanly.
  3. Deploy the new daemon build (restart the `StavrDaemon` service onto it) -> Diagnostics "Build & Versions" shows `GOVERNOR · RUNNING`; quitting the Governor flips it to `not-running` within ~35 s.
  4. **Deferred observe-only Phase 6 smoke** (carried over): trigger a CONFIRM / EXPLICIT approval gate -> OS notification -> click opens the Decide page; **Restart Daemon** -> daemon bounces, pip recovers; **Upgrade Daemon** -> daemon upgrades or rolls back cleanly. `pm2 list` stays empty; exactly one `node` serves 7777 throughout.

---

## Deferred (NOT in this BOM)

- Automatic / scheduled daemon upgrade ("realtime upgrades", task #34) — still the manual operator-triggered path only.
- The topology page redesign (task #42) — separate BOM.
- A Governor settings / preferences surface — out of scope.

## Don't-touch

- Daemon `src/` **except**: the new `POST /governor/heartbeat` route + its in-memory store, and the `snapshotBuildVersions()` call sites in `diagnostics.ts` / `diagnostics-overview.ts`. Nothing else in `src/`.
- The WinSW / systemd / launchd templates + install / uninstall scripts in `bin/` (the upgrade scripts are in scope only for the Cluster D `pipefail` change).
- The observe-only contract: no supervision, no auto-restart. Cluster C is observe-only-compatible — the Governor *reports* to the daemon, it does not control it.

## Run prompt for CC

```
Read CLAUDE.md, then proposed/governor-polish-bom.md. You are continuing on
the existing feat/governor-polish branch (it already carries the BOM commit
and an operator-verified service.rs window-flash fix — build on them, don't
revert).

Execute the 4 clusters: (A) new tray icon — concept 6 bare rune, status by
glyph colour, no circle/halo, regenerate the asset set; (B) About dialog —
tray menu item opening a small window with Governor + daemon versions, bump
the stale Cargo.toml version; (C) Governor heartbeat — a loopback-only
POST /governor/heartbeat daemon route + in-memory store with a staleness
window, wired into the Diagnostics fetcher, plus a Governor heartbeat
thread; (D) the two hardening items from the PR #77 security review.

Sensitivity careful — Cluster C touches the LIVE daemon src/. Status check
before/after every commit; report after each cluster.

Skarp och hangslen: git status --short + git symbolic-ref HEAD before every
mutating git op.

Cluster A: status-by-glyph-colour is an operator-approved exception to
CLAUDE.md section 5 — do NOT convert it back to a halo. Cluster C: the
heartbeat route is the one new attack surface — loopback-only, strict input
validation, per the BOM. Tests are derivative (CLAUDE.md #1) — update them
in the same commit as the code.

Do NOT deploy to the live daemon — the operator restarts the StavrDaemon
service and runs the runtime smoke (Phase E). One PR, per-cluster commits,
DCO sign-off (-s). Go.
```

---

## End of BOM
