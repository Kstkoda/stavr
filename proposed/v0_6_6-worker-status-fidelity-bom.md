# stavR · v0.6.6 — Worker status fidelity (Helm + Topology + Streams reflect reality)

> Small-medium PR. Fixes the dashboard's biggest live lie: counters and status pills that don't reflect what's actually running. Discovered during the 2026-05-17 E2E test where Helm said "6 active" while 0 workers were actually executing, force-killed workers showed identical "terminated" status as cleanly-completed ones, and Topology counted 8 lifetime workers as if currently active.

**Estimated wall-clock**: 4–5 hours CC sequential. Single PR.

**Sensitivity**: `careful` per CLAUDE.md section 9. Touches shared status semantics consumed by Helm, Topology, Streams, Diagnostics — small surface but every page reads from it. Status check before every git op (CLAUDE.md section 8).

**Stop conditions**: end of any phase if `npm test` regresses (must stay ≥888+ passing after PR #33 + post-merge fixes), `npm run build` fails, or any acceptance test demonstrates the "active counter" can show > actually-running worker count.

**Do NOT pause for approval** between phases. Open PR at end of P4.

---

## Why this matters

The E2E test on 2026-05-17 spawned 4 workers (3 ran to completion, 1 was force-killed mid-run). Concurrent dashboard state showed:

| What dashboard claimed | What was actually true |
|---|---|
| Helm L2 "6 active workers" | 0 actually running, 5 terminated, 1 crashed (from 2 days ago) |
| All worker chips: "idle · ready" | Workers were terminated/crashed/just-killed — not "ready" |
| Helm L2 "1 stuck" | Nothing was stuck — likely an orphaned counter from May 15 zombies |
| Topology "8 workers · 0 bricks" | Counting 6 e2e + 2 May-15 workers as currently present |
| Topology worker roster | Showed force-killed worker as "terminated" (same as clean exit) |
| Streams page "2 panes" | Stale May-15 crashed/terminated workers shown as if they're current |

The operator literally cannot trust any worker-related number on the dashboard. This BOM fixes that.

---

## Reference reading

1. `CLAUDE.md` — invariants (tests-are-derivative + never-lose-files + status-before-git + sensitivity flag)
2. `adr/040-three-process-architecture.md` — three-party model; this work lives in Engine layer
3. `src/persistence.ts` — `workers` table schema (status enum, termination_reason, exit_code)
4. `src/dashboard/data/*` — fetchers Helm/Topology/Streams/Diagnostics use to read worker state
5. `src/dashboard/pages/helm.ts` — L2 WORKERS section render logic
6. `src/dashboard/pages/topology.ts` — graph counter + roster
7. `src/dashboard/pages/streams.ts` — pane render logic
8. `src/dashboard/pages/diagnostics.ts` — workers section
9. `src/workers/orchestrator.ts` (or equivalent) — worker lifecycle transitions

---

## Don't touch

- Worker spawn semantics (`src/workers/spawner.ts`, `worker_spawn` MCP tool) — separate concern (covered in v0.6.7)
- AV-block detection — that's v0.6.7's problem
- `src/security/*` — no scope changes
- `src/steward/*`, `src/notify/*` — out of scope
- The `workers` table schema except for one additive column in P1
- Existing tests for worker spawn, scope, notification — only update tests that assert on the broken status semantics
- The Streams page's *fundamental* shape (it's misnamed but renaming is bigger v0.7 scope) — fix the data it shows, leave the name

---

## Hard rules

1. **Tests are derivative** — existing tests that assert "if 6 workers exist, helm shows 6 active" are wrong by the new definition; update them in the same commit that changes the meaning of "active"
2. **Never lose files** — `stat -c %s` + `tail -5` for any file >15KB
3. **Status-check before every git op** — bilateral rule per CLAUDE.md §8
4. **Single source of truth for worker counts** — all four pages (Helm/Topology/Streams/Diagnostics) MUST read from the same fetcher with the same definitions. No page-specific "active" interpretation.
5. **Counters MUST distinguish lifetime vs current** — never display a single number that conflates them. Use "0 active · 7 completed · 1 crashed" style; never just "8 workers" without context.
6. **Force-killed MUST be visually distinct from clean-completed** — different status pill color + different label (`killed by operator` vs `completed cleanly`)
7. **No worker chips for items >24h old** in primary view (Helm/Topology canvas) — move stale workers to a "History" tab/section
8. **DCO -s, per-phase commits, push at end of each phase**

---

## P0 · Pre-flight (Kenneth, before CC kicks off)

