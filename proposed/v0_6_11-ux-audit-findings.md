# UX Audit Findings — stavR Dashboard (2026-05-19)

**Author:** Claude (via Cowork + Chrome connector against live daemon at `127.0.0.1:7777`)
**Daemon version under audit:** post PR #47 (commit `b12e40d` on main); UI itself appears pre-PR-#45 (topology revamp NOT yet on main)
**For CC:** consume in v0.6.11 BOM Phase 6e — "Apply UX audit feedback"

This is a prioritized list. Items with **HIGH** are visible bugs affecting current operator experience; **MED** are polish/consistency issues; **LOW** are nice-to-haves. Items marked **[DECIDED]** are already locked in design memory — apply as specified.

---

## P0 — Bugs / data wrong (HIGH)

### B1. Diagnostics shows wrong daemon version
- Diagnostics page Section 0 "Build & Versions" shows `stavR daemon · v0.1.0 · 43d802b`
- Actual main is `b12e40d`, post PR #47
- `v0.1.0` is the package.json default that was never bumped; the version reader is reading the literal package.json field
- **Fix**: bump `package.json` version to actual semver (`0.6.11` after this PR lands) AND ensure the version reader is sourced from a single point of truth. Display the short commit hash from `git rev-parse --short HEAD` at build time, not from a stale recorded value.

### B2. Diagnostics shows Steward "unwired"
- Section 0 shows "Steward · unwired"
- Steward subprocess label later: "Steward subprocess · UNWIRED · ADR-032 §Decision 1"
- But `stavr-steward-agent` IS running per PM2 (id 1, 68 MB)
- This is the same gap as task #33 in the operator's task list ("Investigate why Steward isn't showing in port 7777 connections")
- **Fix scope for this BOM**: at minimum, the UI should distinguish "Steward subprocess process down" from "Steward subprocess up but daemon hasn't wired its planner contract." Today the UI conflates both as "unwired."

### B3. Section 3 in Diagnostics says "0 lifetime" workers; Streams shows 16
- Diagnostics: `Section 3 · Workers + scopes · 0 active · 0 lifetime`
- Streams: `0 active panes · 16 historic` (with full 16-worker history visible)
- Topology: `0 active · 16 lifetime · 0 bricks · 0 in-flight`
- **Two of three pages agree on 16, Diagnostics is wrong.**
- **Fix**: Diagnostics Section 3 reads from a different (probably stale or wrongly-scoped) data source. Wire it to the same `lifetimeCount` source as Topology + Streams.

### B4. Diagnostics page has NO memory/heap panel
- PR #47 shipped the `/dashboard/api/diagnostics/memory` endpoint but no UI consumer was added
- Operator explicitly expected this to surface visually after PR #47 merged — it doesn't
- **Fix (already in BOM Phase 4)**: add a memory section to Diagnostics showing live `heap_used`, `rss`, `external`, `arrayBuffers` consuming the new endpoint. Chart.js line chart over the last hour. Section header: "Memory" between Section 0 (Build & Versions) and Section 1 (MCP servers).

### B5. Streams page worker history shows "No output yet." for 14 of 16 entries
- Only 2 of 16 historic workers have any captured output in the dashboard view
- All 14 e2e/stress workers show `No output yet.` despite being marked `completed cleanly` or `terminated`
- Either output was never captured, or it's stored but not retrieved by this page
- **Fix**: verify the streams data fetcher actually queries `worker_stdout`/`worker_stderr` events from the event store, not just the worker metadata. If output IS persisted but unrendered, wire it. If output was never captured for shell-type workers, file as separate bug — out of scope for this BOM.

### B6. "Capture this" dialog renders on every page even when not opened
- Every page's accessibility tree shows a fully-mounted `dialog` element for the "Capture this — send to Steward" modal
- It's hidden visually (CSS) but the form fields, radios, buttons are all in the DOM all the time
- **Performance impact**: probably negligible. **Accessibility impact**: screen reader may announce all dialog fields on every page load.
- **Fix**: lazy-mount the dialog or use `inert` attribute when closed. Low priority.

---

## P0 — Topbar (HIGH)

