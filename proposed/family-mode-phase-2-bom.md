# BOM: Family-mode Phase 2 — Install Packaging

**Owner:** CC
**Sensitivity:** `high` — touches `src/persistence.ts` and the database engine (a substrate migration), plus the CI release pipeline. Operator approval gate between every phase; full diff per phase. Not a continuous run.
**Verification window:** `full` — persistence migration + build/release pipeline.
**Branch:** `feat/family-mode-phase-2`
**Base:** `main`
**Estimated scope:** 10 phases (0-8 plus Phase 4.5 — Governor UI; Phase 6 superseded), 6-7 PRs, multi-day with operator gates (~9-13 working days of CC time).

---

## Why this BOM exists

Family-mode functional is the current cycle. Phase 1 makes the daemon reachable; **Phase 2 makes it installable**. Today installing the daemon means git clone + npm install + npm run build + PM2 — developer-only. Kenneth's sons cannot do that. The install story is the prerequisite for family-mode actually working: a federation nobody can install is not a federation.

It also closes two open defects observed this session: the `pm2-windows-startup` PM2 module is in an `errored` loop (a one-shot CLI mis-installed as a persistent module), and the 2026-05-19 reboot left the daemon down because PM2's registry Run-key never fired. Both are symptoms of "PM2 as the boot mechanism", now addressed by the standalone `os-native-governor-bom.md` (this BOM's former Phase 6 — see the Reconciliation pass note below).

## Decisions already locked (2026-05-20 install-packaging 10-3-1 — do not re-litigate)

- **Architecture:** Option A — the Governor (Tauri 2) bundles the daemon as a Tauri **sidecar** (`externalBin`). One signed installer per OS = a full stavR install. Governor already manages daemon lifecycle (ADR-033).
- **Family layer:** option #10 — a family-pack pre-configured installer layer on top, so a family member double-clicks one installer and is done.
- **SQLite:** migrate `better-sqlite3` → **`node:sqlite`** (NOT the `.node` prebuild sidecar). better-sqlite3 is a native C++ addon and is the blocker for compiling the daemon to a standalone executable. node:sqlite is built into Node — clean SEA, no native dep. node:sqlite is a Release Candidate (stability 1.2) as of Node 26 — acceptable for a load-bearing dependency.
- **Condition on the SQLite decision:** node:sqlite goes behind a clean persistence **port/adapter** — zero SQLite calls leak outside it. The event log (ADR-036) is the source of truth; SQLite tables are a rebuildable **projection**. That is what keeps the engine swappable.
- **MSI:** the Governor release workflow today produces only an NSIS `.exe`. Add a WiX `.msi` — managed-Windows / Group Policy deployment expects `.msi`.

## Reconciliation pass (2026-05-23)

Written 2026-05-20; two later decisions are now folded in.

- **Phase 6 is superseded** by `proposed/os-native-governor-bom.md` — OS-native service for boot-start + supervision + crash-loop backoff, cross-platform (systemd / launchd / Windows Service), PM2 dropped. That BOM's own "Supersedes" section explicitly retires this phase. Phase 6 below is now a pointer; numbering is kept so Phases 7-8 don't shift.
- **The OS service is the supervisor, not the Tauri Governor.** Per the os-native-governor decision (2026-05-20, 10-3-1 Option A), the OS init system supervises the daemon. Phase 4 is reconciled accordingly: the Tauri Governor is the installer + tray + daemon-bundler, not the process supervisor. **Resolved 2026-05-23 (10-3-1 + audit):** OS service supervises; the Tauri Governor is **installer + first-run wizard + tray status pip + a native decision notification that deep-links to the dashboard Decide page** ("B+"). It does NOT get a bespoke native approval UI or its own WebAuthn ceremony — approval stays in the dashboard / Telegram. This adds a Governor-UI scope (wizard + tray + decision-notification). **Resolved 2026-05-23:** scoped as **Phase 4.5 — Governor UI** below, and ADR-033 amended (see its 2026-05-23 Amendment).
- **Phase 7's pre-seed model changed** — per the 2026-05-21 federation-substrate decision it is per-group relay hubs, not a `peers.yaml` mesh. See the revised Phase 7.

## Reference reading (CC, at Phase 0)

- `CLAUDE.md` — invariants.
- `adr/033-stavr-tray-companion.md` (Governor manages the daemon), `adr/036-audit-integrity-baseline.md` (event log = source of truth), `adr/002-sqlite-not-postgres.md`.
- Memory: `stavr-install-packaging-assessment-2026-05-20`, `project_stavr_next_cycle_family_mode_functional`.
- Code: `src/persistence.ts`, `src/steward-agent/db/init.ts`, the store classes that receive a DB handle (`src/credentials/store.ts`, `src/trust/store.ts`, `src/steward/store.ts`, `src/security/{actor-permissions,capability-overrides,identity-store}.ts`, `src/notify/{digest,notifier,telegram-poller}.ts`), `src/cli.ts` (the `(store as unknown as {db}).db` cast ~line 720), `package.json` (`engines.node`), `.github/workflows/governor-release.yml`, `governor/tauri.conf.json`, `governor/installers/`, `ecosystem.config.cjs`.

