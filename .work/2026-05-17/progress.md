# v0.4 visible-value bundle — overnight run 2026-05-17

## Context notes

Several reference files in OVERNIGHT_TASK_2026_05_17.md were not present in the
repo at the start of this run:

- `CLAUDE.md` — absent at repo root
- `docs/stavr-progress-and-plan.md` — absent
- `design-mockups/dashboard-mockup-v8.html` — absent
- `design-mockups/README.md` — absent
- `memory/SESSION_2026_05_16.md` — absent (only `project_stavr_runtime_toggles.md`
  found in `memory/`)

The v8 visual refresh (Phase 3) is therefore implemented from the textual
description in the brief plus the existing tokens / page structure in
`src/dashboard/` — no canonical mockup HTML was available to copy verbatim.
The visual language stays close to the existing Dark 2.0 tokens with the
additions called out in §3.2 (rust-glow, bg-popover, backdrop blur).

The MCPs registry static list (Phase 4) was hand-curated from public knowledge
of the github.com/mcp directory — there is no `memory/SESSION_2026_05_16.md`
snapshot to draw from. Entries are best-effort and the URLs reflect the
public directory structure; users should refresh the list when github.com/mcp
publishes a stable export.

## Phase log

- Phase 1: branch + scaffold — done
- Phase 2: OllamaProvider + profile routing + observability — done
- Phase 3: Dashboard v8 visual refresh — done (no canonical mockup HTML to copy verbatim — visual language derived from §3 textual brief + existing Dark 2.0 tokens with the v8 rust + glass additions in §3.2)
  - `src/dashboard/tokens.ts`: added v8 palette (`--rust`, `--rust-soft`, `--rust-glow`, `--bg-popover`, `--glass-blur`, `--health-{ok,warn,down}`).
  - `src/dashboard/components/floating-inspector.ts`: single global popover, anchored via `getBoundingClientRect`, glass-blurred, Escape + outside-click dismiss. Exposes `window.__stavrFloatingInspector.openAt / .close`.
  - `src/dashboard/components/timeline.ts`: fixed-bottom 44px smooth SVG path with cubic-bezier interpolation, rust gradient fill, multi-color stroke, event dots at significant moments, pulsing "now" cursor. Polls `/dashboard/home/data` every 5s.
  - `src/dashboard/components/watchdog-pip.ts`: top-rail health pip that reads `/healthz` (5s) + `/metrics` (30s) using the same regex-against-text-format-prom path an external scraper would — no in-process shortcut. Combined health green/yellow/red.
  - `src/dashboard/shell.ts`: mounts the three new shell-level components once each, adds `topnav-right` slot for the pip, expands `DashboardPageId` with `helm` + `mcps`, separates NAV_ENTRIES from LEGACY_NAV_ENTRIES (the latter keeps `/dashboard/home` reachable for v0.3 bookmarks).
  - `src/dashboard/pages/helm.ts`: new 5-band v8 page (L4 INTENT · L3 PLANS · L2 WORKERS · L1 TOOL CALLS · L0 SYSTEMS). Workers row is clickable dots, sys-chips are clickable, L4 intent opens a steward-sheet placeholder via the floating inspector.
  - `src/dashboard/pages/topology.ts`: central node rewritten as a rust daemon disc with rune (ᛋ) + pulse rings; mode-switcher chips (RADIAL active · HEAT/HISTORY placeholders for v0.5). Layout adapter untouched.
  - `src/dashboard/index.ts`: `/dashboard` now 302s to `/dashboard/helm`; legacy `/dashboard/home` continues to serve the v0.3 page. helm + mcps wired into the renderer map.
  - `src/transports.ts`: new `helmData()` + `mcpsData()` aggregators; `helmData` reuses `homeData()` memoization so the Helm page costs no extra broker reads.
  - Tests updated for the redirect change + the topology central-node rename. New tests: helm (8 cases), floating-inspector (4 cases), watchdog-pip (4 cases). Topology test gains a v8 mode-chip assertion.
  - Full suite: 521 passing / 1 pre-existing skip.
- Phase 4: MCPs page — done (page + registry + route wiring shipped with Phase 3 because the dashboard nav routes referenced it; this phase added the dedicated test coverage)
  - 30-entry registry in `src/dashboard/data/mcp-registry.ts` (acceptance criterion: ≥25 servers).
  - Browse / Installed / Auth-needed tabs with client-side search + sort + category filter.
  - Install action is a v0.4 placeholder: clicking opens a floating-inspector explaining the manifest.yaml workaround. Real install flow is v0.6+ (OAuth 2.1 + RIs, ADR-035 phase 1).
  - 8 new tests in `tests/dashboard/mcps.test.ts`.