~5 min:
1. `git status` clean on `main`; current HEAD includes the post-PR-#33 docs commit (`51fda61` or later)
2. `npm test --run` baseline = current passing count (likely 888 after the cumulative additions)
3. Verify the 2 May-15 zombie workers (`oom-leak-hunt-2026-05-15`, `leak-hunt-retry-a`) still in DB — they're the reference test data for "stale worker handling"
4. Dispatch CC

---

## P1 · Add `lifecycle_state` column + helper functions (1.5h)

**Files**:
- `src/persistence.ts` — add additive column to `workers` table
- `src/workers/lifecycle.ts` (new) — derived-state helpers
- `tests/workers/lifecycle.test.ts`

### Schema (additive only)

```sql
ALTER TABLE workers ADD COLUMN lifecycle_state TEXT;
-- nullable for backfill; helper functions handle NULL by reading status + termination_reason
CREATE INDEX idx_workers_lifecycle_state ON workers(lifecycle_state);
```

### Derived states (replace the existing `status` enum's mixed semantics)

```ts
type LifecycleState =
  | 'starting'              // spawn issued, process not yet confirmed up
  | 'running'               // process confirmed up, no exit yet
  | 'completed-clean'       // exited 0 of own accord
  | 'completed-error'       // exited non-zero of own accord
  | 'killed-by-operator'    // worker_terminate called
  | 'killed-by-system'      // OOM, AV, OS-level kill
  | 'crashed'               // exit code non-zero AND not killed (covers segfaults)
  | 'stale'                 // last_activity_at > 1h AND no exit AND not heartbeat-confirmed running
  ;

function deriveLifecycleState(worker): LifecycleState { ... }
function isCurrentlyActive(state): boolean {
  return state === 'starting' || state === 'running';
}
function isHistoric(state): boolean {
  return !isCurrentlyActive(state) && state !== 'stale';
}
```

### Helper functions for data fetchers

```ts
function fetchActiveWorkerCount(store): number   // currently-active only
function fetchLifetimeWorkerCounts(store): { active, completed, killed, crashed, stale }
function fetchWorkerHistoryWindow(store, sinceMs): Worker[]   // last N hours
```

### Acceptance

- `deriveLifecycleState` correctly maps all permutations (12 test cases including force-kill, AV-block-via-EPERM, OOM, regular completion)
- `isCurrentlyActive` returns true only for `starting`/`running`
- `fetchActiveWorkerCount` matches actual running PIDs (cross-check via OS query in test)
- 12+ new tests passing
- Existing `status` enum stays intact (not removed; lifecycle_state is additive)

### Commit
`feat(workers): lifecycle_state derived states + helpers for active vs historic`

---

## P2 · Wire fetchers across all pages (1.5h)

**Files**:
- `src/dashboard/data/worker-counters.ts` (new) — single source of truth
- `src/dashboard/data/worker-roster.ts` (new) — paginated roster with filters
- Edit existing data fetchers in `src/dashboard/data/*` to delegate to these

### Acceptance

- All four pages (Helm/Topology/Streams/Diagnostics) read counts from `worker-counters.ts`
- A grep confirms no page reads `workers.status` directly anymore
- Tests assert: Helm count == Topology count == Diagnostics count (single source)
- 5+ new tests passing

### Commit
`feat(dashboard): single-source worker-counters + roster fetchers consumed by all pages`

---

## P3 · Render fixes per page (1h)

**Files**:
- `src/dashboard/pages/helm.ts` — L2 WORKERS section: `0 active · 7 completed · 1 crashed` style display; worker chips use lifecycle_state for label + halo color
- `src/dashboard/pages/topology.ts` — header: `0 workers active · 0 bricks · 0 in-flight (lifetime: 8)`; roster shows lifecycle_state in pill (`killed by operator` distinct from `completed cleanly`)
- `src/dashboard/pages/streams.ts` — only show CURRENTLY-ACTIVE worker panes in main view; move historic ones to collapsible "History · N panes" section
- `src/dashboard/pages/diagnostics.ts` — Workers section reads from same source

### Iron palette compliance

- Status pill colors must match halo conventions per CLAUDE.md §5:
  - `running` / `starting` — green halo
  - `completed-clean` — neutral / dim
  - `completed-error` — amber halo
  - `killed-by-operator` — distinct pink/violet halo (operator action, not a failure)
  - `killed-by-system` — red halo
  - `crashed` — red halo
  - `stale` — yellow/amber halo

### Acceptance

- Visual diff (screenshot test) against the 2026-05-17 baseline showing each lifecycle state rendering distinctly
- Force-killed worker is visually distinct from completed-clean
- Helm L2 + Topology header + Diagnostics Workers section all agree on counts
- 6+ new tests passing (one per page + cross-page consistency)

### Commit
`feat(dashboard): per-page render uses lifecycle_state for chips + counters`

---

## P4 · Filter historic from primary views + "View history" link (1h)