## Don't-touch

- This BOM explicitly OPENS `src/persistence.ts` and the CI release pipeline — they are in scope. Outside that: no dashboard work, no federation logic, no security primitives (that is Phase 1).
- Do not change SQL semantics during the engine swap — node:sqlite's `DatabaseSync` API is close to better-sqlite3's sync API; a behaviour change is a regression.

---

## Phase 0 — Recon (output a findings doc, then STOP)

- Re-confirm node:sqlite's current stability status (RC as of Node 26 per the assessment — verify it has not regressed or that a newer Node makes it stable).
- Re-audit every `better-sqlite3` reference — the assessment found ~12 files (2 that construct a `Database`, ~8 store classes that receive a handle, 1 cast-through-`unknown` leak in `cli.ts`). Confirm the current count and list.
- Confirm the Governor release workflow's current `bundle.targets` and `tauri.conf.json` sidecar config.
- Survey the current `governor/` Tauri app — does any tray, window, first-run, or notification scaffolding already exist, or is it a bare shell? This sizes Phase 4.5.
Output `proposed/family-mode-phase-2-recon.md`. **Operator reviews before Phase 1.**

## Phase 1 — Persistence port (no engine change)

Introduce a shared `src/db/` adapter — a clean persistence port. Migrate all better-sqlite3 call sites to import the port instead of the engine directly. Kill the `cli.ts` cast that reaches through `unknown` to grab the raw handle. **Still better-sqlite3 underneath** — this phase is pure refactor: prove the port works with the existing engine before swapping it. Tests green, no behaviour change.

## Phase 2 — node:sqlite engine swap

Swap the engine behind the port to `node:sqlite` (`DatabaseSync`). Bump `engines.node` to `>=22.5`. Verify the event-log-as-source-of-truth / SQLite-as-projection model holds — the projection must be rebuildable from the log. This is the riskiest phase: operator gate, full verification, full test suite. If node:sqlite proves unfit, this phase reverts cleanly to better-sqlite3 behind the same port (the port is the insurance).

## Phase 3 — Standalone executable (SEA)

Compile the daemon to a single standalone executable per platform in CI — now clean, with no native addon to embed. Targets: win-x64, win-arm64, macos-x64, macos-arm64, linux-x64. (linux-arm64 / Raspberry Pi is optional — include only if a family machine needs it.)

## Phase 4 — Tauri sidecar bundling

Bundle the compiled daemon executable as a Tauri `externalBin` sidecar in `governor/tauri.conf.json`. The Governor installer now carries the daemon. **Supervision (reconciled 2026-05-23):** the daemon is started/stopped/supervised by the OS-native service from `os-native-governor-bom.md` — NOT by the Tauri Governor. The Governor's role is installer + tray app + daemon-bundler; the installer registers the OS service at install time. One signed installer per OS = a complete stavR.

## Phase 4.5 — Governor UI (wizard + tray + decision-notification)

The Tauri Governor's user-facing surface. `adr/033-stavr-tray-companion.md` (amended 2026-05-23) is the spec; this phase builds it. Three parts:

