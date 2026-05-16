# OVERNIGHT TASK · 2026-05-17 · stavR v0.4 visible-value bundle

Single dispatchable brief for Claude Code (Opus 4.7) autonomous run.

**Estimated wall-clock**: 14-17 hours sequential (was 12-15h before adding the runtime toggles + Settings → Diagnostics work in Phase 5). Single worker, single PR.

**Stop conditions**: end of any phase if tests fail and can't be fixed within 30 min. Otherwise run to completion.

**Do NOT pause for approval** between phases. Commit and push at end of each phase. Open PR at end of Phase 6.

> **Pre-flight (Kenneth, before kicking off CC):**
> 1. PRs #15-#21 must all be merged on main (verify: `git log --oneline -10` shows them)
> 2. `git status` is clean on main
> 3. Phase 0 below (Ollama install) is complete

---

## Why this bundle

Highest-visible-value chunk that fits one autonomous run, builds on the now-stable substrate (OOM fixed, retention working, observability shipped, CLI footgun closed). Unlocks Kenneth's local-LLM use case.

**What's in:** Helm rename + dashboard v8 visual refresh, Ollama provider for local LLMs, MCPs registry browser, capture-and-route ⊕ button, per-profile capability matrix.

**What's out (own runs, see ADRs 032-035):**
- v0.5 Steward portability — ADR-032 (Steward as subprocess + 3-layer state + Model Runtime interface)
- v0.6 OAuth 2.1 + Resource Indicators — ADR-035 phase 1
- v0.6 stavr-tray companion — ADR-033 (revised from stavr-watch standalone)
- v0.7 A2A endpoint — ADR-035 phase 2
- v0.8 stavr-spawn lightweight node — ADR-035 phase 3
- v0.9 Multi-node fleet + Model Registry — ADR-035 phase 4

---

## Reference reading (read these first, in order)

1. `CLAUDE.md` — project context, invariants, gotchas
2. `docs/stavr-progress-and-plan.md` — what shipped 2026-05-15→16, 15 architectural lessons / footguns
3. `docs/observability.md` — operator runbook for `/metrics`, `/debug/*`, OTel
4. `adr/030-event-retention-and-dashboard-caching.md` — retention model
5. `adr/031-observability-architecture.md` — OTel + Prometheus + pino baseline
6. `adr/032-steward-model-portable-agent.md` — what comes next; v0.4 lays the local-LLM foundation
7. `design-mockups/dashboard-mockup-v8.html` — open in browser before coding
8. `design-mockups/README.md` — design tokens + naming locks
9. `memory/SESSION_2026_05_16.md` — full design context

---

## PHASE 0 · Manual prerequisite (Kenneth, before CC kicks off)

~30 min total.

### 0.1 Install Ollama

```powershell
winget install Ollama.Ollama
ollama --version
curl http://127.0.0.1:11434/api/tags  # should return: {"models":[]}
```

### 0.2 Pull at least one model (per available VRAM)

```powershell
# Small + fast (any modern GPU or even CPU):
ollama pull llama3.2:3b
ollama pull phi3:mini

# Medium (8+ GB VRAM):
ollama pull llama3.3:8b

# Large (24+ GB VRAM):
ollama pull deepseek-r1:32b
```

Verify:
```powershell
ollama run llama3.2:3b "Say hello in five words"
```

### 0.3 Confirm clean state

```powershell
cd C:\dev\cowire
git checkout main
git pull
git status   # must be clean
npm install
npm run check  # baseline must pass
```

---

## PHASE 1 · Branch + scaffold (~30 min)

```powershell
git checkout -b feat/v0.4-visible-bundle
mkdir -p .work/2026-05-17
echo "Phase 1 · scaffold complete" > .work/2026-05-17/progress.md
```

---

## PHASE 2 · Local LLM provider (Ollama) (~3h)

### 2.1 Provider implementation

`src/steward/providers/ollama.ts`:
```typescript
import type { Provider, ProviderRequest, ProviderResponse } from './types.js';

export interface OllamaProviderConfig {
  host: string;        // default 'http://127.0.0.1:11434'
  defaultModel: string;
  timeoutMs: number;   // default 120000
}

export class OllamaProvider implements Provider {
  readonly name = 'ollama';
  readonly kind = 'local' as const;
  
  constructor(private cfg: OllamaProviderConfig) {}
  
  async chat(req: ProviderRequest): Promise<ProviderResponse> {
    // POST {host}/api/chat with messages mapped from req
    // Stream response if req.stream, else aggregate
    // Return ProviderResponse with content + estimated usage
  }
  
  async listAvailableModels(): Promise<string[]> {
    // GET {host}/api/tags → models[].name
  }
}
```