**Files**:
- `src/dashboard/pages/helm.ts` — L2 WORKERS only shows currently-active chips + "View 24h history →"
- `src/dashboard/pages/topology.ts` — canvas only renders nodes for currently-active workers + "Show terminated (N)" toggle
- `src/dashboard/pages/streams.ts` — historic panes collapsed by default
- Link from L2 header to `/dashboard/streams?status=all` for full history

### Acceptance

- Helm L2 with 0 active workers shows "0 active · view history" — NOT chips for old workers
- Topology canvas with 0 active workers shows just the daemon hexagon — NOT 8 cluttered worker dots
- "Show terminated" toggle expands cleanly without re-layout jank
- 4+ new tests passing

### Commit
`feat(dashboard): primary views show only active workers + history toggle/link`

### Open PR

`feat(dashboard): worker-status fidelity — counters + pills + per-page consistency (closes v0.6.6)`

Body must include:
- Before/after screenshots of Helm L2 + Topology header + Streams panes (use the 2026-05-17 E2E test scenario as test data)
- "Bugs fixed" enumerated list referencing audit findings #1, #2, #3, #5, #7, #8, #11, #22
- Note: spawn-side bugs (AV detection, lifecycle-tracking for non-blocking sleeps) are covered separately in v0.6.7

---

## Budget

- **Time**: 4–5h CC sequential, single PR
- **API cost**: ~$5–8
- **LOC change**: ~700–900 net (mostly new files in `data/` + targeted edits to 4 pages + tests)
- **Token cap**: 600k
- **New deps**: none
- **Schema change**: 1 additive ALTER COLUMN

---

## Footgun appendix

1. **Migration is idempotent** — `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` pattern. Existing rows get NULL `lifecycle_state` which the helpers handle by deriving from `status` + `termination_reason` + `ended_at`.
2. **Avoid double-counting workers across types** — `cc` workers have different statuses than `shell` workers. The lifecycle mapping handles both via a discriminated union.
3. **Active heartbeat detection** — for long-running workers, an active heartbeat (last_activity_at within last 60s) should KEEP a worker in "running" even if no exit yet. Otherwise long-quiet workers get marked stale.
4. **The May-15 zombies** — these have NULL heartbeats and old timestamps; the fix should classify them as `stale` not `running`. Test specifically.
5. **PowerShell vs CMD spawn duration discrepancy** — Windows `timeout /t N /nobreak` exits immediately in headless mode (worker reports done in <1s). This is a worker-spawn bug, NOT a status-display bug; covered in v0.6.7. v0.6.6 just needs to correctly classify the resulting fast-exit as `completed-clean` not invent fake "running" time.
6. **Caching** — if any page caches the worker count (e.g., topbar polling), invalidate on `worker_*` events via SSE
7. **Iron palette pill colors** — use existing palette tokens; don't introduce new colors

---

## Open questions (FLAGGED — do not pre-answer)

### §1 — Should "stale" workers (last_activity > 1h, no exit) auto-transition to "killed-by-system" after some threshold?

Default: NO — staleness is a flag, not a kill. Operator may want to explicitly resolve via `worker_terminate` to get an audit event. Stale workers stay in DB until operator acts.

### §2 — Should the Helm L2 chip layout be redesigned for many active workers?

The 4-chip-per-row grid breaks at >12 active workers. Default: not in v0.6.6 — solve when operator actually has >12 active workers. Show "N active · view all" link beyond 12.

### §3 — Streams page rename ("Streams" → "Workers")?

Streams currently shows worker panes, not a generic event stream. Rename would be clearer. Default: NOT in v0.6.6 — bigger product question, defer to ADR conversation.

### §4 — Should `killed-by-operator` need a reason field in `worker_terminate` MCP?

Operator clicked Terminate — but why? Useful audit context. Default: NOT in v0.6.6 — additive concern; revisit.

---

## Run prompt for CC (paste at start)

```
Read CLAUDE.md first. Then read proposed/v0_6_6-worker-status-fidelity-bom.md and execute P0-P4 sequentially.

Sensitivity: careful. Status-check before every mutating git op (CLAUDE.md §8).

Work on a NEW branch: `git checkout -b feat/v0.6.6-worker-fidelity` from latest main. Never commit to main.

Rules:
- One commit per phase, DCO -s
- Don't pause for approval between phases
- For any file >15KB after edit, `stat -c %s file` + `tail -5 file` BEFORE git add
- `npm test` must pass after every commit
- After P4 opens PR, output final delta report and STOP. Don't auto-merge.

The 2026-05-17 E2E test session in `~/.stavr/captures/bug.jsonl` is the bug-list reference. Open questions §1-§4 are flagged — pick conservative default during implementation.

Go.
```

---

## End of brief
