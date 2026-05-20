# BOM: v0.6.12 — Dashboard Honesty Megacycle

**Owner:** CC (autonomous, continuous — NO between-phase or between-PR stops)
**Sensitivity:** careful (touches dashboard pages + data fetchers + tool classification; no security primitives)
**Verification window:** targeted (~30 min — UI-heavy, one data-fetcher rework; not perf-critical)
**Branch:** `feat/v0.6.12-dashboard-honesty`
**Base:** `main` (AFTER v0.7 PRs #50 + #51 are merged — see Phase 0)
**Estimated scope:** 12 phases, ~15-22 hour autonomous run, ~3-5 PRs

---

## OPERATOR DIRECTIVE — CONTINUOUS RUN

Operator (Kenneth) is away at work and wants this to run start-to-finish without stops. Per operator sovereignty (Lex Insculpta):

- **Override CLAUDE.md §9 between-PR approval gates for this entire run.**
- Open a PR at the end of each phase-group, fire ntfy, and **immediately continue** to the next phase-group. Do NOT idle waiting for review.
- Stop conditions remain: `npm test` regresses, `npm run build` fails, `tsc --noEmit` fails, or a genuine NO-GO action surfaces. Anything else = continue.
- If a phase hits an ambiguity not covered here, pick the most conservative interpretation, note it in the PR description, and continue. Do not stop to ask.

---

## Context — this BOM fixes everything the operator found in the 2026-05-19 QA session

A long manual QA walkthrough surfaced one root problem: **the dashboard UI shipped ahead of its substrate.** Many surfaces look interactive but are placeholders, misclassified, or static. This BOM is the honesty pass — every surface either works or honestly says it doesn't yet.

Read these memory files at Phase 0 (they're in the operator's Cowork memory; if unreachable, the BOM body below is self-sufficient):
- `project_stavr_diagnostics_overview_drill_2026_05_19` — the Diagnostics redesign spec
- `project_stavr_no_orphan_components_rule` — every top-level component must have a deep-dive path
- `project_stavr_helm_topbar_design_2026_05_19` — Helm + topbar decisions
- `project_stavr_observability_layers_2026_05_19` — metric coverage targets

Also consume `proposed/v0_6_11-ux-audit-findings.md` and `proposed/v0_6_11-lego-seam-findings.md` already on the branch.

### The hard rule this BOM enforces — NO ORPHAN COMPONENTS

Every component visible at the top level of any page MUST have a deep-dive path — a Diagnostics detail page, an Inspector panel update, or an inline expand. A status indicator with no way to investigate is a defect. Apply this as an acceptance criterion to every phase.

---

## Phase 0 — Merge v0.7 + recon (≤45 min)

1. Verify PR #50 + #51 state via `gh pr view` or the GitHub API. Both were verified CLEAN/MERGEABLE/CI-green on 2026-05-19.
2. **If #50 + #51 are still OPEN**: merge #50 first (squash), then #51 (rebase-merge — preserve its 9 phase commits). Both touch `src/server.ts` — if #51 conflicts after #50 lands, rebase #51's branch on new main, resolve the server.ts conflict, push, then merge.
3. **If they're already merged** (operator did it before leaving): skip step 2.
4. `git checkout main; git pull; npm install; npm run build` — confirm clean post-merge.
5. Branch `feat/v0.6.12-dashboard-honesty` off main.
6. Read the dashboard source: `src/dashboard/pages/*.ts`, `src/dashboard/shell.ts`, `src/dashboard/tokens.ts`, `src/dashboard/data/*`.
7. Output `proposed/v0_6_12-recon-findings.md`. Commit + push.

## Phase 1 — Design-token consolidation

Per the lego-seam audit: dashboard uses ~14 distinct font sizes per page (some sub-pixel: 13.3333px, 12.5px), 5 font weights, 9-11 border radii.

- Define a canonical token set in `src/dashboard/tokens.ts`: font sizes (11/12/13/14/16/18/22 only — NO fractionals), 2 weights (400/500), 4 radii (`--radius-sm` 6px / `--radius-md` 10px / `--radius-lg` 12px / `--radius-pill` 999px).
- Codemod over `src/dashboard/**/*.ts` replacing raw values with tokens. Eliminate every sub-pixel font size and every font-weight 600/700.
- No font-size below 11px anywhere.
- DCO commit. Push.

## Phase 2 — Diagnostics overview rewrite (5-tile)

Replace the current Proxmox-dense Diagnostics landing with a 5-tile overview per `project_stavr_diagnostics_overview_drill`:

- 5 large tiles: Engine, Connections, Workers, Federation, Alerts. Each: one status word/count, status-colored border, `drill →` affordance. No sparklines on overview.
- Empty/future tiles dim with honest copy ("v0.7 coming" became "live" after the merge — Federation tile is now real).
- DCO commit. Push.

## Phase 3 — Diagnostics drill: Engine detail page

New route `/dashboard/diagnostics/engine`. Four collapsible sub-sections:

- **Health**: heap+rss chart over time, uptime/version/commit, watchdog checks, restart count, OOM headroom
- **Storage**: runestone.db size + growth, write/read rate, query latency p50/95/99, pending writes/WAL backlog, per-table row counts, disk queue length, free disk, retention sweep history
- **Steward**: subprocess heartbeat lag, message queue depth, decisions answered/pending/expired, lessons-table size, wired/unwired status WITH reason
- **Traffic**: API latency p50/95/99 per endpoint + per method, error rate by class (auth/timeout/schema/5xx), backlogs (pending events/notifications/decisions, SSE subscriber queue depths), qps over time

Time-window selector (5m/1h/24h/7d). Recent-events log filtered to engine. DCO commit. Push.

## Phase 4 — Diagnostics drill: Connections / Workers / Federation / Alerts

Four more detail pages, same template (header + summary + time-window + primary chart + sub-metrics + recent events):

- `/dashboard/diagnostics/connections` — MCP roster, per-MCP latency + traffic
- `/dashboard/diagnostics/workers` — active + last-4h workers, per-worker output, spawner-protocol metrics
- `/dashboard/diagnostics/federation` — peer roster, handshakes, peer latency (now real post-v0.7)
- `/dashboard/diagnostics/alerts` — active warnings, history, acknowledge actions

DCO commit per page or one bundled commit. Push.

## Phase 5 — Worker retention policy

- Workers in terminated/crashed/completed state auto-archived after `STAVR_WORKER_RETENTION_HOURS` (default 4); hard-delete after `STAVR_WORKER_HARD_DELETE_DAYS` (default 30).
- Extend `src/observability/retention.ts` (existing scheduler).
- Streams + Topology default views show active + last-4h only; "Show archived" toggle reveals older.
- DCO commit. Push.

## Phase 6 — Tooltips dashboard-wide

- Add HTML `title=""` tooltips to every metric label across `src/dashboard/pages/*.ts`: qps, p95, p99, err %, RSS, heap_used, external, arrayBuffers, scope, BOM, decision_request, AUTO/CONFIRM/EXPLICIT/NO-GO, etc.
- Tooltip text: plain-language one-liner. (e.g. qps → "Queries per second — tool calls happening each second.")
- DCO commit. Push.

## Phase 7 — Tier classification fixes + Permissions page grouping

- Bug: `github.list_*` and `github.read_*` tools are `tier: 'confirm'` in `src/tools/catalogue-data.ts` — should be `tier: 'auto'` (read-only). Fix every read-only github tool.
- Permissions page (Layer 0 + Layer 3 matrix): group tools by category (github / credential / host / builtin), add tier-color badges, add filter-by-tier and filter-by-state.
- DCO commit. Push.

## Phase 8 — Empty-state CTAs + no-orphan-components audit

- Every "no data" empty state gets a consistent component with plain-language explanation + a CTA where one exists ("Connect an MCP →", "Propose a BOM →").
- Audit EVERY top-level component on EVERY page. Any tile/chip/badge/row/node without a deep-dive path = defect. Wire it (detail page, Inspector update, or inline expand) OR hide it if truly informationless.
- Status badges on Diagnostics (Backup/CI/Deploy/Retention/OOM/Webhook/Self-heal) each get a click → detail.
- DCO commit. Push.

## Phase 9 — Topology fixes

- Inspector panel: clicking different nodes must show different content (currently static — wire selectedNodeId → inspector).
- Timeline scrubber: render YouTube-style heatmap (bar thickness ∝ event density per 1-min bucket, hover tooltip with event-kind breakdown).
- Palette-door FAB: disambiguate the "circle with plus" — clear label or icon.
- Galactic-map empty state: when 0 nodes, show "Connect an MCP to populate the map" not a blank SVG.
- Ctrl+K search → rebind to `/` (GitHub style), visible hint in placeholder.
- DCO commit. Push.

## Phase 10 — Honesty relabel of parked write-surfaces

Every interactive-looking element that doesn't reach a working substrate either gets wired OR honestly relabeled:

- **MCPs Install buttons**: currently freeze the renderer 45s on click. Fix the freeze. Relabel to "Preview · install lands in [version]" + style as non-primary, OR wire the install flow if feasible within scope.
- **Plans page**: no Create/Propose button + "propose one →" links are dead loops. Either add a working Propose form (route to capture_this event) OR change empty-state copy to honest "Propose BOMs via Capture-this or CC dispatch."
- **Capabilities cm-pick**: opens read-only "v0.5 save flow" viewer. Relabel honestly OR wire the save flow.
- **Toolkit Install**: verify it works or relabel.
- DCO commit. Push.

## Phase 11 — Verification

- `npm test` + `npm run build` + `tsc --noEmit` all clean.
- Headless-Chrome smoke: navigate all 12 pages + the 5 new Diagnostics detail pages, assert no console errors, each page DCL <2s.
- Nav-stress: 30 cross-page navigations, assert no freeze >100ms (PR #48 fix must still hold).
- Click-target audit: assert every top-level tile/chip/badge has a non-dead click target.
- Open final PR with screenshots of the new Diagnostics overview + one detail page + before/after of the design-token cardinality count.
- Fire ntfy.

---

## Constraints (per CLAUDE.md hard invariants)

- Per-phase commits, `git commit -s` (DCO).
- `git status --short` + `git symbolic-ref HEAD` before every git op.
- Don't-touch: `src/persistence.ts` (v0.7 already modified it for operator_credentials — don't reshape), `src/types/`, `migrations/`, `src/broker.ts`, `src/transports.ts` core (Phase 3 Storage/Traffic metrics READ from these — read-only; new data fetchers go in `src/dashboard/data/`).
- Tests are derivative — delete legacy assertions that conflict; update in the same commit.
- Verify file writes >30 KB with `stat -c %s` + `tail -5`.
- NO-GO handoff if a genuine NO-GO surfaces — name it, leave precise operator steps in the PR description, continue with other phases.

## PR grouping (open + continue, don't stop)

- PR 1: Phases 1-2 (tokens + overview)
- PR 2: Phases 3-4 (Diagnostics drill pages)
- PR 3: Phases 5-7 (retention + tooltips + tier fixes)
- PR 4: Phases 8-10 (empty states + topology + honesty relabel)
- PR 5: Phase 11 (verification — or fold verification into PR 4)

Open each, ntfy, continue immediately. Operator reviews them tonight.

## Definition of done

1. All 4-5 PRs open against main, all CI green.
2. Diagnostics is a 5-tile overview + 5 working drill pages.
3. Zero orphan top-level components — every one drillable.
4. Design-token cardinality down 3-4× (verify with a computed-style count).
5. Worker retention live (4h default).
6. Every metric label has a tooltip.
7. `github.list_*` tools are AUTO tier.
8. Every parked write-surface either works or honestly says it doesn't.
9. No regression — full suite green, Plans nav still fast, leak fix still holds.
10. ntfy fired on final PR.