### T1. [DECIDED] Logo deduplication
- Topbar accessibility tree shows TWO separate elements: `generic "stav"` AND `generic "STAVR"`
- Per memory file `project_stavr_helm_topbar_design_2026_05_19`: keep only `stav` + `ᚱ` inline wordmark. Drop the separate `STAVR` uppercase element.
- **Fix**: in shell.ts, remove the redundant logo/wordmark. Single source.

### T2. No version number visible (operator-requested)
- Operator: "we really [need] version number on the helm"
- Topbar should show `v0.6.11` (or current) somewhere near the wordmark, after BOM dedup
- **Fix (already in BOM Phase 5)**: render `stavᚱ v0.6.11` or a small version chip adjacent. Source: `package.json` version at build time, OR pass through the daemon's existing version endpoint (Diagnostics already exposes it, just need to surface in topbar).

### T3. Topbar `generic "daemon"` element of unclear purpose
- Between the wordmark and the steward/model display, there's a `generic "daemon"` element
- May be a label, a status indicator, or an artifact. Not interactive.
- **Fix**: investigate purpose; either remove (if cruft) or upgrade to a proper chip with semantics (probably the future Engine chip per the locked topbar design memory).

### T4. WATCH OK chip — rename pending v0.8 design
- Currently labeled `Watchdog status` with text `WATCH OK`
- Per locked memory: rename to `Engine` (single label always; color = status); but this is v0.8 Shadow-mode BOM scope, NOT this BOM
- **For this BOM**: leave as-is. Note for future.

### T5. Steward model display — operator likes it, keep
- Currently `steward · opus-4.7` as text generic
- Per locked memory: when Shadow-mode chips ship in v0.8, this becomes part of the mode chip popover (`Cloud · opus-4.7`)
- **For this BOM**: leave as-is, just ensure styling is consistent with the cleaned wordmark.

---

## P1 — Helm page (MED → DECIDED)

