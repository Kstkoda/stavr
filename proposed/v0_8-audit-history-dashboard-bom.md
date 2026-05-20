# stavR · v0.8 — Audit History Dashboard

> Mid-size PR (split into 2). Adds `/dashboard/history` — a single chronological + correlation-id-threaded view across decisions, trust scopes, BOMs, plans, host_exec calls, commits, PRs, and CI runs. Closes the "I can't go back and see what happened" gap exposed by today's revert-then-merge cascade. Pure read-only UI over existing data sources; no schema changes, no writes.

## Refresh note (2026-05-20)

This BOM was written in the v0.5/v0.6 era and its baselines are stale. It is **still valid** — the audit-history dashboard concept is sound and arguably more relevant now — but CC must treat the following as superseded:

- **Test baseline:** the "≥788 passing" figure below is obsolete. Current baseline is ≈1401 passing as of 2026-05-20. CC: capture the live `npm test` count at Phase 0 (P0) and use *that* as the regression floor.
- **PR / commit references:** the PR #30/#31/#32, "v0.6 PR #1", and commit-SHA references in the Context and P0 sections are historical examples, not current state. Ignore them as instructions.
- **Base:** branch off **current `main`** (which now includes v0.6.12, v0.7, the ADR-044/045 closeout, and the observability spec) — not any v0.5/v0.6-era HEAD.
- **Sensitivity:** keep `routine` (still read-only UI), but per the 2026-05-20 verification-window memory, run a `targeted` verification window, not "smoke".
- **Cross-ref:** the observability metrics spec (`proposed/observability-metrics-spec.md`) and the Diagnostics rebuild (task #72) now exist — the History page should reuse, not duplicate, any shared data-fetcher patterns.

The phase structure, file plan, and acceptance criteria below remain correct.

**Estimated wall-clock**: 7–9 hours CC sequential across 2 PRs.

**Sensitivity**: `routine` — read-only UI, reversible, no infra impact. CC follows standard autonomous flow per CLAUDE.md section 9.

**Stop conditions**: end of any phase if `npm test` regresses (must stay at or above the live baseline captured at P0 — ≈1401 as of 2026-05-20, NOT the stale "788" figure), `npm run build` fails, or new History page violates the "no writes from this surface" invariant.

**Do NOT pause for approval** between phases within a PR. Open PR at end of each phase-group (2 PRs total).

---

## Why this matters

Today's incidents exposed the gap concretely:
1. CC opened PR #30 (revert) and PR #31 (v0.5) — operator had no single timeline showing "here's the sequence of events that produced these PRs"
2. Cowork-Claude proposed trust scopes via MCP — operator saw them in pending panel but couldn't easily review prior scopes, their action logs, or what they were used for
3. v0.6 notifications BOM was committed to `proposed/` but operator had no dashboard link — relied on knowing the filename
4. CI failed on `5074630` after merge — operator had to dig through GitHub Actions UI to find the cause
5. The revert-then-merge footgun came from history operator couldn't easily inspect — if there were a "show me all commits on main from 2026-05-17 with their CI status + their originating PRs" view, the stray-commit pattern would have been caught faster

The shared issue: data exists in 6+ different stores (SQLite tables, files, GitHub, event stream) with no unified browser.

**Lex Insculpta posture**: "I shall not act unseen" requires the operator to be ABLE to see. A retention-aware audit dashboard is the operator's window into what's been done in their name. Without it, transparency is theoretical.

---

## Reference reading

1. `CLAUDE.md` — invariants (tests-are-derivative + never-lose-files + status-before-git-op + sensitivity flag)
2. `adr/030-event-retention-and-dashboard-caching.md` — retention model (define how far back history can show)
3. `src/dashboard/pages/streams.ts` — current live-tail of events, the data shape to extend backward in time
4. `src/dashboard/pages/decide.ts` — current pending-decisions view, mirror its layout for historical decisions
5. `src/dashboard/pages/settings.ts` — current active+pending scopes, extend with historical
6. `src/persistence.ts` — schema for decisions, trust_scopes, events, plans
7. `src/dashboard/data/*` — existing data fetchers; extend, don't duplicate
8. Memory: `project_stavr_four_tier_approval_model.md`, `feedback_git_status_before_every_op.md`

---

## Don't touch

- ANY write surface (decisions creation, scope grants, BOM dispatching) — this page is read-only
- `src/persistence.ts` schema — no new tables, no ALTER COLUMNs; reuse existing
- `src/security/*` — no auth/trust changes
- `src/steward/decisions.ts` decision creation — read it via existing fetchers only
- `src/dashboard/shell.ts` topbar layout EXCEPT adding one new nav link "History"
- Other dashboard pages — no changes to helm/topology/diagnostics/decide/streams/settings
- `ecosystem.config.cjs`, `package.json` deps — no new runtime deps. Frontend chart/table libs OK if already present.

---

## Hard rules

1. **Tests are derivative** — if any existing dashboard test asserts on the topbar nav having exactly N items, extend the assertion to N+1
2. **Never lose files** — `stat -c %s` + `tail -5` verify before commit for any file >15KB
3. **Read-only over all data sources** — every fetcher in `src/dashboard/data/history*.ts` MUST be read-only. Negative-path test: attempt a write through any history endpoint → 405 Method Not Allowed
4. **Use existing data fetchers** — don't duplicate. Extend with `?since=` + `?until=` params or wrap them
5. **Status-check before git ops** (CLAUDE.md section 8) — applies to every CC commit in this BOM
6. **Pagination is mandatory** — events table is ≥10k rows in any non-trivial deployment; never SELECT * without LIMIT
7. **BOM files (`proposed/*.md`) may have been deleted** — file reads must gracefully handle ENOENT; show "BOM file no longer on disk" placeholder, not crash
8. **DCO -s, per-phase commits, push at end of each phase. One PR per phase-group (2 PRs)**

---

## Phase-group structure (2 PRs)

| PR | Phases | Scope | Wall-clock |
|---|---|---|---|
| #1 — Backend + basic timeline | P0, P1, P2, P3 | History fetchers + `/dashboard/history` page with chronological view + type tabs | 4–5h |
| #2 — Correlation + UX | P4, P5, P6 | Correlation-id threading + search/filter + deep links + docs | 3–4h |

Each PR is independently merge-able: PR #1 ships a working historical browser; PR #2 adds the threading + UX polish.

---

## P0 · Pre-flight (Kenneth, before CC kicks off)

~3 min. Operator confirms:

1. `git status` clean on `main`, current HEAD includes `38554e6` (autonomy test fix) — CI green
2. `npm test --run` baseline = 788 passing (787 from v0.5 + 1 from autonomy fix)
3. v0.6 PR #1 either merged OR on its own branch (don't conflict)
4. Dispatch CC with PR #1 brief (run prompt at bottom)

---

## P1 · Historical data fetchers (PR #1, 1.5–2h)

**Files**:
- `src/dashboard/data/history/decisions.ts` (new) — `fetchDecisionsHistory({since, until, limit, offset, status?})`
- `src/dashboard/data/history/scopes.ts` (new) — `fetchScopesHistory({since, until, limit, offset, status?})`
- `src/dashboard/data/history/boms.ts` (new) — reads `proposed/*.md` directory + parses frontmatter + cross-refs with dispatch events
- `src/dashboard/data/history/plans.ts` (new) — `fetchPlansHistory({since, until, limit, offset, status?})`
- `src/dashboard/data/history/host-exec.ts` (new) — extracts host_exec events from events table grouped by correlation_id
- `src/dashboard/data/history/commits.ts` (new) — reads git log from working tree via `git log --since --until --format=%H%n%s%n%ae%n%at`
- `src/dashboard/data/history/ci.ts` (new) — wraps existing GitHub workflow runs query
- `src/dashboard/data/history/notifications.ts` (new) — `fetchNotificationsHistory({since, until, limit, offset, severity?, source?})` over the `notifications` table (from PR #32 schema)
- `src/dashboard/data/history/timeline.ts` (new) — merges all sources into a single sorted timeline
- `tests/dashboard/data/history/*.test.ts` (one per fetcher)

### Schema reuse (no new tables)

All fetchers read existing tables: `decisions`, `trust_scopes`, `events`, `plans`. BOM files come from `proposed/` directory. Commits via `git log`. CI via GitHub Actions API (cached).

### Pagination contract

Every fetcher returns `{ items: [...], next_cursor: string | null, total_estimate: number }`. UI pages forward; no offset>1000 (cap deep pagination to prevent table-scan abuse).

### Acceptance

- 8 fetchers, each with at least 3 tests (happy path, empty result, pagination boundary)
- All fetchers respect `since`/`until` ISO 8601 timestamps
- Timeline merger sorts by timestamp DESC, dedupes if same correlation_id appears in multiple source types
- Notifications fetcher exposes filter by `source_agent` (operator / steward-agent / cowork-claude / cc / federated peer) so operator can answer "who's been alerting me?"
- No fetcher executes a write (write attempt throws "history is read-only" error)
- `npm test` passes, build clean

### Commit
`feat(history): historical data fetchers across decisions/scopes/boms/plans/host-exec/commits/ci/notifications`

---

## P2 · `/dashboard/history` page (PR #1, 1.5–2h)

**Files**:
- `src/dashboard/pages/history.ts` (new) — main page render
- `src/dashboard/components/timeline-row.ts` (new) — single row component per item type
- `src/dashboard/components/range-picker.ts` (new or reuse from diagnostics) — date range selector
- `src/dashboard/shell.ts` — add "History" nav link between "Streams" and "Decide"
- `tests/dashboard/history.test.ts`

### UI design

`.glass` panel layout:

```
┌─ HISTORY ─────────────────────────────────────────────────────────────┐
│ Range: [Today] [24h] [7d] [Custom: ___]   Tab: [All ▾]   🔍 Search… │
│                                                                        │
│ ┌──────────────────────────────────────────────────────────────────┐ │
│ │ 14:54  📬 [steward-agent] Retrying with model fallback  ↩ 3 hops │ │ <- notification
│ │ 14:53  ⌨  test(autonomy): bump 100ms→250ms  38554e6  CI ✓        │ │ <- commit
│ │ 14:53  🔑 scope granted to Cowork-Claude (ts-1c5e915d…)          │ │ <- scope
│ │ 14:50  🔑 scope proposed: Fix Windows CI flake                   │ │ <- scope
│ │ 14:45  ⌨  PR #31 merged: v0.5 portability                        │ │ <- PR
│ │ 14:44  📜 CC dispatch: v0.6 notifications PR #1                  │ │ <- BOM/dispatch
│ │ 14:42  ⚖  decision approved: github_merge_pr Kstkoda/...         │ │ <- decision
│ │ ...                                                                │ │
│ └──────────────────────────────────────────────────────────────────┘ │
│ [Load more ↓]                                                          │
└────────────────────────────────────────────────────────────────────────┘
```

- **Range picker**: Today / 24h / 7d / Custom (with date picker)
- **Type tabs**: data-driven from a registered event-kind registry (NOT hardcoded). Initial set: All / Decisions / Scopes / BOMs / Plans / Host-exec / Commits / CI / Notifications. Future event kinds per the universal-signal-trace roadmap (ADR-041) appear as new tabs automatically once their event kinds are registered — no dashboard code change required to surface them. Specifically: **LLM-calls** (prompt + response bodies for our universe only), **DB-queries** (actual SQL text + bound parameters issued by our daemon), **MCP-traffic** (inbound + outbound MCP tool calls), **Worker-events** (granular lifecycle), **Federation-traffic** (cross-stavR A2A — our side only; peer's internal universe stays private).
- **Row icons**: distinct icon per source type, registered alongside the event kind. Initial: gavel for decisions, key for scopes, scroll for BOMs, list-checks for plans, terminal for host-exec, git-commit for commits, check-circle/x-circle for CI, envelope/bell for notifications. Registry pattern means new kinds bring their own icon.
- **Status pills**: success/failure/pending/expired/revoked color-coded
- **Trace-depth badge** on notification rows: small chip like `↩ 3 hops` indicating the depth of the correlation chain (how many events back the originating trigger is). Helps operator immediately gauge "is this a leaf notification or does it trace far back?"
- **Source-agent badge** on notification rows: `[steward-agent]`, `[cowork-claude]`, `[cc]`, `[operator]`, or `[peer:<spawn>]` for federated. Operator sees at a glance who's been alerting them.
- **Hover**: shows correlation_id + actor (CC / Cowork-Claude / operator / steward-agent / federated peer)
- **Click on notification row**: opens **backward-trace drawer** (see P4) — walks the correlation chain from the notification BACK to its originating event (decision / scope / BOM dispatch / Steward strategy decision / etc.). Operator can scrub their way back through the causation chain even when the trigger came from far away (hours ago, or from a federated peer's machine).
- **Click on non-notification rows**: opens standard detail drawer (also see P4)

### Iron palette compliance

- All rows use `.glass` styling
- Status = halo ring on the type icon (ok/warn/crit)
- No red-as-status-on-row (use halo)
- Density target: 12-15 rows visible on a 1080p viewport without scroll

### Acceptance

- Page renders at `/dashboard/history`
- Default range = 24h, default tab = All
- Tab switching filters correctly
- Range picker triggers re-fetch
- Pagination "Load more" appends without flicker
- Topbar nav shows "History" link
- 6+ tests passing

### Commit
`feat(dashboard): /dashboard/history page with timeline + range picker + type tabs`

---

## P3 · Source links (PR #1, 1h)

**Files**:
- `src/dashboard/pages/history.ts` — wire click handlers
- `src/dashboard/components/source-link.ts` (new) — renders external/internal link with appropriate target

### Click-through targets

| Row type | Click action |
|---|---|
| Commit | Opens GitHub commit URL in new tab |
| PR | Opens GitHub PR URL in new tab |
| CI run | Opens GitHub Actions run URL in new tab |
| BOM | Opens BOM file from `proposed/` — markdown rendered inline in side drawer |
| Decision | Side drawer with full decision JSON + action log |
| Scope | Side drawer with full scope config + action history (uses existing `trust_scope_status`) |
| Plan | Side drawer with plan steps + execution log |
| Host-exec | Side drawer with command, args (redacted), exit code, stdout/stderr preview, duration, scope_id |

### BOM file rendering

Read file from `proposed/` directory via existing file-read util. Render markdown via `marked` or similar (already in deps for other dashboard pages — check before adding). If file no longer exists (deleted), show: "BOM file no longer on disk — only the dispatch event is preserved. Original filename: `proposed/v0_X-foo.md`."

### Host-exec redaction

`args` may contain commit messages with sensitive content (rare but possible). Cap args display to 200 chars per arg with "..." truncation. Full args available via "Show raw" toggle (operator-only, doesn't propagate to clipboard easily — discourages exfil).

### Acceptance

- All row types have working click-through
- External links open in new tab with `rel="noopener noreferrer"`
- BOM rendering handles missing file gracefully
- 4+ tests passing

### Commit
`feat(history): click-through navigation + side drawer for full context`

### Open PR #1

`feat(dashboard): /dashboard/history — timeline view across all artifacts (closes #X)`

Body must include:
- Screenshot of timeline at 24h range, All tab
- Screenshot of a BOM-row click showing inline markdown rendering
- Sample queries the operator can now answer (e.g., "what happened on 2026-05-17 between 10:00 and 11:00 UTC")

---

## P4 · Correlation-id threading (PR #2, 1.5–2h)

**Files**:
- `src/dashboard/data/history/correlation.ts` (new) — given a correlation_id, walk all related events across all sources and return ordered list
- `src/dashboard/components/correlation-thread.ts` (new) — drawer that renders the thread visually
- `src/dashboard/pages/history.ts` — extend row hover/click to surface correlation count + open thread
- `tests/dashboard/data/history/correlation.test.ts`

### Correlation walk — bidirectional

The walker supports both directions:

**FORWARD walk** (starting from origin, walking downstream — useful when reviewing a dispatch's outcome):
Starting from a correlation_id at its originating event, walk:
1. The originating event (often a decision or scope grant)
2. All host_exec calls tagged with that correlation_id
3. The commit(s) those host_exec calls produced
4. The PR(s) those commits became part of
5. The CI runs triggered by those PRs
6. The merge events (if any)
7. Any downstream notifications fired (v0.6)

**BACKWARD walk** (starting from notification, walking upstream — useful when operator gets a notification and asks "where did this come from?"):
Starting from a notification ID, walk:
1. The notification (terminal observation)
2. The `notification_requested` event (or other notifier-subscribed event) that triggered it
3. The publishing actor's prior action (Steward strategy decision, validation failure, scope grant, etc.)
4. That action's parent context (which BOM dispatched the work, which trust scope authorized it)
5. The originating operator action (which BOM the operator approved, which scope the operator granted)
6. Continue walking back until reaching a leaf with no parent correlation (typically an operator-initiated event)

Both walks return a directed acyclic graph; render flattened with indentation for the UI. The drawer header indicates direction: "TRACE FORWARD from origin" vs "TRACE BACKWARD from notification."

Backward walks are especially important for **distant notifications** — when Steward's strategy self-heal fires a notification 3 hours after the originating operator action, or when a federated peer's BOM dispatch produces a notification on the local machine. The chain might span hours and multiple actors; the backward walk lets the operator follow it to the source without manually correlating timestamps.

### UI

Side drawer or modal showing:
```
┌─ TRACE: ts-3dbc5c94 ─────────────────────────────────────┐
│                                                            │
│ 10:39  Scope proposed by Cowork-Claude                    │
│   ↓                                                        │
│ 10:40  Scope granted by dashboard-user                    │
│   ↓                                                        │
│ 10:41  host_exec git pull (exit 0, 1.4s)                  │
│ 10:41  host_exec npm run build (exit 2, 3.4s) ⚠           │
│ 10:42  host_exec git reset --keep 9a71a20 (exit 0)        │
│   ... (12 more host_exec calls)                            │
│   ↓                                                        │
│ 10:45  Commit 5074630: docs: 4-tier...                    │
│   ↓                                                        │
│ 10:45  CI run #25988678603 — FAILED                       │
│   ↓                                                        │
│ 10:54  Commit 38554e6: test(autonomy): bump...            │
│   ↓                                                        │
│ 10:56  CI run #25988903894 — IN PROGRESS                  │
└────────────────────────────────────────────────────────────┘
```

### Acceptance

- Correlation walker returns ordered DAG (both forward and backward modes)
- Walker is **kind-agnostic** — accepts any event ID or correlation_id as starting point, regardless of event kind. The walk logic depends only on `correlation_id` linkage, never on the kind enum. This is the foundation for the universal-signal-trace roadmap (future LLM-call, DB-query, MCP-traffic, peer-A2A event kinds will be walkable without walker code changes).
- Trace renders with proper indentation
- Click any node in the trace to expand its details inline
- Notification rows trigger backward-walk by default; non-notification rows trigger forward-walk by default
- "Switch direction" button on the drawer header inverts the walk (operator can scrub either way from any node)
- Hop-depth badge on the originating row reflects the actual chain length walked
- 6+ tests passing (including: backward walk from notification all the way to operator action, walk that crosses federated-peer boundary, walk that bottoms out at a system-initiated event with no operator parent, walk that starts from a non-notification non-decision event kind — proves kind-agnostic property)

### Commit
`feat(history): bidirectional correlation-id threading with backward trace from notifications`

---

## P5 · Search + filter polish (PR #2, 1–1.5h)

**Files**:
- `src/dashboard/pages/history.ts` — search bar above timeline
- `src/dashboard/data/history/search.ts` (new) — free-text search across decision titles, scope titles, BOM names, commit messages
- Filter persistence via `localStorage` (per Cowork artifacts pattern)
- `tests/dashboard/history-search.test.ts`

### Search semantics

- Case-insensitive substring match
- Searches: decision titles, scope titles, BOM filenames, commit subjects, host_exec command names
- Results limited to current range + tab filter (search is additive narrowing)
- Empty search = show all (current behavior)

### Filters persisted to localStorage

Keys: `stavr.history.range`, `stavr.history.tab`, `stavr.history.search`, `stavr.history.actor_filter`. Restored on page load. Cleared via "Reset filters" button.

### Acceptance

- Search filters timeline live (debounced 200ms)
- Filters survive page reload
- Reset button clears all filters
- 4+ tests passing

### Commit
`feat(history): search + persistent filters + reset`

---

## P6 · Docs (PR #2, 0.5–1h)

**Files**:
- `docs/audit-history.md` (new) — operator-facing guide: "how to answer 'what happened?' questions"
- `CHANGELOG.md` — v0.8 entry
- `CLAUDE.md` — reference under "Canonical references" table

### Operator guide content

Worked examples:
- "What did Cowork-Claude do today?" → filter by actor=Cowork-Claude
- "Why did CI fail at 10:45?" → click CI row in timeline → drawer shows triggering commit + parent scope/dispatch
- "Show me all scope grants from yesterday" → tab=Scopes, range=24h
- "Find the BOM that produced PR #31" → search "v0.5" in BOMs tab → click

### Acceptance

- First-time operator can answer the 4 example queries above without help
- v0.8 entry in CHANGELOG

### Commit
`docs(history): operator guide + changelog + canonical-refs entry`

### Open PR #2

`feat(history): correlation threading + search + persistent filters + docs (closes v0.8)`

---

## Budget

- **Time**: 7–9h CC sequential across 2 PRs
- **API cost**: ~$8–14 (medium surface; lots of test scaffolding; markdown rendering is the most novel part)
- **LOC change**: ~1,000–1,400 net across `src/dashboard/data/history/`, `src/dashboard/pages/history.ts`, `src/dashboard/components/`, `tests/dashboard/`, `docs/`
- **Token cap**: 800k (split across 2 worker runs)
- **New deps**: none (markdown render uses existing lib if present; otherwise inline a minimal-safe renderer)
- **Schema change**: none

---

## Footgun appendix

1. **Event volume** — production deployments may have >100k events. Always paginate. Use indexed columns (created_at, kind, correlation_id). Add indexes if missing (in a separate small PR, not this one).
2. **Correlation ID propagation gaps** — not every action has a correlation_id today (early events pre-correlation-ID adoption may be NULL). UI must handle NULL gracefully — show "no correlation" badge, don't try to thread.
3. **Timezone handling** — events timestamped UTC; display in operator's browser timezone. Date picker uses browser local. Pass `Intl.DateTimeFormat().resolvedOptions().timeZone` to fetcher only if needed for date-bucket boundaries.
4. **Deleted BOM files** — `proposed/*.md` files may be deleted via git operations (e.g., archived to a different folder). Fetcher must `try/catch` ENOENT and surface "file no longer on disk" placeholder. Don't fail the entire timeline render.
5. **Filter persistence + URL state** — localStorage persists across reloads, but URL doesn't reflect filters (no deep-linking). v0.8.1 candidate: sync to URL query params for shareable links.
6. **Search performance** — substring search across all sources runs in-memory after fetching. If results are slow, push to server-side `LIKE` query with limit. v0.8 starts with client-side, profile if needed.
7. **Markdown rendering XSS** — BOM files are operator-controlled, but rendering them in the dashboard must still sanitize (`marked` with `sanitize: true` or DOMPurify). Don't allow `<script>` from a BOM file to run in dashboard context.
8. **GitHub API rate limits** — CI runs fetched from GitHub Actions API are rate-limited (5000/hr for authenticated). Cache aggressively (15-min TTL acceptable for historical data — CI doesn't change retroactively).
9. **Long-running drawer scroll** — correlation threads can be 50+ items (today's session has runs in that range). Virtualize the drawer's scrolling.
10. **Side drawer escape key** — operator presses Esc, drawer should close. Don't trap focus.

---

## Open questions (FLAGGED — do not pre-answer)

### §1 — How far back can history show?

ADR 030 sets the event retention model (current default: 30 days). History page should respect that — render "earlier history pruned" message at the boundary.

**Default**: 30-day window per ADR 030, with operator-overridable max in settings if desired. Out of scope to change retention here.

### §2 — Should host_exec args be redacted by default?

Args may contain commit messages with PR descriptions, etc. — usually fine, occasionally sensitive.

**Default**: cap each arg display to 200 chars + "..." truncation. Full args via "Show raw" toggle. Don't redact full args by default — operator should see what was actually run.

### §3 — Should the page show actions by ANY actor (peers in federated stavR), or only this stavR's local actions?

ADR 035 introduces federated peers. v0.8 is single-spawn — show only local.

**Default**: local-only in v0.8. Federation widget (cross-spawn view) is a v0.9+ candidate aligned with ADR 035 phase 4.

### §4 — Should there be a "live mode" that auto-refreshes the timeline?

Like `/dashboard/streams` does today for events.

**Default**: not in v0.8. History is for retrospective. Streams is for live. Different surfaces, different purposes. If operator wants both, they can have both tabs open. v0.8.1 candidate if requested.

### §5 — Should the timeline show internal-only events (background polling, retention sweeps)?

These are high-volume and low-signal for human review.

**Default**: filtered out by default; "Show internal events" toggle in advanced filters surfaces them. Internal events kept in the events table; only the UI excludes them.

### §6 — Operator-only or anyone-with-credentials?

Today's stavR is single-operator. Future federated mode may have peers viewing the dashboard.

**Default**: operator-only in v0.8 (existing auth model). Federation may need per-page access control in v0.9+.

---

## Run prompt for CC (PR #1, paste at start)

```
Read CLAUDE.md first. Then read proposed/v0_8-audit-history-dashboard-bom.md and execute P0 (operator pre-flight) acceptance check followed by P1, P2, P3 sequentially.

Sensitivity: routine. Standard autonomous flow.

This BOM is read-only UI work over existing data sources — no schema changes, no writes. Fully reversible (Tier 2). The "I shall not act unseen" promise from Lex Insculpta is enforced by this dashboard.

Rules:
- Skärp och hängslen: BEFORE any git command that mutates state, run `git status --short` + `git symbolic-ref HEAD` first. Verify branch + working tree match intent. THEN run the command. (CLAUDE.md section 8 — bilateral rule.)
- One commit per phase, DCO sign-off (-s)
- Work on a NEW branch: `git checkout -b feat/v0.8-history` from main. Never commit to main.
- Don't pause for approval between phases inside this PR
- For any file >15KB after edit, run `stat -c %s file` + `tail -5 file` BEFORE git add
- `npm test` must pass after every commit
- After P3 opens PR, output a final delta report and STOP. Don't auto-merge. Don't proceed to PR #2 (P4-P6).

The brief is self-contained. Open questions §1-§6 are flagged — pick the conservative default during implementation and note in PR body, don't block.

Go.
```

## Run prompt for CC (PR #2, paste at start)

```
Read CLAUDE.md first. Then read proposed/v0_8-audit-history-dashboard-bom.md.

PR #1 (P1-P3) is merged. Your scope: P4 (correlation threading), P5 (search + filter persistence), P6 (docs). Open PR at end of P6.

Same rules as PR #1. Skärp och hängslen on every git op. Go.
```

---

## End of brief
