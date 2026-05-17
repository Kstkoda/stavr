# Storm Pass #2 — Remediation BOM

> Output of the Cowork-Claude UX storm pass on 2026-05-17 morning, against the v0.4.1 polish daemon (commit 8cf7845 + PR #27 pending-scopes panel). 60+ findings collected via Claude-in-Chrome (Edge), spanning every page + interactive element of the dashboard.
>
> Findings are clustered into 7 fix-groups, each dispatch-able as a single tight CC PR. Order is optimized for unblocking observability first, then operator clarity, then visual polish.

**Total findings**: 64 (some invalidated during testing — see `## Invalidated` section)
**Estimated remediation wall-clock**: 18–25h CC sequential across 7 PRs
**Single critical-path**: Scope/Decision Flow (Cluster 1) unblocks Steward's daily usefulness

---

## How to use this BOM

1. Read this file first (it's the index)
2. Pick a cluster, dispatch as its own CC run (each cluster has a self-contained brief at the bottom of its row)
3. Each cluster is independently revertable — no inter-cluster dependencies except as noted
4. After landing each cluster's PR, re-storm via Cowork to verify findings actually closed and no new findings emerged

---

## Cluster 1 — Scope/Decision Flow (10 findings · CRITICAL · 4–6h)

Steward currently APPEARS idle while BLOCKED on operator approval. Operator has no surface to triage pending actions other than digging into Settings. This is the architectural blocker that makes the dashboard a polite lie about Steward's state.

| # | Finding | Fix shape |
|---|---|---|
| F2 | Pending scopes only visible in Settings (PR #27 partial fix) | Extend to Decide + Helm topbar |
| F8 | `github_merge_pr` decisions don't surface in /dashboard/decide | Same surfacing logic as F2 — generalize for ALL `await_decision` types |
| F41 | Helm L4 "Steward is idle" while scope is pending grant | Read pending count, surface "Steward needs you · 1 pending" |
| F42 | Helm topbar `0 scopes` doesn't differentiate active vs pending | `0 active · 1 pending` |
| F43 | Decide page ignores pending scopes | Decide should be unified pending-actions feed |
| F44 | No notification badges on nav links | Decide nav link shows red dot/count when pending > 0 |
| F45 | Settings has Pending Scopes, Helm L3 lacks Pending BOMs | Add Pending BOMs symmetry |
| F47 | No "pending actions" summary on Helm | Helm topbar mini-feed of pending items |
| F48 | `steward_status` MCP tool times out | Investigate Steward subprocess responsiveness |
| F49 | "0 scopes" should read "0 active · 1 pending" | Same as F42 |

**CC brief**:
```
Implement unified pending-actions feed across the dashboard.
1. New backend endpoint GET /api/pending-actions returning { scopes:[], decisions:[], boms:[], total:N }
2. Helm topbar: replace "0 scopes" with mini-counter "0 active · {pending} pending" colored amber when pending > 0
3. Decide page: aggregate pending scopes + await_decisions + pending BOMs into one timeline. Each row clickable to detail
4. Nav: add red badge on "Decide" link when pending total > 0
5. Helm L4 INTENT: if pending > 0, replace "Steward is idle" with "Steward needs you · {n} pending action(s)" linked to /decide
Tests are derivative — update settings.test.ts assertions for the new aggregated query if needed.
```

---

## Cluster 2 — Modal / Drawer / Inspector UX (8 findings · HIGH · 3–4h)

Every interactive panel has a UX bug that breaks operator trust. Drawer doesn't close on Escape. Inspector overlays the thing you clicked. Numbers don't bind.

| # | Finding |
|---|---|
| F20 | Topology inspector shows skeleton "QPS — P95 — ERR — RETRY" when no node selected |
| F52 | Helm L4 inspector overlays the band it was opened from |
| F55 | Helm worker inspector STEP field empty when worker DID execute steps |
| F58 | Topology inspector mini-charts render lines but value labels show `—` |
| F59 | Topology drawer overlaps filter strip — hides LIVE toggle |
| F62 | Escape does not close inspector drawer |
| F51 | Watchdog status button click does nothing |
| F61 | Cluster background blobs render with no nodes inside (floating empty regions) |

**CC brief**:
```
Polish the drawer/inspector/modal UX across all pages.
1. Escape key MUST close inspector drawer (Helm + Topology + Diagnostics)
2. Topology drawer width = 320px max, positioned so it doesn't overlap the filter strip (push canvas inward instead)
3. Topology inspector: when no node selected, render empty state ("Click a node to inspect") instead of skeleton metric placeholders
4. Helm L4 inspector: position to the side, not overlay the band
5. Worker inspector: bind STEP field to last `worker_step_started` event
6. Topology mini-chart value labels: bind to last data point in series, not hardcoded "—"
7. Cluster background blobs: hide when type count = 0
8. Watchdog status button: either wire it to show the watchdog detail (PM2 status, last heartbeat, OOM headroom) or remove entirely
```

---

## Cluster 3 — Topology Data Adapter (6 findings · HIGH · 4–5h)

The topology page renders the v2 graph correctly, but the data layer doesn't bridge workers + MCPs + fleet peers from their actual sources. F16 was invalidated (workers DO render once you scroll), but the deeper issue is the adapter is incomplete.

| # | Finding |
|---|---|
| F17 | 0 MCPs detected — adapter doesn't read MCP registry |
| F18 | Worker chip count "2 active" but both are CRASHED/TERMINATED |
| F28 | Topology missing `stavr · spawn` node (Diagnostics fleet roster shows it) |
| F60 | Worker filter chip click has no visual confirmation of state change |
| F64 | Worker chip toggle ON doesn't restore worker visibility — state machine bug |
| F12 | Worker card fields (step/eta/uptime) empty even with running workers |

**CC brief**:
```
Fix the topology data adapter and filter state machine.
1. Read installed MCPs from the registry (mcp__switch__* enumeration). Render each as a node.
2. Read stavR fleet (primary + spawn + peers) from /api/fleet (or equivalent). Render spawn as a sibling core node.
3. Worker chip count: filter to status='running' or 'idle' only — CRASHED/TERMINATED workers shouldn't inflate the count
4. Filter chip visual: add an explicit "off" state (greyed out + crossed lines) vs "on" (color filled)
5. Filter chip toggle: when toggled back on, MUST restore previously-visible nodes — test the round-trip explicitly
6. Worker card adapter: bind step/eta/uptime from the latest worker_step_* event
```

---

## Cluster 4 — Cross-Page Consistency (7 findings · MEDIUM · 2–3h)

The dashboard contradicts itself across pages. Steward shown as opus-4.7 here, sonnet-4-6 there. Worker UUID abbreviated here, full there. Capture button works here, dead there.

| # | Finding |
|---|---|
| F39 | Topbar "steward · opus-4.7" vs Capabilities "STEWARD BRAIN: claude-sonnet-4-6" |
| F53 | L4 floating inspector PROFILE field shows `helm` (page slug) instead of `BALANCED` |
| F54 | Helm worker card vs inspector — abbreviated `9a9c32f134` vs full UUID |
| F57 | Topology core node label `stavR-primarythis · 7777` — missing separator |
| F63 | Capture (⊕) button works on Helm, dead on Topology |
| F46 | Helm RECENT DECISIONS filters by type — should be unified activity feed |
| F50 | Some await_decision tools never surface anywhere |

**CC brief**:
```
Pure consistency cleanup across the dashboard.
1. Steward model: single source of truth in profile config. Topbar + Capabilities + L4 inspector all read from it
2. L4 inspector PROFILE field: read from profile setting, not body[data-active-page]
3. Worker IDs: define one abbreviation function (first 10 chars of UUID), use it everywhere
4. Node labels: use " · " (space-bullet-space) separator consistently — fix `stavR-primarythis · 7777` → `stavR-primary · this · 7777`
5. Capture button: registered via shell.ts globally — confirm no per-page click-stop interception
6. RECENT DECISIONS query: union all activity types (scopes, decisions, BOMs, captures), not just merge decisions
```

---

## Cluster 5 — Mock Data Leak + Missing MCPs Surface (4 findings · HIGH · 3–4h)

Helm L1 TOP TOOLS shows `github.read_pr 412 · drive.write 304 · ollama.generate 247 · slack.post 170 · linear.create_issue 98` — those exact numbers are from my v8 mockup HTML, never overwritten by /metrics polling. The MCPs catalog has 1 entry (Postgres) when it should have dozens. Operator has no way to see what's actually connected.

| # | Finding |
|---|---|
| F9 | Helm L1 TOP TOOLS shows hardcoded mockup values |
| F25 | Diagnostics MCPS chart renders lines but roster says "0 registered" — chart may be synthetic |
| F36 | MCPs page only shows ONE candidate (Postgres) — catalog is sparse |
| F37 | No "installed MCPs" section anywhere — operator can't see what's connected |

**CC brief**:
```
Remove mockup data leak + expose installed MCPs.
1. Helm L1 TOP TOOLS: bind to /metrics tool_calls_total counter grouped by tool name, top 5. Remove the hardcoded array.
2. Diagnostics MCPS chart: verify data source — should be empty when MCPs=0
3. MCPs page: add "INSTALLED" section at top showing currently-registered MCP servers (name, version, status). Catalog browser below.
4. MCPs catalog: populate the install-candidates from a remote registry (registry.modelcontextprotocol.io or local catalog)
```

---

## Cluster 6 — Layout / Visual Polish (7 findings · MEDIUM · 2–3h)

Visual quirks that don't break function but break trust. Mystery waveform with no label. L3 squashed when empty. Toolkit canvas a wasteland.

| # | Finding |
|---|---|
| F7 | Helm L3 PLANS band squashes to zero when empty |
| F19 | Topology stavR-primary at bottom-center, not graph-center |
| F22 | Cluster blobs render with 0 nodes inside |
| F33 | Toolkit canvas huge empty space with no onboarding |
| F38 | Capabilities page sparse — only shows budget caps |
| F56 | **Mystery orange waveform at bottom of every page** — no label |
| F34 | Toolkit COLOUR KEY references deleted "bus" terminology |

**CC brief**:
```
Visual polish across all pages.
1. Helm L3 PLANS: grid-template-rows row 2 = minmax(220px, 1fr) — never collapse below 220px even when 0 BOMs
2. Topology default node position: stavR-primary at canvas center (50%, 50%), not bottom-center
3. Cluster blobs: hide when associated type count = 0
4. Toolkit empty state: replace double-empty-text with a single "Get started — install your first brick" CTA + 3-5 recommended bricks below
5. Capabilities page: add "CAPABILITIES" section above budget caps — list installed MCPs, available models, registered skills with counts
6. Bottom orange waveform: either label it ("EVENTS · LAST 60s") with axis OR remove entirely. Pick one in PR.
7. Toolkit COLOUR KEY: remove "connector (above bus)" / "below bus" entries — bus deleted in PR #24
```

---

## Cluster 7 — Hygiene + Quick Wins (11 findings · LOW · 2–3h)

Cleanup pass. Most are one-liners. Bundle as a single rapid-PR.

| # | Finding |
|---|---|
| F1 | Helm L0-L4 band-body clicks dead — only `.band-arrow` navigates |
| F4 | `.ts` files getting tagged as binary by git (`.gitattributes` fix) |
| F6 | Rename Streams page → Workers page |
| F13 | Helm RECENT DECISIONS shows PR #21 merge twice |
| F14 | PR #27 merge decision vanished without trace (same root cause as F8/F50) |
| F23 | Topology no edges/lines rendered (acceptable if no traffic) |
| F24 | Topology LIVE on by default — should default off when graph empty |
| F26 | Diagnostics donut shows "·" placeholder when no data |
| F31 | Streams shows only CRASHED/TERMINATED — no live workers (count consistency) |
| F35 | Toolkit two stacked empty states — unify |
| F40 | **Recurring working-tree corruption pattern after every PR merge** — investigate Cowork fs sync |

**CC brief**:
```
Single rapid PR. Each fix < 20 lines. Skip if any fix needs deeper investigation — file as separate finding.
1. Helm bands: add click handler on the .band[data-slot] itself, not just .band-arrow
2. .gitattributes: add `*.ts text eol=lf` + `*.tsx text eol=lf`
3. Rename src/dashboard/pages/streams.ts → workers.ts, route /dashboard/streams → /dashboard/workers (301 redirect), nav link update
4. Topology LIVE: default off when 0 nodes besides core
5. Diagnostics donuts: show "—" or "0" not "·" placeholder
6. Toolkit empty states: merge into one
7. F40: investigate but DO NOT auto-fix — needs operator review on Cowork-fs side
```

---

## Invalidated findings (3)

Tested live and confirmed working — removed from net count:

- **F10** ("Helm L1 THROUGHPUT shows `…`") — Histogram bars DO render visually; the `…` was a11y text fallback
- **F11** ("Helm L1 TRENDS shows `—`") — Sparklines DO render (qps + p95 ms lines visible)
- **F16** ("Workers don't render as topology nodes") — Workers DO render, were below initial viewport. F18 (count vs status) is the real issue

---

## Findings to file as GitHub Issues (deferred beyond next 24h)

These are too small or too systemic to BOM-cluster, but shouldn't be lost. File as issues so they're tracked:

- F40 (Cowork-fs working-tree corruption) — needs Anthropic-side or local investigation, not a CC fix
- F48 (steward_status MCP tool times out) — Steward subprocess responsiveness, fits v0.5 BOM scope
- F32 (positive UX note on Streams JSON inline) — file as `enhancement` to keep the pattern

---

## Execution recommendation

If you have ONE overnight CC dispatch window: **run Cluster 1 (Scope/Decision Flow)**. Unblocks Steward usefulness.

If you have TWO windows: 1 then **Cluster 3 (Topology adapter)**. Makes topology actually useful.

If you have FOUR: 1 → 3 → 2 (Drawer UX) → 5 (Mock data + MCPs).

Clusters 4, 6, 7 are polish — last priority but each is cheap.

---

## Discoverability note

This BOM lives in `proposed/` for now. After Cluster 1 ships, fold the unified-pending-feed approach into Steward v0.5 BOM as a hard requirement. After that, this whole file becomes historical reference — close out remaining findings as separate small PRs.

---

## End of brief