- Phase 5: Capture ⊕ + Settings sub-pages + per-profile capability matrix — done
  - `src/persistence.ts`: new `runtime_toggles` table + EventStore methods (`getRuntimeToggle`, `setRuntimeToggle`, `listRuntimeToggles`, `deleteRuntimeToggle`, `pruneExpiredRuntimeToggles`). Idempotent schema migration; expiry is enforced on the read path.
  - `src/observability/debug-endpoints.ts`: `isDebugEnabled` now consults a `readToggle` callback BEFORE the env-var fallback. Per-endpoint subkeys (`STAVR_DEBUG_HEAP`, `STAVR_DEBUG_CPU`, `STAVR_DEBUG_REPORT`) layered on top of the master `STAVR_DEBUG_ENABLED`. Each successful capture emits a `{heap_snapshot,cpu_profile,diagnostic_report}_taken` audit event. Guard still returns 404 on a closed gate — preserves the no-information-leak posture from ADR-031.
  - `src/event-types.ts` + `src/observability/retention.ts`: added six new audit-class kinds (`runtime_toggle_changed`, `runtime_toggle_expired`, `heap_snapshot_taken`, `cpu_profile_taken`, `diagnostic_report_taken`, `capture_filed`) so they survive 90-day audit retention.
  - `src/daemon.ts`: 60s background sweep evicts expired runtime toggles, emits `runtime_toggle_expired` per eviction.
  - `src/tools/capture.ts`: `fileCapture()` writes JSONL to `~/.stavr/captures/<type>.jsonl` per the v0.4 routing model. Type + priority validated.
  - `src/transports.ts`:
    - `POST /dashboard/capture` — body `{comment, type, priority, snapshot, related_id?}`; writes via `fileCapture` + emits `capture_filed`.
    - `GET/POST /dashboard/settings/runtime-toggles` + `DELETE /dashboard/settings/runtime-toggles/:key` — toggle CRUD, each mutation emits `runtime_toggle_changed`.
    - Background `refreshOllamaModels()` every 60s populates `ctx.ollamaModels` for the Capabilities matrix.
    - `mountDebugEndpoints(app, { readToggle, emitEvent })` wired so the guard sees the runtime toggle row and each capture lands on the event log.
    - `settingsData()` returns `runtimeToggles` + `recentDiagnostics` (last 24h).
  - `src/dashboard/components/capture-button.ts`: floating ⊕ FAB + modal with comment + type/priority radios + Send. Snapshot gathered client-side from `/healthz` + `/metrics` (the same protocol surface a tray companion uses).
  - `src/dashboard/pages/settings.ts`: Captures sub-section (route config, read-only for v0.4) + Diagnostics sub-section (3 toggle rows × switch + countdown + take-now + recent diagnostics list).
  - `src/dashboard/pages/capabilities.ts`: v0.4 Steward pinned card (rune + model dropdown including Ollama models) + 14×3 capability matrix (capability rows × Turbo/Balanced/Eco columns). Each cell is a clickable button → floating inspector with the candidate model list. Missing local models flagged with a `!` warning marker. The original baseplate stays below.
  - `src/dashboard/shell.ts`: Capture button mounted once across the shell + CSS/JS wired.
  - Tests: 33 new across `tests/observability/runtime-toggles.test.ts`, `tests/observability/debug-endpoint-guard.test.ts`, `tests/tools/capture.test.ts`, `tests/dashboard/capture.test.ts`, `tests/dashboard/settings-diagnostics.test.ts`, `tests/dashboard/capability-matrix.test.ts`.
  - Full suite: 562 passing / 1 pre-existing skip.
  - `src/steward/providers/ollama.ts`: provider with `/api/chat` (non-stream) + `listAvailableModels()` via `/api/tags`. Mock tool-call mapping, system-prompt + multi-turn message mapping, AbortController-based timeout. Observability via `recordProviderRequest` + `recordProviderLatency` in finally block.
  - `src/observability/metrics.ts`: added `stavr_provider_requests_total` counter + `stavr_provider_latency_seconds` histogram with `{provider, model, status}` labels. Model-label cardinality kept bounded via truncation.
  - `src/types/stavr-bom.ts`: added four `local-*` capability tags as union members; added `LOCAL_FRIENDLY_TAGS` and `isLocalModel()` helpers. Routing tables updated for all three profiles per brief §2.3: Turbo never local, Balanced local for `cheap-classifier` + `simple-summary` + `local-*`, Eco local-first across every local-friendly tag. Frontier fallback retained in every Balanced row.
  - `src/steward/planner.ts`: extended `estimateStepCost` + `estimateStepDuration` for the four local-* tags; added Ollama models to the price table (zero per-token cost); updated planner LLM system prompt to include the new tags.
  - `src/daemon.ts`: lazy singleton `getOllamaProvider()` for dashboard consumption + `_resetOllamaProviderForTests()` test seam. The Steward subprocess still selects one primary provider per `steward-config.yaml`; cross-provider step routing is a v0.5 portability concern (ADR-032).
  - Tests: 37 new — `tests/steward/providers/ollama.test.ts` (7 cases: happy path, tool_calls, error mapping, listAvailableModels, host trim, message mapping), `tests/steward/planner-routing.test.ts` (matrix invariants across all three profiles), `tests/observability/ollama-metrics.test.ts` (Prometheus label assertions).
  - Full suite: 502 passing / 1 pre-existing skip.
