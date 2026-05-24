# Recon: Family-mode Phase 2 — Install Packaging

**Phase 0 output.** Findings only — no code changes. Operator reviews before Phase 1.

**Branch:** `feat/family-mode-phase-2` (off `main`, commit `b80c602`).
**Date:** 2026-05-23.

---

## 1. node:sqlite stability — current status

Fetched live from `https://nodejs.org/api/sqlite.html` on 2026-05-23.

| Item | Value |
|---|---|
| Stability | **1.2 — Release candidate** |
| Promoted to RC in | **Node v25.7.0** |
| Added in | Node v22.5.0 |
| `--experimental-sqlite` flag | **no longer required** (since v22.13 / v23.4) |

> Quote from the docs: *"v25.7.0 — SQLite is now a release candidate."*

**Conclusion:** the BOM's assumption holds — node:sqlite is RC, not yet Stability 2 (Stable). The decision to adopt it for a load-bearing dependency was made eyes-open; nothing has regressed. No newer Node release stabilizes it further; RC is the floor we're shipping on.

**Implication for Phase 2 — `engines.node` bump:**

The BOM says bump to `>=22.5`. That's the *minimum where node:sqlite exists*, but it was still flag-gated there. Two cleaner choices:

- `>=22.13` — flagless node:sqlite (still 1.1 Experimental). Lower bar for users.
- `>=25.7` — flagless **and** RC. Strongest stability guarantee. Recommended for a substrate migration.

Recommend `>=25.7` for the Phase 2 PR. (Node 22 LTS users would need to upgrade, but stavR is a personal daemon, not a published library — upgrading the bundled-with-SEA Node version is just a build-pipeline change in Phase 3.)

---

## 2. `better-sqlite3` reference audit

Re-counted on `feat/family-mode-phase-2` (branched off `main` @ `b80c602`).

