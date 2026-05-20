# BOM: Family-mode Phase 2 — Install Packaging

**Owner:** CC
**Sensitivity:** `high` — touches `src/persistence.ts` and the database engine (a substrate migration), plus the CI release pipeline. Operator approval gate between every phase; full diff per phase. Not a continuous run.
**Verification window:** `full` — persistence migration + build/release pipeline.
**Branch:** `feat/family-mode-phase-2`
**Base:** `main`
**Estimated scope:** 9 phases (0-8), 5-6 PRs, multi-day with operator gates (~8-12 working days of CC time per the install-packaging assessment).

---

## Why this BOM exists

Family-mode functional is the current cycle. Phase 1 makes the daemon reachable; **Phase 2 makes it installable**. Today installing the daemon means git clone + npm install + npm run build + PM2 — developer-only. Kenneth's sons cannot do that. The install story is the prerequisite for family-mode actually working: a federation nobody can install is not a federation.

It also closes two open defects observed this session: the `pm2-windows-startup` PM2 module is in an `errored` loop (a one-shot CLI mis-installed as a persistent module), and the 2026-05-19 reboot left the daemon down because PM2's registry Run-key never fired. Both are symptoms of "PM2 as the boot mechanism" — Phase 6 replaces it.

## Decisions already locked (2026-05-20 install-packaging 10-3-1 — do not re-litigate)

- **Architecture:** Option A — the Governor (Tauri 2) bundles the daemon as a Tauri **sidecar** (`externalBin`). One signed installer per OS = a full stavR install. Governor already manages daemon lifecycle (ADR-033).
- **Family layer:** option #10 — a family-pack pre-configured installer layer on top, so a family member double-clicks one installer and is done.
- **SQLite:** migrate `better-sqlite3` → **`node:sqlite`** (NOT the `.node` prebuild sidecar). better-sqlite3 is a native C++ addon and is the blocker for compiling the daemon to a standalone executable. node:sqlite is built into Node — clean SEA, no native dep. node:sqlite is a Release Candidate (stability 1.2) as of Node 26 — acceptable for a load-bearing dependency.
- **Condition on the SQLite decision:** node:sqlite goes behind a clean persistence **port/adapter** — zero SQLite calls leak outside it. The event log (ADR-036) is the source of truth; SQLite tables are a rebuildable **projection**. That is what keeps the engine swappable.
- **MSI:** the Governor release workflow today produces only an NSIS `.exe`. Add a WiX `.msi` — managed-Windows / Group Policy deployment expects `.msi`.

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
Output `proposed/family-mode-phase-2-recon.md`. **Operator reviews before Phase 1.**

## Phase 1 — Persistence port (no engine change)

Introduce a shared `src/db/` adapter — a clean persistence port. Migrate all better-sqlite3 call sites to import the port instead of the engine directly. Kill the `cli.ts` cast that reaches through `unknown` to grab the raw handle. **Still better-sqlite3 underneath** — this phase is pure refactor: prove the port works with the existing engine before swapping it. Tests green, no behaviour change.

## Phase 2 — node:sqlite engine swap

Swap the engine behind the port to `node:sqlite` (`DatabaseSync`). Bump `engines.node` to `>=22.5`. Verify the event-log-as-source-of-truth / SQLite-as-projection model holds — the projection must be rebuildable from the log. This is the riskiest phase: operator gate, full verification, full test suite. If node:sqlite proves unfit, this phase reverts cleanly to better-sqlite3 behind the same port (the port is the insurance).

## Phase 3 — Standalone executable (SEA)

Compile the daemon to a single standalone executable per platform in CI — now clean, with no native addon to embed. Targets: win-x64, win-arm64, macos-x64, macos-arm64, linux-x64. (linux-arm64 / Raspberry Pi is optional — include only if a family machine needs it.)

## Phase 4 — Tauri sidecar bundling

Bundle the compiled daemon executable as a Tauri `externalBin` sidecar in `governor/tauri.conf.json`. The Governor installer now carries the daemon; Governor starts/stops/supervises it (extends its existing ADR-033 role). One signed installer per OS = a complete stavR.

## Phase 5 — MSI installer

Add a WiX `.msi` to `.github/workflows/governor-release.yml`: `bundle.targets` explicitly includes `msi`; the CI runner gets the WiX toolchain. `.msi` alongside the existing `.exe`.

## Phase 6 — Windows Service boot persistence

Replace the PM2 registry-Run-key boot mechanism with a real **Windows Service** — the daemon (via the Governor sidecar) starts at boot, before interactive login, auto-restarts on failure. Use WinSW or equivalent. Uninstall the errored `pm2-windows-startup` module. This closes the 2026-05-19 "didn't come back after reboot" defect and the errored-module loop.

## Phase 7 — Family-pack installer layer

The pre-configured installer layer (option #10): one installer that pre-seeds the family configuration (peers.yaml entries, default profile) so a family member runs it and the daemon is immediately part of the federation — no terminal, no config files. Build on the Phase 4 installer.

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
- PR 5 — Phases 5-6 (MSI + Windows Service).
- PR 6 — Phase 7-8 (family-pack + verification).

Operator reviews and approves each before the next.

## Definition of done

1. Zero SQLite calls outside the `src/db/` port; the `cli.ts` cast is gone.
2. The daemon runs on node:sqlite; the SQLite projection rebuilds from the event log.
3. The daemon compiles to a standalone per-platform executable in CI.
4. One signed installer per OS (`.msi` + `.exe`) carries the daemon as a Governor sidecar.
5. The daemon runs as a Windows Service — survives reboot, pre-login; `pm2-windows-startup` is gone.
6. The family-pack installer gives a non-technical family member a double-click install.
7. Full test suite green; install smoke passes on a clean target.

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
