# OVERNIGHT TASK · 2026-05-17 · stavR v0.4.1 dashboard polish

Single dispatchable brief for Claude Code (Opus 4.7) autonomous run.

**Estimated wall-clock**: 3–4 hours sequential. Single worker, single PR.

**Stop conditions**: end of any phase if `npm test` regresses (must stay at 562+ passing) and can't be fixed in 30 min, or `npm run build` fails. Visual fidelity that "doesn't quite match" is NOT a stop condition — ship what you have and note deltas in the PR.

**Do NOT pause for approval** between phases. Commit + push at end of each phase. Open PR at end of Phase 6.

---

## Why this bundle

v0.4 (PR #23) shipped the *substrate* — Helm + Ollama + MCPs + Capture + runtime toggles. Kenneth's verdict on the *visuals* was "hideous": flat 2000s admin-grid, didn't match the canonical mockup language. Root cause: when CC executed v0.4, the canonical v8 mockup wasn't committed yet, so CC inferred visuals from prose only.

**This bundle fixes that** by pointing CC at four canonical visual targets that are now committed, and a tight scope of "visuals + templating only — don't touch business logic."

**What's in**: Helm + Topology + Diagnostics + shell/tokens rebuilt against the v2 mockups. Streams / Decide / Toolkit alignment to v8. Brand wordmark fix. Glass surfaces everywhere.

**What's explicitly out**: Capabilities + Settings (good already). Any controller, server route, data fetcher, MCP integration, Steward subprocess code, Worker spawn code, /api/* routes. Touching any of those = stop and roll back.

---

## Reference reading (read these first, in order)

1. `CLAUDE.md` — project context, invariants, gotchas
2. `docs/stavr-progress-and-plan.md` — 15 footguns lessons
3. `design-mockups/dashboard-helm-v2-expanded.html` — **canonical Helm**
4. `design-mockups/dashboard-topology-v2-graph.html` — **canonical Topology** (incl. brand SVG icon sprite)
5. `design-mockups/dashboard-diagnostics-v2-b-proxmox.html` — **canonical Diagnostics**
6. `design-mockups/dashboard-mockup-v8.html` — canonical Streams / Decide / Toolkit / Capabilities / Settings (sections `#page-streams`, `#page-decide`, etc.)
7. `memory/feedback_never_lose_files.md` + `memory/feedback_edit_tool_truncation.md` — file-loss discipline

**Open each mockup in a real browser before editing the matching page.ts file.** Inspector → DOM/computed styles. Don't infer visuals from a text scan of the HTML.

---

## Canonical visual targets — table to keep open

| Page | Mockup | Render code |
|------|--------|-------------|
| Helm | `design-mockups/dashboard-helm-v2-expanded.html` | `src/dashboard/pages/helm.ts` |
| Topology | `design-mockups/dashboard-topology-v2-graph.html` | `src/dashboard/pages/topology.ts` |
| Diagnostics | `design-mockups/dashboard-diagnostics-v2-b-proxmox.html` | `src/dashboard/pages/diagnostics.ts` (create if missing — currently lives in `placeholders.ts`?) |
| Streams | `design-mockups/dashboard-mockup-v8.html` `#page-streams` | `src/dashboard/pages/streams.ts` |
| Decide | `design-mockups/dashboard-mockup-v8.html` `#page-decide` | `src/dashboard/pages/decide.ts` |
| Toolkit | `design-mockups/dashboard-mockup-v8.html` `#page-toolkit` | `src/dashboard/pages/toolkit.ts` |
| Shell + tokens | `design-mockups/dashboard-mockup-v8.html` topbar + iron palette CSS vars | `src/dashboard/shell.ts` + `src/dashboard/tokens.ts` |
| **Capabilities** | already good | **DO NOT TOUCH** `src/dashboard/pages/capabilities.ts` |
| **Settings** | already good | **DO NOT TOUCH** `src/dashboard/pages/settings.ts` |

---

## Don't touch

- `src/dashboard/pages/capabilities.ts`
- `src/dashboard/pages/settings.ts`
- `src/dashboard/data/*` (data fetchers)
- `src/dashboard/adapters/*` (only edit if a data-shape change is required, then justify in PR)
- Any file outside `src/dashboard/` (no server, no worker, no Steward, no MCP, no /api)

Touching any of those = stop, revert, leave a note in the PR description.

---

## Hard rules (read before Phase 0)

1. **Never-lose-files**: every page file > 15KB after edit must be verified via `bash stat -c %s file` + `bash tail -5 file` BEFORE `git add`. If the tail doesn't end with the expected closing brace, the file is truncated. Recover via `head -n LASTGOODLINE file > /tmp/rebuild && cat >> /tmp/rebuild << EOF ... EOF && cp /tmp/rebuild file`.
2. **DCO sign-off**: every commit `-s`. No exceptions.
3. **Commit per phase**: don't batch. Each phase = one commit, pushable independently. If Phase N regresses, revert just that commit.
4. **`.glass` everywhere**: every panel/band/card uses the glass utility (`background: rgba(20,22,31,.55); border: 1px solid var(--line); border-radius: 12px; backdrop-filter: blur(14px);`). If a surface isn't glass, it's wrong.
5. **Wordmark**: `stav` + `ᚱ` (Raido rune, U+16B1). Not "stavR" as plain text. Not "STAVR". The rune is brand.
6. **Watchdog pip**: replace any literal red dot with a `WATCH OK` chip + tooltip listing what's being watched (PM2 status, last heartbeat, OOM headroom).
7. **Status vs Type colors**: type = node color (rust/blue/green/amber/purple/teal/pink/cyan per topology mockup). Status = halo ring (ok/warn/crit). NEVER use color to communicate status on a node — use the halo.
8. **No red bus**: if any page still has the literal red horizontal bus from v0.3, replace with the topology graph reference (link to Topology page).
9. **After each phase**: `npm test` passes, `npm run build` succeeds, `pm2 reload stavr` comes up clean, hit `http://localhost:8421/dashboard` and visually confirm.

---

## PHASE 0 · Pre-flight (Kenneth, before CC kicks off)

~5 min. Kenneth confirms:

1. `git status` clean on `main`
2. Last 4 commits include: `b413ad5` helm v2, `0e22e7c` topology v2, `bf9c22b` diagnostics v2 + topology graph, `f15d452` v8 canonical
3. `pm2 status` shows `stavr` online, daemon healthy
4. `npm test` passes locally (baseline)
5. Trust scope created: `rapid · visuals only · 3-4h · cap 800k tokens`

Then dispatch CC with: `cc run --prompt OVERNIGHT_TASK_2026_05_17_polish.md --profile turbo`

---

## PHASE 1 · Tokens + shell (30 min)

**Files**: `src/dashboard/tokens.ts`, `src/dashboard/shell.ts`

### Sub-tasks

1. Iron palette CSS variables. Copy from `dashboard-mockup-v8.html` `<style>` `:root` block. Locks:
   - `--rust: #b8542a` (and `--rust-glow`, `--rust-soft`)
   - `--ink-0/1/2/3` scale
   - `--ok/warn/crit/info` status quartet
   - Type palette (8 colors): `--t-core / --t-mcp-remote / --t-mcp-local / --t-webhook / --t-db / --t-model / --t-worker / --t-peer`
   - `--surface / --surface-2 / --line / --line-2`
   - `--mono` (JetBrains Mono / SF Mono / Consolas)
2. Glass utility. Add `.glass` class to a shared stylesheet imported by shell.ts.
3. Shell topbar:
   - Left: rune badge (22px rust hex with `ᚱ` glyph) + wordmark `stav` + `ᚱ` (rust monospace)
   - Center: nav (Helm / Topology / Streams / Decide / Toolkit / Capabilities / Diagnostics / Settings)
   - Right: status pills (daemon uptime, Steward model, current time GST) + `WATCH OK` chip with tooltip
4. Remove any old pill/dot patterns that conflict with the new convention.

### Acceptance

- Page loads, font/spacing/colors look like v8/v2 mockups
- Topbar shows `stav` + `ᚱ` (visible rune, not a placeholder box)
- Watchdog pip → `WATCH OK` chip with hover tooltip
- Glass utility renders backdrop-filter correctly on Chrome + Firefox

### Commit

`feat(dashboard): iron palette tokens + shell topbar + glass utility`

---

## PHASE 2 · Helm L0-L4 expanded (45 min)

**Files**: `src/dashboard/pages/helm.ts`

### Sub-tasks

1. Open `design-mockups/dashboard-helm-v2-expanded.html` in browser. Inspect each band's structure.
2. Replace `helm.ts` band content with v2 versions:
   - **L4 INTENT** (150px): keep existing `HomeData.intent` binding. Add the live composer input (read-only stub for now, send-to-Steward wiring stays as TODO). Add last-5 intent timeline from existing decisions data.
   - **L3 PLANS** (~220px): keep 4 cards (already match v8). ADD the 24h BOM gantt strip below them. Bind to existing BOM list with start/end timestamps. Now-cursor = `Date.now()`.
   - **L2 WORKERS** (160px): replace dots row with 6-up worker cards. Each card: `name + type role`, progress bar (color by status: ok=green, warn=amber, crit=red striped, idle=ink-3), current step (truncate), uptime + eta. Bind to existing `HelmWorker[]` data.
   - **L1 TOOL CALLS** (160px): keep histogram. ADD top-5 tools list (bind to existing tool-call counts from `/metrics`). ADD 3 mini-trends (qps/p95/err) inline sparklines from `/metrics`.
   - **L0 SYSTEMS** (140px): replace chips with 5-up system tiles. Each tile: `name + status dot + latency badge`, sparkline (last 1h), last-call line. Bind to existing MCP list.
3. Grid: `grid-template-rows: 150px 1fr 160px 160px 140px;` for the band stack. Total fills viewport.
4. Tier colors: L4 purple, L3 sky, L2 green, L1 amber, L0 ink-1 (left edge gradient only).
5. Every band wraps in `.glass`.

### Acceptance

- Page fills viewport (no big empty bottom half)
- All 5 bands present with rich content
- Click L4 → Steward sheet, L3 → /plans, L2 → /workers, L1 → /diagnostics, L0 → /topology (existing routes)
- Worker progress bars update on data refresh
- Histogram + sparklines populate from `/metrics`

### Commit

`feat(dashboard): helm v2 — L0-L4 tiers expanded to fill viewport`

---

## PHASE 3 · Topology walkable graph (60 min)

**Files**: `src/dashboard/pages/topology.ts`, possibly add `src/dashboard/components/icon-sprite.ts`

### Sub-tasks

1. Open `design-mockups/dashboard-topology-v2-graph.html` in browser. Inspect node structure + icon sprite + edge SVG.
2. Lift the brand SVG icon sprite verbatim from the mockup into `src/dashboard/components/icon-sprite.ts` exporting an `<svg>` block to inject into shell.ts ONCE on render. 15 symbols: `i-github / i-slack / i-linear / i-drive / i-ollama / i-fs / i-sqlite / i-webhook / i-anthropic / i-meta / i-deepseek / i-worker / i-haiku / i-peer / i-rune`.
3. Replace existing red-bus topology rendering with the walkable graph.
4. Layout engine: use **d3-force** (already a dep?) or **cytoscape**. If neither is installed, prefer d3-force (lighter). Pin = drag commits a fixed position. Persist pins to `localStorage` keyed by node id.
5. Node rendering: type-colored shape (round for MCP, hex for core/model/peer, square for db/webhook) + icon glyph via `<use href="#i-...">` + status halo ring + badges (lock/pin/chev/stat).
6. Edge rendering: SVG paths. When LIVE toggle is on, attach `<animateMotion>` particles flowing from caller→callee. Particle color = call result (ok/warn/err). Subscribe to `/events` SSE for real call events; render most recent N as transient particles.
7. Filter strip: namespace tabs (All/Local/Federated/External) + 8 type chips with counts. Chips toggle visibility of nodes by type.
8. Inspector drawer: on node click. Tabs: Health / Config / Events / Actions. Health tab = 4 mini-charts (qps/p95/err/retries) bound to per-node metrics, window toggle (5m/1h/24h/7d). "Open in Diagnostics" deep-link → `/diagnostics?entity=<id>`. Edit-mode banner stays parked with `v0.7` badge (do NOT wire edit yet).
9. Palette door (top-right): reset-layout button works; `+` and `✎` buttons parked with `v0.7` badges + tooltips.
10. Legend bar bottom: type swatches + status dots + keyboard shortcut hints (`drag`, `›`, `click`, `L`, `⌘K`).

### Acceptance

- Open `/topology` — graph renders with all current daemon entities (MCPs, workers, models, fleet, runestone DB)
- Click a node — drawer opens with metrics
- Drag a node — it stays where dropped (refresh persists)
- Toggle LIVE — animated particles appear on edges with real /events stream
- Filter chips hide/show nodes by type
- Brand icons visible (not text placeholders)

### Commit

`feat(dashboard): topology v2 — walkable graph + brand icons + live overlay`

---

## PHASE 4 · Diagnostics Proxmox-dense (45 min)

**Files**: `src/dashboard/pages/diagnostics.ts` (likely need to add to `index.ts` route table if not present)

### Sub-tasks

1. Open `design-mockups/dashboard-diagnostics-v2-b-proxmox.html` in browser.
2. Top jobs banner: 7 pills (Backup / CI / Deploy / Retention / OOM watch / Webhook / Self-heal). Color by status. Bind to existing job-status endpoint if present, else stubbed.
3. Three sections, each glass card with header + body:
   - **MCPs**: donut gauge cluster (qps / err / p95) + multi-line trend chart (last 1h) + roster table (name / version / qps / p95 / err / last-call). Bind to MCP list + `/metrics`.
   - **stavR fleet**: same structure but for `primary + spawn + peers`. Federated peer row shows ACL badge.
   - **Workers + scopes**: same structure but for workers. Stuck worker highlighted red striped.
4. Bottom row (2 columns): Self-heal panel (last N Steward heal actions with undo/deny buttons) + Live trace tail (SSE from `/events`, scrolling, paused on hover).
5. Window selector (5m/1h/24h/7d) controls all charts on the page.

### Acceptance

- Open `/diagnostics` — page renders without errors
- Charts populate from `/metrics` (no zero-state forever)
- Trace tail scrolls with new events
- Self-heal panel shows real Steward actions from `/api/steward/heal-log` if exists, else empty state with copy "No recent heal actions"
- Window selector switches all chart data ranges

### Commit

`feat(dashboard): diagnostics v2 — Proxmox-dense sectioned trends + self-heal`

---

## PHASE 5 · Streams / Decide / Toolkit alignment (30 min)

**Files**: `src/dashboard/pages/streams.ts`, `src/dashboard/pages/decide.ts`, `src/dashboard/pages/toolkit.ts`

### Sub-tasks

1. Light touch. These pages are already close to v8 — confirm by visual diff.
2. Apply `.glass` to any panel that's still flat.
3. Replace any literal red horizontal bus with a link to `/topology`.
4. Confirm topbar matches new shell (no duplicate).
5. Confirm color usage follows type-vs-status convention.

### Acceptance

- Visual diff against `dashboard-mockup-v8.html` sections — no regressions
- All panels are glass surfaces
- No red bus remains

### Commit

`feat(dashboard): streams/decide/toolkit alignment to v8 — glass surfaces, no red bus`

---

## PHASE 6 · Smoke + PR (30 min)

### Sub-tasks

1. `npm test` — full suite, must pass (baseline 562+)
2. `npm run build` — must succeed
3. `pm2 restart stavr` (NOT `reload --update-env` — that's footgun #3 from progress doc; pm2 restart is fine here since no env change)
4. Hit `http://localhost:8421/dashboard` in browser
5. Take a screenshot of EACH page in order: helm → topology → streams → decide → toolkit → capabilities → diagnostics → settings
6. Save screenshots to `design-mockups/v0_4_1_polish_screenshots/{page}.png`
7. Commit screenshots: `docs(design): v0.4.1 polish screenshots`
8. Open PR:
   - Title: `feat(dashboard): v0.4.1 polish — match canonical v2 mockups`
   - Body: link to each canonical mockup + matching screenshot, list of phases shipped, list of explicit non-changes (Capabilities, Settings, business logic), token + line-count summary
9. Push and tag `v0.4.1-polish` on the merge commit (Kenneth will merge after review)

### Acceptance

- PR open with screenshots
- Tests green in CI
- No regressions in /api/* routes (CI smoke + visual smoke)

### Commit

`docs(design): v0.4.1 polish screenshots`

---

## Budget

- **Time**: 3-4h CC wall-clock (sequential, no parallel workers)
- **API cost**: ~$2-4 (Opus, mostly file edits + browser inspection)
- **LOC change**: ~800-1500 net in `src/dashboard/` only
- **Token cap**: 800k (rapid mode trust scope)

---

## Rollback plan

If any phase blows up after merge:
- Revert just that phase's commit: `git revert <sha>`
- Push to a hotfix branch, open quick-revert PR
- Phases are independent enough that reverting one doesn't cascade

If the whole PR is broken: `git revert <merge-sha>` reverts atomically.

---

## On completion

CC should:
1. Comment on the PR with: phases completed, tests passing, screenshots attached, deltas vs mockup (if any), pending TODOs deferred to v0.7 (edit mode, palette drop)
2. Notify in `#stavr-dev` Slack channel via existing slack MCP if configured
3. Tag the workers channel: `@kenneth v0.4.1 polish ready for review · PR #__`
4. Update `memory/project_stavr_dashboard_picks_2026_05_16.md` if visual decisions changed during implementation

---

## Footguns to remember (from `docs/stavr-progress-and-plan.md`)

1. PowerShell `curl` ≠ real curl (use `curl.exe` or `Invoke-RestMethod`)
2. `pm2 restart --update-env` doesn't reload `ecosystem.config.cjs` — use `pm2 start ecosystem.config.cjs --update-env` only if env changes; this brief doesn't change env so plain `pm2 restart stavr` works
3. `pm2 env stavr` doesn't take a name — use numeric id `pm2 env 0`
4. GitHub blocks self-approval of PRs — skip `gh pr review --approve`, go directly to `gh pr merge`
5. Stacked-PR cascade-close: if base branch merges, dependent PRs auto-close — don't stack
6. RUNNER~1 8.3 paths on Windows — quote paths
7. String.raw template literals don't nest cleanly — use plain backticks + careful escaping
8. **NEW**: Edit-tool on large files (>30KB) can truncate the tail. Always verify size + tail via bash before commit.
9. Cowork virtualized fs silently drops Write tool output on rare occasions — verify all writes via bash stat + tail

---

## End of brief
