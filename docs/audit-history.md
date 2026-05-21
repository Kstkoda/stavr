# Audit history — operator guide

> `/dashboard/history` is the operator's window into what stavR has done in their name. It's the read-only, retrospective companion to `/dashboard/streams` (live tail) and `/dashboard/decide` (gate UI).

The page exists because data lives in too many places — decisions in SQLite, BOMs in `proposed/*.md`, scopes in `trust_scopes`, host_execs in `events`, commits in git, CI runs on GitHub. Operators couldn't ask "what was happening between 10:00 and 11:00 on 2026-05-17?" without context-switching across six tools. The history dashboard merges all of them into one chronological view.

This guide is built around the questions operators actually ask.

---

## Worked examples

### "What did Cowork-Claude do today?"

1. Open `/dashboard/history`.
2. Pick **Today** in the range picker.
3. In the actor-filter dropdown, choose **cowork-claude**.
4. The timeline narrows to every row attributed to Cowork-Claude — decisions it answered, scopes it proposed, host_execs it issued.

The filter persists in localStorage, so the next time you load the page it's still set.

### "Why did CI fail at 10:45?"

1. Pick **24h** in the range picker.
2. Click the **CI** tab.
3. Find the failed run at 10:45.
4. Click the row — the side drawer opens with the run details + the row's ↗ button takes you to the GitHub Actions UI.
5. Click the trace button (⤢) on the row to walk **forward** from the originating commit and see the host_exec calls that produced it.

### "Show me all scope grants from yesterday."

1. Pick **Custom** in the range picker.
2. Set the date range to yesterday's date.
3. Click the **Scope** tab.
4. The timeline lists every scope event in the window, with a status pill (proposed / active / completed / expired / revoked).

### "Find the BOM that produced PR #31."

1. Click the **BOM** tab.
2. Type `v0.5` in the search box (or any other BOM-name fragment).
3. Click the matching row — the side drawer renders the BOM markdown inline.
4. If the file has been deleted from `proposed/`, the drawer shows a "BOM file no longer on disk" placeholder with the original filename preserved.

---

## Correlation tracing

Every row that carries a `correlation_id` has a small ⤢ button on the right. Clicking it opens the **trace drawer** — a chronological chain of events that share that correlation_id.

Two directions:

- **Forward** (default for non-notification rows): walks downstream from the origin. Useful when reviewing a dispatch's outcome.
- **Backward** (default for notification rows): walks upstream to the originating operator action. Useful when a notification arrives and you want to know "where did this come from?".

The **Switch direction** button at the top of the trace drawer flips between the two; the operator can scrub either way from any node.

Notification rows show a hop-depth chip (`↩ N hops`) on hover so you can gauge "is this a leaf notification or does it trace far back?" without opening the drawer.

---

## Retention

History is bounded by [ADR-030](../adr/030-event-retention-and-dashboard-caching.md) — the default operational retention window is 7 days, audit-class events are kept for 90 days. If you pick a Custom range that crosses the retention boundary you'll see the "Earlier history pruned" hint at the bottom of the panel.

To shrink or extend retention, set `STAVR_EVENTS_OPERATIONAL_RETENTION_DAYS` / `STAVR_EVENTS_AUDIT_RETENTION_DAYS` on the daemon process.

---

## Read-only invariants

The history surface never writes. Every endpoint under `/dashboard/api/history/*` returns 405 for POST / PUT / PATCH / DELETE. The fetchers in `src/dashboard/data/history/` only execute SELECTs; the negative-path test asserts this contract.

If you want to act on something you find in the history (revoke a scope, retry a BOM, etc.) navigate to the page that owns that surface — `/dashboard/settings`, `/dashboard/plans`, `/dashboard/decide`. History is for retrospective; action lives elsewhere.

---

## Adding new event kinds (universal-signal-trace)

The page is structured around `HISTORY_KIND_REGISTRY` in `src/dashboard/components/timeline-row.ts`. To add a new kind:

1. Extend the `HistoryKind` union in `src/dashboard/data/history/types.ts`.
2. Register the kind in `HISTORY_KIND_REGISTRY` with a label + icon + color.
3. Add a fetcher under `src/dashboard/data/history/` that returns `HistoryPage<HistoryItem>`.
4. Wire the fetcher into `historyData()` in `src/transports.ts`.
5. (Optional) Add a detail renderer in `src/dashboard/data/history/detail.ts` for the side drawer.

The walker is kind-agnostic — it threads on `correlation_id`, so new kinds become walkable the moment they carry one. This is the foundation for [ADR-041](../adr/) (universal-signal-trace roadmap): LLM-calls, DB-queries, MCP-traffic, and federation-traffic all become history tabs without walker changes.

---

## See also

- [ADR-030 — event retention](../adr/030-event-retention-and-dashboard-caching.md)
- [ADR-031 — observability architecture](../adr/031-observability-architecture.md)
- `proposed/v0_8-audit-history-dashboard-bom.md` — the original BOM
- `src/dashboard/data/history/` — fetcher source code (every file commented for archaeology)
