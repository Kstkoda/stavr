# Audit 07 — Dead Code

> Unused exports, orphaned files, dashboard pages/routes nothing links to, unreachable branches, commented-out code, stale legacy CSS classes.

## Headline

| Category | Findings |
|---|---|
| Truly orphaned files (zero refs) | **1** — `src/dashboard/components/empty-state.ts` |
| Test-only exports (intentional) | 2 — `buildCopyString`, `_readGitShaForTests` in `src/dashboard/data/build-versions.ts` |
| Reserved-future imports (intentional, marked `void`) | 2 — `execSync`, `statSync` in `src/dashboard/data/build-versions.ts` |
| Parked UI elements (with `parked-pill` v0.7 badge) | several in `src/dashboard/pages/topology.ts` |
| Deprecated CSS classes (`topo-bus`, `topo-mode-chips`, `enterprise bus`) | 0 in active code (test/comment references only — verified clean) |
| Commented-out code blocks (5+ lines) | 0 |
| Unreachable branches (`if (false)`, `if (0)`) | 0 |
| Re-exports of nothing | 0 — all `export *` chains have non-empty targets |

The codebase is **very clean** on dead code. The single orphaned file plus a deprecated-but-still-loaded page module are the only true findings.

## 1. Orphaned files (zero references)

### `src/dashboard/components/empty-state.ts` — **DELETE**

Exports `EMPTY_STATE_CSS` and `renderEmptyState()`. Created during v0.6.12 Phase 8 (per header comment) but never integrated into any page. Zero refs in `src/` and `tests/`. ~80 lines.

**Action:** delete or wire into the placeholder pages (`about.ts`, `family-mode.ts`, `placeholders.ts`) that currently render static stubs.

## 2. Inactive page module

### `src/dashboard/pages/placeholders.ts` — **ARCHIVE OR DOCUMENT**

Was the v0.3 placeholder scaffold for the C1–C9 checkpoint approach. The exported `renderPlaceholderPage()` has zero external references. The module is still loaded (so the file isn't strictly orphaned) but it doesn't render any active page.

**Action:** add a header comment `// @deprecated — kept for backward-compatible imports; remove after v0.7` or delete outright and patch any stale imports.

## 3. Dashboard pages — all registered, no orphaned routes

Inspection of `src/dashboard/index.ts` against `src/dashboard/pages/`:

| Status | Pages |
|---|---|
| In `NAV_ENTRIES` (primary nav) | helm, topology, streams, plans, decide, toolkit, mcps, tools, permissions, capabilities, diagnostics, family-mode, settings |
| In `LEGACY_NAV_ENTRIES` (deep-linkable, not in nav) | home (v0.3 predecessor, kept for back-compat), about (v0.7 Phase 6, linked from family-mode + settings) |
| Sub-routes (diagnostics drill-down) | `/dashboard/diagnostics/engine` → `renderDiagnosticsPage()`; `/dashboard/diagnostics/{connections,workers,federation,alerts}` → respective `…Detail()` |

All pages have a route. None are import-only without a registration.

## 4. Parked UI elements (intentional placeholders)

`src/dashboard/pages/topology.ts:474-476, 550-551` — Add (+), Edit (✎), Restart, Disable buttons rendered with `disabled` + `<span class="parked-pill">v0.7</span>`. These are honest UI scaffolding (not dead code) but cross-reference audit/09 — several other dashboard interactive elements are *unlabelled* dead (e.g. Helm L4 Steward input, Topology Ping), which is the real dead-UI concern.

## 5. Test-only and reserved imports (keep)

| File | Item | Reason |
|---|---|---|
| `src/dashboard/data/build-versions.ts:120` | `export function buildCopyString(...)` | exercised by `tests/dashboard/build-versions.test.ts` — keep |
| `src/dashboard/data/build-versions.ts:223` | `export function _readGitShaForTests(...)` | underscore-prefixed test seam — keep |
| `src/dashboard/data/build-versions.ts:13-14` | `execSync`, `statSync` imports | marked `void` on lines 244–245 as reserved future fallback — keep but consider commenting why more visibly |

## 6. Deprecated CSS classes — clean

CLAUDE.md §1 calls out `topo-bus`, `topo-mode-chips`, and `enterprise bus` as deprecated. A grep across `src/` finds **only test assertions and comments** that mention them (and the comments document the removal). No active CSS or HTML uses them.

## 7. Commented-out code, unreachable branches, no-op re-exports

- **Commented-out blocks (5+ lines):** none.
- **`if (false)` / `if (0)`:** none.
- **`export * from './foo'` where foo is empty:** none. `src/steward-agent/autonomy/index.ts` re-exports from `reactive.ts` (3), `scheduled.ts` (5), `proactive.ts` (3); `src/steward-agent/runtimes/index.ts` re-exports from `types.ts` and `schemas.ts`. All targets carry exports.

## 8. Cross-references

| Concern | Other audit |
|---|---|
| Parked UI in topology vs. unlabelled dead UI elsewhere | audit/09 §Dead (12 elements without `parked-pill` badge) |
| `placeholders.ts` honesty scaffolding | audit/04 (80 placeholder markers — placeholders.ts is one of them) |
| `src/steward-agent/` exists as a parallel codebase to `src/steward/` | audit/01 §Notable divergences + audit/05 ADR-032 partial |

The second-order concern: `src/steward-agent/` is **not** dead code (it's the in-flight v0.5 cutover target), but until the cutover happens, the duplication risks drift. Worth noting in audit/10.

## Recommendations

| # | Action | Size |
|---|---|---|
| 1 | Delete `src/dashboard/components/empty-state.ts` (or wire it into placeholders / family-mode / about pages) | trivial |
| 2 | Decide on `src/dashboard/pages/placeholders.ts` — archive comment or delete | trivial |
| 3 | Add a CI grep that fails if `topo-bus`, `topo-mode-chips`, `enterprise bus` ever re-appear in non-test files | trivial |
| 4 | Track `src/steward-agent/` parallel codebase until v0.5 cutover; deferral is fine but flag in audit/10 | track |