The 2026-05-20 assessment estimated "~12 files (2 constructors, ~8 store handle-receivers, 1 cli.ts cast)." Current count is **higher** — the v0.8 history dashboard (PR #56 area) added a new family of type-only consumers between the assessment and now.

### 2a. Source files in `src/` that touch `better-sqlite3`

**Engine constructors (2 files — the only places that `new Database(...)`):**

1. `src/persistence.ts:1` — `import Database from 'better-sqlite3';` — main daemon event-store + projections.
2. `src/steward-agent/db/init.ts:11` — `import Database from 'better-sqlite3';` — Steward subprocess opens three DBs (`memory`, `lessons`, `prefs`).

**Store classes that receive a `Database` handle (type-only imports, 10 files):**

3. `src/credentials/store.ts:2`
4. `src/trust/store.ts:2`
5. `src/steward/store.ts:2`
6. `src/security/identity-store.ts:12`
7. `src/security/capability-overrides.ts:28`
8. `src/security/actor-permissions.ts:25`
9. `src/notify/digest.ts:12`
10. `src/notify/notifier.ts:11`
11. `src/notify/telegram-poller.ts:17`
12. `src/steward-agent/db/types.ts:8` (one TS interface per logical store; type only)

**Dashboard data-fetchers — new since the 2026-05-20 assessment (9 files):**

13. `src/dashboard/data/history/boms.ts:23`
14. `src/dashboard/data/history/correlation.ts:26`
15. `src/dashboard/data/history/decisions.ts:17`
16. `src/dashboard/data/history/detail.ts:11`
17. `src/dashboard/data/history/host-exec.ts:12`
18. `src/dashboard/data/history/notifications.ts:16`
19. `src/dashboard/data/history/plans.ts:14`
20. `src/dashboard/data/history/scopes.ts:10`

All eight are `import type Database from 'better-sqlite3'` — pure type imports. The dashboard data-fetcher contract is explicitly listed as don't-touch in CLAUDE.md §3, but type-only consumers all switch when the port's `Database` type alias changes, so they're carried along by the Phase 1 refactor *automatically* — no logic change needed.

**Leaks (casts that bypass the type system):**

21. `src/cli.ts:720` —
    ```ts
    const db = (store as unknown as { db: import('better-sqlite3').Database }).db;
    ```
    The canonical "cast through `unknown` to reach the raw handle" — the BOM calls this out by name. Killed in Phase 1.

### 2b. Tests that touch `better-sqlite3` directly

These aren't in the BOM's scope summary but they DO need updating during Phase 1 (rule #1: tests update in the same commit as the code they cover).

**Constructor imports (4 — open their own DBs for fixtures):**

- `tests/persistence/workers-lifecycle-migration.test.ts:16`
- `tests/security/policies.test.ts:2`
- `tests/security/policies-yaml.test.ts:2`
- `tests/observability/retention.test.ts:2`

**Type-only / cast in tests (6):**

- `tests/dashboard/data/history/helpers.ts:8` — `import('better-sqlite3').Database` return type from `makeStore()`.
- `tests/dashboard/data/history/scopes.test.ts:5`
- `tests/dashboard/data/history/plans.test.ts:5`
- `tests/dashboard/data/history/notifications.test.ts:6,13`
- `tests/dashboard/data/history/host-exec.test.ts:6`
- `tests/dashboard/data/history/decisions.test.ts:5`
- `tests/dashboard/data/history/correlation.test.ts:16`
- `tests/dashboard/history-detail.test.ts:81`
- `tests/workers/watchdog.test.ts:24,168` — **second cast leak**: `(store.rawDb as import('better-sqlite3').Database)`. The BOM only names the `cli.ts` cast, but this is the same anti-pattern — the store class exposes a `rawDb` accessor that the test reaches into. Phase 1 should close both.

### 2c. Counts at a glance

| Category | Count |
|---|---|
| Engine constructors (`new Database(...)`) | **2** |
| Source files importing the type or constructor | **21** (2 + 19) |
| Cast-through-`unknown`-or-`as` leaks | **2** (cli.ts + watchdog test) |
| Test files importing `better-sqlite3` directly | **10** |
| Total files touching `better-sqlite3` (excl. docs/ADR/diag JSON) | **31** |

The BOM's "~12 files" was right for *src/-only excluding dashboard/data/history*; the dashboard history dashboard work has roughly doubled the surface since the assessment. **Phase 1 scope is bigger than the assessment implied** — flag for operator.

### 2d. Documentation / ADR mentions (no refactor required, but ADR text will need a follow-up sweep)

- `ARCHITECTURE.md:309`, `CONTRIBUTING.md:41`, `NOTICE:113`
- `adr/002-sqlite-not-postgres.md:12`, `adr/013-single-workers-table-with-type-discriminator.md:14`, `adr/030-event-retention-and-dashboard-caching.md:139`, `adr/031-observability-architecture.md:50`, `adr/036-audit-integrity-baseline.md:31`
- `proposed/v0_5-steward-portability-bom.md`, `proposed/v0_6_x-memory-leak-findings.md`
- `docs/leak-hunt-evidence.md:47`, `notes/stuck-cc-mega-session-2026-05-13.md`

A docs sweep belongs at the end of Phase 2 (engine swap) rather than Phase 1 (port refactor) — defer.

---

## 3. Governor release workflow & sidecar config

### 3a. `.github/workflows/governor-release.yml`

**Critical finding: the current workflow does NOT use the Tauri bundler at all.**

The workflow runs `cargo build --release --locked --target <triple>` per platform and uploads the raw `stavr-governor.exe` / unix binary as a release asset, alongside an SBOM and cosign signatures. There is **no Tauri bundle step, no installer artifact (no `.exe` NSIS, no `.msi`, no `.dmg`, no `.deb`)** produced today.

Implications for the BOM:

- **Phase 4 (Tauri sidecar bundling) is larger than the BOM text reads.** It is not just "add the daemon as an `externalBin`" — it must *also* introduce a `tauri build` step that emits installers. Today the workflow ships a bare governor binary; Phase 4 has to graduate it to a true installer pipeline.
- **The BOM's reference to `bundle.targets` (Phase 5 / decisions §MSI) makes sense at the `tauri.conf.json` level but does NOT yet exist as a CI step.** Phase 5 must add the `tauri build --bundles msi,nsis` invocation, not just edit the config.
- **WiX toolchain is NOT installed on the matrix runners** (current runners are `windows-2025`, `macos-14`, `ubuntu-24.04` — Cargo-only). Phase 5 has to add a WiX install step on the Windows runners.
- **The tag pattern is `v0.6.5*` only.** Any Phase 2+ release will need either a broader tag pattern or an explicit `workflow_dispatch` to fire — flag for operator before tagging.
- **The matrix is missing `aarch64-unknown-linux-gnu` (linux-arm64).** Phase 3 says linux-arm64 is optional ("include only if a family machine needs it") — current workflow already excludes it, consistent.

### 3b. `governor/tauri.conf.json`

```jsonc
{
  "productName": "stavR Governor",
  "version": "0.6.5",
  "identifier": "tech.stavr.governor",
  "build": { "frontendDist": "./dist", "beforeDevCommand": "", "beforeBuildCommand": "" },
  "app": { "windows": [], "security": { "csp": null } },
  "bundle": {
    "active": true,
    "targets": "all",   // <-- "all" means every Tauri-supported bundle type
    "category": "DeveloperTool",
    "icon": ["icons/raido-32.png", "icons/raido-128.png", "icons/raido-256.png", "icons/raido-icon.ico"]
  }
}
```

Observations:

- `bundle.targets: "all"` → on Windows this expands to `nsis` + `msi` *if* the toolchains are installed. So WiX is the only missing piece for the MSI deliverable — the config is already permissive.
- `app.windows: []` — **no windows defined.** The Governor is currently headless (tray-only). Phase 4.5 (first-run wizard) needs a real window declaration; the empty array is today's state.
- `externalBin` is **not present** — Phase 4's central change. It will sit under `bundle.externalBin` and point at the per-target daemon executable produced in Phase 3.
- No code-signing config (`bundle.windows.certificateThumbprint`, `bundle.macOS.signingIdentity`) — today binaries are cosign-signed *post-build*, not Authenticode/notarized. For a family-pack installer that family members can run without SmartScreen warnings, Phase 5 likely needs to add real OS-trust signing on top of the existing Sigstore chain. **Flag for operator** — adds cost (EV cert ≈ $200/yr) and is not in any current BOM phase.
- `identifier` and `productName` are stable; no rename needed.
- `version: 0.6.5` is stale — needs to track the daemon version once they ship together.

---

## 4. Current `governor/` Tauri scaffolding — what exists vs. what Phase 4.5 must build

### 4a. Inventory

```
governor/
├── Cargo.toml        (Tauri 2 + tray-icon + notification + opener plugins)
├── tauri.conf.json
├── build.rs
├── src/
│   ├── main.rs               (182 lines — wires supervisor + tray + event-bridge)
│   ├── lib.rs                (15 lines — module exports)
│   ├── supervisor.rs         (541 lines — state machine, health probe, restart)
│   ├── restart.rs            (505 lines — Pm2Restarter + OrphanAwareRestarter)
│   ├── port_check.rs         (280 lines — SystemPortChecker for orphan recovery)
│   ├── state.rs              (696 lines — state machine + history ring)
│   ├── tray.rs               (658 lines — tray icon + menu + apply_state)
│   ├── icons.rs              (347 lines — embedded PNG variants)
│   ├── event_bridge.rs       (470 lines — SSE /dashboard/stream consumer)
│   ├── event_router.rs       (612 lines — per-kind debounce + filter)
│   ├── notification.rs       (84 lines — TauriToastRenderer)
│   └── actions.rs            (168 lines — tray-menu action handlers)
├── icons/                    (21 PNG/SVG variants: raido-{16,32,64,128,256,512,1024}.png, raido-{gray,green,orange,orange-dim,red,yellow}-{16,32}.png, raido-icon.ico, raido-base.svg)
├── dist/index.html           (placeholder Tauri frontend — currently empty shell)
├── installers/
│   ├── stavr-governor-install.ps1   (99 lines)
│   └── stavr-governor-install.sh    (189 lines)
└── scripts/                  (dev-sign, gen-sbom, install-from-release, verify-release; cross-platform pairs)
```

**Total Rust source: ~4500 lines.** This is *not* a bare shell.

### 4b. What's already built (relevant to Phase 4.5)

- **Tray icon: built.** Full `tray::build()`, `apply_state()`, status-driven icon swap (green/orange/yellow/red/gray), 500 ms pulse for transient states. The Phase 4.5 spec says "bare Raido glyph with a corner status dot" — the current icon set is the *full coloured glyph* (raido-green-32.png etc.). **The icon-design change in Phase 4.5 is a real piece of work**: regenerate icons as the bare glyph + dot composite, then re-export the existing variants. The `icons.rs` plumbing (variant enum, validity check, embedding via `include_bytes!`) is already there and re-usable.
- **Tray menu: built.** Quit, Reset & Restart, Pause exist. Phase 4.5's "open dashboard, restart daemon (via OS service), diagnostic triggers" mostly maps to *editing menu entries* — bones are there.
- **Notification plumbing: built.** `tauri-plugin-notification` is wired; `TauriToastRenderer` exists and the event-bridge/router stack already turns dashboard SSE events into toasts. **Phase 4.5's "native decision-notification that deep-links to dashboard's Decide page" is almost free** — the toast renderer exists; what's missing is (a) the deep-link click handler routing to `/dashboard/decide?id=...` via `tauri-plugin-opener`, and (b) filtering the event-router to fire toasts for CONFIRM/EXPLICIT decisions specifically.
- **Supervisor + restart: built — but is the Phase 6-superseded layer.** All of `supervisor.rs`, `restart.rs`, `port_check.rs`, and the PM2-specific paths (`Pm2Restarter`, `OrphanAwareRestarter`) become **legacy code** under the os-native-governor decision. The OS service is the supervisor now. **This is a sizable removal** — ~1300 lines of Rust that Phase 4 / the OS-native BOM needs to either delete or convert into a passive "observe OS service state" layer. Flag for operator: the Tauri Governor will lose substantial code, not gain it, in the supervision area.

### 4c. What does NOT exist yet (Phase 4.5 net-new work)

- **First-run wizard.** `app.windows: []` in `tauri.conf.json`; `dist/index.html` is an empty placeholder shell. The wizard is true greenfield — needs window config, a real frontend (HTML/CSS or a SPA), command bindings for "save pairing config", "save group hub endpoint", etc. **This is the bulk of Phase 4.5's effort.**
- **Bare-glyph status-dot icons.** The current `raido-green-32.png` etc. are the *coloured glyph*. Phase 4.5 needs a different visual treatment (bare glyph + corner dot). `governor/scripts/gen_icons.py` exists and can be reused — but the source SVG (`raido-base.svg`) and the gen script both need updating.
- **OS-service status observation.** The supervisor currently *runs* the supervision loop directly. Phase 4.5 (post-OS-native-governor landing) needs a *read-only* observer that queries the OS service (`systemctl is-active`, `sc query`, `launchctl print`) and surfaces that in the tray. **Cannot start before `os-native-governor-bom.md` lands** — confirmed dependency.
- **Sidecar (`externalBin`) wiring.** Not in `tauri.conf.json` today; Phase 4's job.

---

## 5. Risks / things to flag before Phase 1 starts

1. **Phase 1 refactor surface is ~2× the assessment estimate** (21 src/ files + 10 test files, not ~12). Still bounded and mechanical, but plan accordingly.
2. **`engines.node` floor decision** — recommend `>=25.7` (RC node:sqlite, no flag) rather than the BOM's `>=22.5`. Operator call.
3. **`watchdog.test.ts` exposes a second `rawDb` cast leak** the BOM didn't name. Phase 1 should close both casts; it's a small extension of scope, not a new phase.
4. **The Governor release workflow has NO Tauri-bundle step today.** Phase 4 is not just config — it must add `tauri build` to the matrix. Phase 5 (MSI) builds on top of that, not on a pre-existing bundle step.
5. **Authenticode / macOS notarization is NOT covered by any phase.** Current signing is cosign-only (developer verification, not OS-trust). A family member double-clicking the `.msi` on Windows 11 will hit SmartScreen warnings. EV cert + notarization is out of scope per the BOM; surface this as a known gap.
6. **Phase 4.5 dependency chain is tight:** Phase 4 (sidecar) → `os-native-governor-bom.md` (supervisor migration) → Phase 4.5 (first-run wizard + OS-service observation + decision-notification). The OS-native BOM is not in this BOM's phase list but is a hard precondition for Phase 4.5's supervision-observer half. **Verify it has landed before starting Phase 4.5.**
7. **~1300 lines of supervisor/restart Rust become legacy under the OS-native decision.** Removal/conversion is not scoped here but will land in / around Phase 4.5. Not a blocker for Phase 1.
8. **Governor `version: 0.6.5` and the release-workflow tag pattern `v0.6.5*` are both stale** for a v0.7-class shipment. Re-tag scheme is a Phase 5-or-earlier decision.

---

## 6. Recommendation

Proceed to Phase 1 (persistence port refactor) on `feat/family-mode-phase-2`. Pre-Phase-1 operator decisions to lock:

- (D1) `engines.node` floor — `>=22.13` vs. `>=25.7`. Recommend `>=25.7`.
- (D2) Phase 1 also closes the `watchdog.test.ts` `rawDb` cast (not just the `cli.ts` one) — confirm scope creep is acceptable.
- (D3) Phase 1 covers the 19 dashboard/data/history type-only consumers (mechanical type-rename) — confirm scope creep is acceptable.

No code changes in this phase. Awaiting operator review.

---

## End of recon