### H1. [DECIDED] L3 tier band too tall — sizing imbalance
- Operator: "still need balancing out of l0-l4, l3 takes alot of space"
- Decided via 10-3-1 (option #10): keep click-to-navigate, no expand interaction, FIX SIZING
- **Fix (BOM Phase 6d)**: single CSS grid `200px 1fr auto` per tier band + secondary 12-col body grid + equal-height bands across L4-L0 via `grid-auto-rows: 1fr` or explicit `min-height` per band. Big numbers, drill-down buttons, sub-labels should share an X-axis across all 5 tiers.

### H2. Trailing "·" in uptime line suggests broken UI element
- Helm header shows `uptime · 00:12 · 8344 events · 1 scope` but the spacing dots appear off-center; one dot looks like a hanging separator with no following element
- **Fix**: clean up the separator pattern in the Helm header; use a consistent separator component.

### H3. "balanced" appears twice in L4 INTENT band
- L4 band shows `● on track · profile balanced · 0 total BOMs · BALANCED`
- "balanced" lowercase AND "BALANCED" uppercase in the same line. Redundant.
- **Fix**: pick one. Lowercase is consistent with "on track" preceding it.

### H4. Recent decisions list could be more scannable
- Currently shows full PR titles inline; very long — overflows or wraps unpleasantly
- **Fix**: truncate to ~80 chars with `...`, full text in tooltip. Add status icon (✓ done, ✗ expired) before time stamp.

---

## P1 — Topology page (MED)

### TO1. [PREVIOUSLY DECIDED, MEMORIZED] Galactic-map canvas not wired to MCP registry
- Per existing memory: galactic-map canvas exists but data fetcher doesn't push MCP registry → nodes
- **For this BOM**: NOT scoped here — PR #45 is the topology revamp and it includes the data fetcher rework. PR #45 should be merged BEFORE this BOM starts.

### TO2. [PREVIOUSLY DECIDED] Worker roster + in-flight BOMs belong on other pages
- Worker roster (16 entries) currently lives on Topology — should move to Streams
- In-flight BOMs panel currently on Topology — should move to Plans
- **For this BOM**: covered by PR #45 OR by Phase 6b. Verify against PR #45 first.

### TO3. "v0.7" parked badges on Restart/Disable buttons confuse operator
- Inspector panel right pane has `Restart` button with `v0.7` badge, `Disable` button with `v0.7` badge, and `edit-mode` indicator also says `v0.7`
- Operator-facing badges advertising "coming in v0.7" make active functionality confusing
- **Fix (BOM Phase 6b)**: either hide v0.7 buttons entirely until they work, OR grey them out + tooltip "Available in v0.7".

### TO4. Time scrubber needs YouTube-style heatmap render
- Current: `<input type="range">` slider with "live" label
- Per memory followup: thickness ∝ event density per 1-min bucket, hover tooltip with event-kind breakdown
- **Fix (BOM Phase 6b)**: render heatmap behind the slider track.

### TO5. Ctrl+K search shortcut collides with browser omnibox
- Per memory followup: rebind to `/` (GitHub style); audit other shortcuts
- **Fix (BOM Phase 6b)**: rebind, add visible hint in search placeholder ("press /").

### TO6. "Reset layout" button has duplicate label
- Accessibility tree shows `button "Reset layout"` AND adjacent `generic "reset layout"`
- **Fix**: keep one accessible label, render visible text only.

---

## P1 — Streams page (MED)

### S1. History pane summaries lack output preview
- Each historic worker pane shows status + timestamps + raw JSON event payload, but most show `No output yet.`
- Even worker output is presented as raw JSON event payload, not as actual log text
- **Fix**: extract `payload.stdout` / `payload.stderr` from events and render as preformatted code blocks. Add an "Output" tab per pane.

### S2. Article-per-pane layout: 16 historic workers stack vertically with no summary view
- Each historic pane is a full article element. 16 of them = lots of scroll.
- **Fix**: collapse historic panes by default (banner row only); click to expand. Consider dense table view as default.

---

## P1 — Plans page (MED)

### PL1. Tab buttons have empty accessibility labels
- Tab list contains buttons with no accessible name; visible text "proposed · 0" / "running · 0" is in a child `generic`, not in button's a11y label
- Screen readers will announce as "button" with no context
- **Fix**: add `aria-label` to each tab button OR move text into button's accessible name pattern.

### PL2. Heading inconsistency: "Stavr — Plans"
- Plans heading is `Stavr — Plans`; other pages have just `Topology`, `Streams`, etc.
- **Fix**: rename to `Plans` for consistency.

### PL3. Casing inconsistency in same view
- Plans page mixes uppercase tab labels (`PROPOSED · 0`, `RUNNING · 0`) with lowercase status (`live · listening`)
- **Fix**: pick one. Match the dashboard's lowercase lean.

### PL4. Operator reports freeze on enter AND on leave
- In my audit, page rendered fast (no BOMs to render), so freeze is data-dependent
- **Fix (BOM Phase 0 + 1)**: profile with realistic BOM count via headless Chrome; root-cause and fix.

---

## P1 — Decide page (MED)

### D1. Decision detail metadata always expanded (no click-to-expand)
- Memory followup says rows should be clickable to inline-expand. Currently the full record (correlation ID, timestamps, deadline, responder, chosen, default, reason, options) is ALREADY shown for every row.
- **Fix (BOM Phase 6c)**: collapse detail by default; show only summary row (status badge, decision title, chosen option, responder, elapsed). Click row to expand via `<details>`.

### D2. Decision titles truncate poorly mid-word
- Long titles end with `...` mid-word
- **Fix**: truncate at word boundary or `text-overflow: ellipsis`; full title in tooltip.

---

## P1 — Tools page (MED — already in memory)

### TL1. [PREVIOUSLY DECIDED] github.* tools tagged "Other"
- Currently "No tools registered" — daemon in stdio-only mode or registry-wrap missed first session
- Once tools register: github.* should be "GitHub" category, not "Other"
- **Fix (BOM Phase 6a)**: add `github` to category map; rebuild category filter.

### TL2. No grouping when multiple categories present
- Page empty now but memory followup notes alphabetical mix across categories hard to scan
- **Fix (BOM Phase 6a)**: render tools grouped by category with collapsible headers.

### TL3. No visible tier hierarchy
- AUTO / CONFIRM / EXPLICIT / NO-GO cards read identical
- **Fix (BOM Phase 6a)**: tier badge per card (color-coded: green=AUTO, blue=CONFIRM, amber=EXPLICIT, red=NO-GO); optional border-left accent.

---

## P2 — Permissions page (MED)

### PE1. Footnote calls out unfinished Topology side-drawer integration
- Footer text: "Pending follow-up: Topology side-drawer integration (the standalone page above is the authoritative..."
- **For this BOM**: not in scope. Note for v0.7 work.

---

## P2 — Capabilities page (MED)

### C1. Per-capability × per-cost-mode matrix is dense
- 14 capability rows × 3 cost-mode columns = 42 "Pick model" buttons
- This is the substrate of the v0.8 Shadow mode design
- **Fix**: not in this BOM. Tag a "v0.8 preset editor" banner so operator knows.

### C2. Cost dial Turbo/Balanced/Eco buttons present on this page
- Confirms task #37 — chips exist on Capabilities, NOT yet on Helm/topbar
- **Fix**: surface cost dial in topbar per locked design memory (v0.8 work, not this BOM).

---

## P2 — Settings page (MED)

### SE1. No-go editor already partially implemented
- Form: rule.id, action pattern (regex/tool.name), classification (8 classes from read-only → destructive), reason, Add
- Working subset of today's no-go-dashboard-edit decision
- **Reconcile**: locked decision adds 7 guardrails (audit log, 30+ char reason, passkey for removes, diff view, cooling-off, 24h rollback, sync-to-source). Current implementation has none.
- **Fix**: NOT in this BOM (v0.8). Add "Pending v0.8 guardrails" note.

### SE2. Trust scope "Extend" and "Revoke" buttons lack context
- Unclear which scope they act on
- **Fix**: pair buttons with scope identity in layout; add `aria-describedby`.

---

## Cross-cutting (MED)

### X1. Inspector panel always mounted, even when empty
- Every page has Inspector panel with "Select a brick or worker to inspect." placeholder
- Takes real estate even when nothing to inspect
- **Fix**: hide on pages where it doesn't make sense (Plans, Decide, Tools, Permissions, Capabilities, Settings, Diagnostics). Keep on Topology and Streams.

### X2. Data duplication across Topology / Streams / Diagnostics
- Worker roster shows on Topology, Streams, missing on Diagnostics
- **Fix**: single worker-data fetcher consumed by both. PR #45 may address — verify.

### X3. Empty states are inconsistent
- Different voices and CTA presence across pages
- **Fix**: standardize empty-state component with consistent voice + CTA where appropriate.

### X4. "Live updates connected." status visible everywhere
- Good for confidence, but redundant text on every page
- **Fix**: keep ONE indicator (likely WATCH OK / future Engine chip) that aggregates SSE + watchdog + retention.

### X5. Capture-this floating button
- Operator-driven feedback capture visible on every page (good)
- High-value for family-mode rollout when sons might capture observations.

---

## What's ALREADY good

- Consistent navigation across all 12 pages
- Watchdog status visible everywhere (becomes Engine chip in v0.8)
- SSE live-updates pattern works
- Capture-this affordance is excellent — easy operator-feedback path
- Decide page has rich decision records
- MCPs page has 30-server catalog with Install affordance
- Capabilities page has real per-capability × cost-mode matrix
- Iron palette + Norse-runic wordmark consistent

---

## CC priority order for Phase 6e

In order:

1. **B1** (version display — covered by Phase 5)
2. **B4** (memory panel on Diagnostics — covered by Phase 4)
3. **T1** (logo dedup — covered by Phase 5)
4. **H1** (L3 sizing — covered by Phase 6d)
5. **TL1+TL2+TL3** (Tools page — covered by Phase 6a)
6. **TO3+TO4+TO5+TO6** (Topology polish — covered by Phase 6b; check PR #45 doesn't already do these)
7. **D1+D2** (Decide page — covered by Phase 6c)
8. **PL1+PL2+PL3** (Plans page accessibility + casing)
9. **B3** (Diagnostics worker count)
10. **B6+X1** (lazy-mount dialogs + Inspector cleanup)
11. **X3+X4** (empty state consistency, SSE-status dedup)

Lower priority — leave for later BOM if time tight:
- **B5** (worker output capture — separate bug)
- **B2** (Steward wiring — task #33 followup)
- **S1+S2** (Streams page restructure)
- **C1+C2** (Capabilities placeholder — v0.8)
- **SE1+SE2** (Settings additions — v0.8)
- **PE1** (Permissions side-drawer — v0.7)
- **H2+H3+H4** (Helm polish — fold into Phase 6d Helm work)
- **T3** (mysterious "daemon" topbar element — investigate)

---

End of audit. ~30 findings across 12 pages.