- **First-run wizard.** On first launch the Governor walks a non-technical family member through setup with no terminal — pair the device, point the daemon at its group relay hub, pick a profile. The onboarding UI half of the family-pack: Phase 7 supplies the pre-seeded config, this phase is the wizard that consumes it.
- **Tray status pip.** A menu-bar / system-tray presence showing live engine health (`/healthz` + the OS-service status) as ok / warn / crit. Icon: the bare Raido glyph — no circle, no tile — with a corner status dot, green / amber / red (status is a dedicated indicator, never the mark's colour). Right-click menu: open dashboard, restart the daemon (forwarded to the OS-native service, not PM2), the diagnostic triggers from ADR-033 §6. This is ADR-033's observability core, unchanged in intent.
- **Native decision-notification.** When a CONFIRM- or EXPLICIT-tier decision opens, the Governor raises a native OS notification that deep-links to the dashboard's Decide page. It does NOT host an approval UI or a WebAuthn ceremony — the operator approves in the dashboard (or via Telegram). The "B+" outcome of the 2026-05-23 10-3-1: proactive notice without a third approval surface to secure.

Depends on Phase 4 (the Tauri sidecar shell exists) and on family-mode-phase-1's pairing flow (merged). Supervision is NOT this phase's concern — the Governor observes the OS-native service, it does not supervise. The launcher and tray icon concepts are decided (bare glyph; glyph + corner status dot); this phase turns them into the real per-resolution icon set.

## Phase 5 — MSI installer

Add a WiX `.msi` to `.github/workflows/governor-release.yml`: `bundle.targets` explicitly includes `msi`; the CI runner gets the WiX toolchain. `.msi` alongside the existing `.exe`.

## Phase 6 — SUPERSEDED — boot persistence moved to os-native-governor-bom.md

Boot-start, pre-login startup, crash-loop backoff, the Windows Service (WinSW), and PM2 removal are all delivered cross-platform by the standalone `proposed/os-native-governor-bom.md` (decided 2026-05-20, 10-3-1 Option A — OS init is the governor). No work in this phase. **Dependency:** the os-native-governor BOM should land before Phase 7 so the family-pack installer registers the OS-native service rather than a PM2 run-key.

## Phase 7 — Family-pack installer layer

The pre-configured installer layer (option #10): one installer that pre-seeds the family configuration so a family member runs it and the daemon is immediately part of the federation — no terminal, no config files. Build on the Phase 4 installer.

**Reconciled 2026-05-23** against the federation-substrate decision (2026-05-21, memory `stavr-phase0-federation-substrate-decision`): the substrate is **per-group relay hubs**, not a `peers.yaml` peer mesh. In-group daemons connect **outbound** to their group's relay hub and bind nothing inbound; cross-group visibility is a trust-scope grant. So the family-pack pre-seed is the **group hub endpoint + the daemon's outbound pairing to that hub** (plus the default profile) — NOT a `peers.yaml` peer list, and NOT mDNS/WebRTC discovery config (ADR-042 Decision 2 is superseded for the cross-site case). Phase 7's exact pre-seed payload is contingent on the relay-hub substrate landing first (the family-mode milestone's "wire the substrate" phase); treat Phase 7 as last and re-spec its config keys once the hub exists.

## Phase 8 — Verification

`full` window. `npm test` + `npm run build` + `tsc --noEmit` clean. Migration verification: the SQLite projection rebuilds correctly from the event log. Install smoke: the signed installer (`.msi` and `.exe`) installs on a clean Windows target, the daemon starts as a service, survives a reboot, and is reachable. The "double-click, done" family experience works end to end.

---

## Sensitivity & cadence

`high`. Operator approval gate between every phase — CC stops, dumps the full diff, waits. Rationale: a database-engine migration plus the release pipeline; a wrong autonomous change risks data-layer corruption or a broken installer shipped to family machines.

## PR grouping

- PR 1 — Phase 0 recon doc.
- PR 2 — Phase 1 (persistence port, no engine change).
- PR 3 — Phase 2 (node:sqlite swap).
- PR 4 — Phases 3-4 (SEA + Tauri sidecar).
- PR 5 — Phase 4.5 (Governor UI — wizard, tray, decision-notification).
- PR 6 — Phase 5 (MSI). Phase 6 is superseded by `os-native-governor-bom.md` — no PR.
- PR 7 — Phase 7-8 (family-pack + verification).

Operator reviews and approves each before the next.

## Definition of done

1. Zero SQLite calls outside the `src/db/` port; the `cli.ts` cast is gone.
2. The daemon runs on node:sqlite; the SQLite projection rebuilds from the event log.
3. The daemon compiles to a standalone per-platform executable in CI.
4. One signed installer per OS (`.msi` + `.exe`) carries the daemon as a Governor sidecar.
5. Boot persistence (Windows Service, survives reboot/pre-login, `pm2-windows-startup` gone) is delivered by `os-native-governor-bom.md` — a precondition of this BOM, not a deliverable here. Verify it has landed.
6. The family-pack installer gives a non-technical family member a double-click install.
7. The Governor app provides the first-run wizard, a tray status pip (bare-glyph icon + green/amber/red status dot), and a native decision-notification that deep-links to the dashboard Decide page.
8. Full test suite green; install smoke passes on a clean target.

## Run prompt for CC

```
Read CLAUDE.md, then proposed/family-mode-phase-2-bom.md. Execute Phase 0 (recon) ONLY — output proposed/family-mode-phase-2-recon.md and STOP. Wait for operator review before Phase 1.

Sensitivity: high. Operator approval gate between EVERY phase. Full diff dump per phase. NOT a continuous run.

The riskiest phase is Phase 2 (node:sqlite engine swap). The persistence port (Phase 1) is the insurance — if node:sqlite proves unfit, Phase 2 reverts to better-sqlite3 behind the same port. Do not skip the port.

Skärp och hängslen: git status --short + git symbolic-ref HEAD before every mutating git op. One commit per phase, DCO sign-off (-s). Branch feat/family-mode-phase-2 off current main. Verify files >30KB with stat + tail before commit.

Go — Phase 0 only.
```

---

## End of BOM