Wire into `src/steward/providers/index.ts` (or wherever providers are registered today).

### 2.2 Capability tagging

Ensure these tags exist in `src/types/stavr-bom.ts`:
- `local-classifier`, `local-reasoning`, `local-summary`, `local-reading`

Map common cases:
- `simple-summary` → can use local
- `cheap-classifier` → can use local
- `reading` → can use local
- `code-reasoning` → NOT local (until 70B-class reliably available)
- `code-execution` → workers always Anthropic (Claude Code subprocess)

### 2.3 Profile-aware routing

Update `src/steward/planner.ts`:
- **Eco**: prefer Ollama for any capability with local model registered; refuse if no local match (surface as Decision)
- **Balanced**: Ollama for `simple-summary`, `cheap-classifier`; Anthropic for the rest
- **Turbo**: always Anthropic regardless

### 2.4 Observability integration (NEW — leverage PR #18 + #21)

- `OllamaProvider.chat()` instruments with OTel: span name `gen_ai.invoke_agent` → child span `gen_ai.execute_tool` per tool call (per the two-tier semconv requirement, footgun #14)
- Add Prometheus counter `stavr_provider_requests_total{provider="ollama",model="...",status="..."}`
- Add histogram `stavr_provider_latency_seconds{provider="ollama",model="..."}`
- Add to `pino` log line: `correlation_id` from `AsyncLocalStorage`

### 2.5 Tests

- `tests/steward/providers/ollama.test.ts` — mock HTTP, verify selection, error handling, timeout
- `tests/steward/planner-routing.test.ts` — per-profile × capability matrix
- `tests/observability/ollama-metrics.test.ts` — verify Prometheus labels + OTel spans

### 2.6 Commit + push

```powershell
git add src/steward/providers/ollama.ts src/steward/planner.ts src/types/stavr-bom.ts tests/
git commit -s -m "feat(steward): OllamaProvider + profile-aware local routing + observability"
git push -u origin feat/v0.4-visible-bundle
```

---

## PHASE 3 · Dashboard v8 visual refresh (~5h)

Port the v8 visual language to the existing `src/dashboard/` (currently v0.3 Dark 2.0).

### 3.1 Rename Home → Helm

- `src/dashboard/pages/home.ts` → `helm.ts`; redirect `/dashboard` → `/dashboard/helm`
- Update `src/dashboard/index.ts` route registrations + NAV_ENTRIES
- Update `src/dashboard/shell.ts` page title + nav label

### 3.2 Tokens

`src/dashboard/tokens.ts` — add v8 palette:
- `--rust-glow: rgba(184, 84, 42, 0.4)` (new)
- `--bg-popover: rgba(14, 16, 22, 0.92)` (new — for floating inspector)
- Verify all glass surfaces have `backdrop-filter: blur(24px) saturate(140%)`

### 3.3 Helm page restructure

`src/dashboard/pages/helm.ts` becomes the 5-band stack matching v8:
- L4 INTENT (click → opens Steward sheet)
- L3 PLANS (band-rich with 4 drill cards visible by default)
- L2 WORKERS (dots row; clickable → floating inspector)
- L1 TOOL CALLS (histogram → routes to Diagnostics)
- L0 SYSTEMS (sys-chips; clickable → inspector)

Reference `design-mockups/dashboard-mockup-v8.html` — copy markup/CSS verbatim where appropriate; refactor into `src/dashboard/components/`.

### 3.4 Topology page rewrite — daemon at center

`src/dashboard/pages/topology.ts` complete rewrite to match v8:
- Center: stavR daemon (rust disc with rune + pulse rings)
- Inner ring: Steward, Watchdog (dashed border = external supervisor — NOT in stavR), runestone.db, lessons.db (placeholder for v0.5), credential vault
- Middle ring: workers (live data from worker store)
- Outer ring: external systems (live data from `src/bricks/registry.ts`)
- Animated dashed-flow ribbons (SVG path animations, no DUPLO bricks)
- Mode switcher at bottom: RADIAL active · HEAT · HISTORY

### 3.5 Floating inspector component

New `src/dashboard/components/floating-inspector.ts`:
- Single global popover, positioned via `getBoundingClientRect()` of click target
- Content interface: `{icon, title, sub, sections[], actions[]}`
- Wire into Helm L2 dots, Helm L0 sys-chips, Topology nodes

### 3.6 Smooth timeline component

New `src/dashboard/components/timeline.ts`:
- Fixed-position bottom strip, ~40px tall
- SVG path with cubic-bezier smoothing (NOT histogram bars)
- Rust gradient fill, multi-color stroke
- Event dots overlaid at significant moments only
- Live cursor at "now" with pulsing ring
- Mount on every dashboard page

### 3.7 Watchdog pip in top rail (revised — leverages new endpoints)

New status pip in `src/dashboard/shell.ts` top rail:
- Polls `/healthz` every 5s + reads selected `/metrics` lines (RSS, eventloop_lag p99) every 30s
- Combined health computed client-side: 🟢 healthy / 🟡 degraded / 🔴 down
- Click → opens watchdog incidents sheet (placeholder for now; full sheet ships when stavr-tray binary lands per ADR-033)

### 3.8 Tests

- `tests/dashboard/helm.test.ts`
- `tests/dashboard/topology.test.ts`
- `tests/dashboard/floating-inspector.test.ts`
- `tests/dashboard/watchdog-pip.test.ts` — verify it reads from `/healthz` + `/metrics`, not in-process

### 3.9 Commit + push

```powershell
git commit -s -m "feat(dashboard): v8 visual refresh — Helm + daemon-center topology + floating inspector + smooth timeline + watchdog pip via /healthz+/metrics"
git push
```

---

## PHASE 4 · MCPs page (~3h)

### 4.1 Static registry data

`src/dashboard/data/mcp-registry.ts` — hand-curated snapshot of top ~30 MCP servers from github.com/mcp:

```typescript
export interface MCPServerEntry {
  id: string;
  name: string;
  author: string;
  description: string;
  popularity: number;
  category: 'dev' | 'database' | 'browser' | 'productivity' | 'game' | 'design' | 'monitoring';
  install_url: string;
  logo_emoji?: string;
}

export const MCP_REGISTRY: MCPServerEntry[] = [
  { id: 'github', name: 'GitHub', author: 'github', description: '...', popularity: 29821, category: 'dev', install_url: 'https://github.com/mcp/github/github-mcp-server' },
  { id: 'unity', name: 'Unity', author: 'CoplayDev', description: 'Control the Unity Editor from MCP clients', popularity: 9587, category: 'game', install_url: 'https://github.com/mcp/coplaydev/unity-mcp' },
  // ... 28+ more (use snapshot from memory `SESSION_2026_05_16.md` referencing github.com/mcp 2026-05-16)
];
```

### 4.2 MCPs page

`src/dashboard/pages/mcps.ts`:
- Three tabs: Browse · Installed · Auth-needed
- Search input + sort dropdown + category filter
- Card grid (3 cols) per v8 mockup
- Installed section reads from `src/bricks/registry.ts`

### 4.3 Install action (placeholder for v0.4)

Install button shows "Coming soon — paste URL in `~/.stavr/bricks/manifest.yaml` for now" tooltip. Real install flow is v0.6+. This phase delivers the BROWSING surface live.

### 4.4 Nav update

Add MCPs to top nav between Diagnostics and Settings.

### 4.5 Tests

- `tests/dashboard/mcps.test.ts`

### 4.6 Commit + push

```powershell
git commit -s -m "feat(dashboard): MCPs page — browse github.com/mcp registry + installed view"
git push
```

---

## PHASE 5 · Capture ⊕ button + Settings sub-pages + per-profile capability matrix (~5h)

### 5.1 Capture button + modal

`src/dashboard/components/capture-button.ts`:
- Floating button bottom-right (dock pattern from v8)
- Auto-snapshot: URL, active page, in-flight BOMs, recent 60s events, daemon health (read `/healthz` + `/metrics`)
- Comment textarea + type radio (bug/feature/investigate/todo) + priority radio
- "Send to Steward" → POST `/dashboard/capture`

### 5.2 Capture endpoint + routing

`src/tools/capture.ts`:
- Receives `{snapshot, comment, type, priority, related_id?}` payload
- For v0.4: write to `~/.stavr/captures/{type}.jsonl` (append-only log)
- Future: Steward routes to GitHub Issues / Linear per Settings → Captures config
- **Audit-class event** per ADR-030 — emit `capture_filed` event so it survives 90d retention
- Returns issue ID + destination

### 5.3 Settings → Captures sub-page

`src/dashboard/pages/settings.ts` — add Captures sub-tab:
- Default route per type (today: all default to local file)
- "Change" button per row (no-op for v0.4, lights up in v0.6+)

### 5.4 Settings → Diagnostics sub-page (NEW · runtime toggle pattern)

Per `memory/project_stavr_runtime_toggles.md` — make `STAVR_DEBUG_ENABLED` (and per-endpoint subsets) toggleable from the dashboard with no PM2 restart required. Operator ergonomics fix.

**Daemon side (~1.5h):**

- New table in runestone.db (idempotent migration in `src/persistence.ts`):
  ```sql
  CREATE TABLE runtime_toggles (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    set_at INTEGER NOT NULL,
    set_by TEXT NOT NULL,
    expires_at INTEGER
  );
  ```
- New MCP tools `runtime.set_toggle { key, value, ttl_minutes?, set_by? }` and `runtime.get_toggles {}`. Both emit/return audit-class events.
- Modify the `/debug/*` endpoint guard to check `runtime_toggles` first, fall back to `process.env.STAVR_DEBUG_ENABLED`. Return 404 (not 403) when locked — preserve the security pattern.
- Background sweep evicts expired toggles every 60s; emits `runtime_toggle_expired` event on eviction.
- Granular keys: `STAVR_DEBUG_ENABLED` (master), `STAVR_DEBUG_HEAP`, `STAVR_DEBUG_CPU`, `STAVR_DEBUG_REPORT`. Endpoint guards check master OR per-endpoint key.

**Dashboard side (~1h):**

- `src/dashboard/pages/settings.ts` — add Diagnostics sub-tab (sibling to Captures):
  - Three toggle rows (heap-snapshot · cpu-profile · diagnostic-report) — switch + countdown for auto-revert + "extend by 1h" button
  - Three "take now" buttons firing `POST /debug/*` directly
  - "Recent diagnostics (last 24h)" list — queries event log for `heap_snapshot_taken`, `cpu_profile_taken`, `diagnostic_report_taken`
  - Default TTL when toggling on: 60 min

**Tests:**
- `tests/observability/runtime-toggles.test.ts` — set/get/expire/audit-event
- `tests/dashboard/settings-diagnostics.test.ts` — toggle UI, countdown, take-now actions
- `tests/observability/debug-endpoint-guard.test.ts` — runtime-toggle takes precedence, env var is fallback

### 5.5 Per-profile capability matrix (was 5.4)

`src/dashboard/pages/capabilities.ts` — rewrite to v8:
- Steward pinned card at top (big rune badge, model dropdown, PIN toggle)
- 10×3 matrix (capability rows × Turbo/Balanced/Eco columns)
- Click cell → inline brain picker (dropdown of available models: Anthropic + Ollama models from `OllamaProvider.listAvailableModels()`)
- 🔒 icon for pinned-across-profiles slots
- Below: 3 compact profile cards for budgets

### 5.6 Tests

- `tests/dashboard/capture.test.ts`
- `tests/tools/capture.test.ts`
- `tests/dashboard/capabilities.test.ts`

### 5.7 Commit + push

```powershell
git commit -s -m "feat(dashboard): capture ⊕ + Settings/Captures + Settings/Diagnostics runtime toggles + per-profile capability matrix"
git push
```

---

## PHASE 6 · Integration test + PR (~1h)

### 6.1 Full check

```powershell
npm run check
```

If anything fails: fix. If can't fix in 30 min, stop and write `.work/2026-05-17/blockers.md`, push branch, open `[STUCK]` PR.

### 6.2 Manual smoke test (with PM2)

```powershell
pm2 restart stavr --update-env
# Visit http://127.0.0.1:7777/dashboard
```

Verify:
- Helm renders 5 bands; L3 has drill cards visible; L2 has dots
- Click L2 dot → floating inspector opens, stays on Helm
- Click L4 → Steward sheet
- Topology shows daemon at center, glass discs, animated ribbons
- Smooth timeline at bottom
- Watchdog pip green in top rail (reads `/healthz` + `/metrics`)
- MCPs page lists ~30 servers; Install buttons present
- Capture ⊕ opens modal; "Send to Steward" writes to `~/.stavr/captures/`
- Settings → Capabilities matrix renders; Ollama models in dropdowns if Ollama running
- Settings → Captures sub-page shows route config (read-only for now)

### 6.3 Open PR

```powershell
gh pr create --base main --title "feat(v0.4): visible-value bundle — Helm + local LLMs + MCPs + Capture" --body "$(cat .work/2026-05-17/progress.md)

## What ships
- Dashboard v8 visual refresh — Helm rename, daemon-center topology, glass discs, floating inspector, smooth timeline, watchdog pip via /healthz+/metrics
- OllamaProvider — local LLM integration with profile-aware routing + OTel + Prometheus instrumentation
- MCPs page — browse 30+ servers from github.com/mcp registry, Installed view
- Capture ⊕ button — snapshot + comment + type → routes via Steward to local jsonl (v0.4) / GitHub Issues (v0.6+)
- Settings → Capabilities per-profile matrix — 10 capability rows × 3 profile columns, click to swap model
- Settings → Captures route config sub-page

## What's NOT in this PR (separate runs, see ADRs 032-035)
- v0.5 Steward portability (ADR-032)
- v0.6 stavr-tray companion (ADR-033 — revised from stavr-watch)
- v0.6 OAuth 2.1 + RIs on trust scopes (ADR-035 phase 1)
- v0.7 A2A endpoint (ADR-035 phase 2)
- v0.8 stavr-spawn (ADR-035 phase 3)
- v0.9 Fleet + Model Registry (ADR-035 phase 4)

## Manual prereq
Phase 0 in OVERNIGHT_TASK_2026_05_17.md — Ollama install + at least one model pulled.

## Test
- npm run check passes
- Manual smoke 6.2 verified
- New tests: ollama provider mock, planner routing matrix, helm/topology/inspector/capture/capabilities renders, watchdog pip uses /healthz+/metrics"
```

---

## Acceptance criteria

1. `npm run check` passes
2. Daemon starts via PM2 (`pm2 restart stavr --update-env`); `/healthz` returns 200
3. `/metrics` exposes new `stavr_provider_*` counters/histograms after one Ollama call
4. OTel traces show `gen_ai.invoke_agent → gen_ai.execute_tool` two-tier (verify in Jaeger if running)
5. Helm page renders v8 visual; L2 dots clickable → floating inspector
6. Topology page renders v8 with daemon at center
7. MCPs page shows ≥25 servers
8. Capture ⊕ writes to `~/.stavr/captures/`
9. Capabilities matrix shows Ollama models in dropdown when Ollama running
10. With profile=Eco + Ollama running, BOM step tagged `simple-summary` routes to local
11. With profile=Turbo, same step always routes to opus regardless of Ollama state
12. Watchdog pip in top rail polls `/healthz` + `/metrics` (verify in browser devtools network tab)

## Stop conditions

- Phase 2 Ollama provider tests fail and can't be fixed in 30 min — daemon-running fallback path doesn't work
- Phase 3 visual refresh introduces TypeScript errors that cascade
- Any phase introduces a `npm run check` failure that wasn't there at start of phase
- Wall clock > 16 hours

When stopping:
1. Push branch with last good commit
2. Write `.work/2026-05-17/blockers.md` with failure details
3. Open PR with `[STUCK]` prefix
4. Don't leave uncommitted work

---

## After this run lands

In rough order of value:

1. **v0.5 Steward portability** — ADR-032; spec ready as `proposed/v0.5-steward-portability-bom.md` (needs re-drafting in current chat after Cowork-fs incident lost it). ~12-15h.
2. **v0.6 stavr-tray companion** — ADR-033 (revised); spec to draft. ~6-8h. Can run in parallel with v0.5.
3. **v0.6 OAuth 2.1 + RIs** — ADR-035 phase 1; spec to re-draft. ~10-12h.
4. **v0.7 A2A endpoint** — ADR-035 phase 2; spec to re-draft. ~6-8h.
5. **v0.8 stavr-spawn + 1 remote** — ADR-035 phase 3; spec to re-draft. ~12-15h.
6. **v0.9 Fleet + Model Registry** — ADR-035 phase 4; spec to re-draft. ~10-12h.

Total roadmap to v1.0: ~55-70h after this run. ~5-6 more autonomous overnight runs.
