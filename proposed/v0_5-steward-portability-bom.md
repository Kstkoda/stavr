# OVERNIGHT TASK · v0.5 · Steward portability — subprocess + 3-layer state + Model Runtime

Single dispatchable brief for Claude Code (Opus 4.7) autonomous run.

**Estimated wall-clock**: 12–15 hours sequential. Single worker, single PR. This is roughly 3× the polish bundle — the move from in-daemon Steward to subprocess Steward touches process supervision, IPC framing, three new SQLite stores with drizzle migrations, and a parity-shadowing cutover. Do not compress.

**Stop conditions**: end of any phase if `npm test` regresses (must stay at 564+ passing) and can't be fixed in 45 min, `npm run build` fails, or the parity-shadow log (P5) diverges by >5% on byte-for-byte BOM comparison and the divergence isn't classified within 30 min. Visual fidelity on the new /diagnostics steward panel that "doesn't quite match" is NOT a stop condition — ship what you have and note deltas in the PR.

**Do NOT pause for approval** between phases. Commit + push at end of each phase. Open PR at end of Phase 6.

**Open questions** at the end of this brief list four design decisions that are NOT pre-decided. If you hit one during implementation, pick the lower-risk path and note your choice in the PR description — do not block on it.

---

## Why this bundle

The 2026-05-15 OOM (heap exhausted at 4 GB, mark-compact freed 0.6 MB out of 4 GB) was technically a retention bug, fixed in PR #16. But it crystallized two architectural problems that ADR-032 names directly:

1. **Steward's in-process posture** means a Steward-side leak (lessons store growing unbounded, planner context retention bug, anything) cascades to MCP serving + dashboard + every connected worker. Same event loop, same crash blast radius, same memory ceiling.
2. **Provider hard-coding** means swapping to GPT-5.5 or Llama 3.3 70B requires touching planner code, not config. We already shipped `OllamaRuntime` in v0.4 (`src/steward/providers/ollama.ts`) but the abstraction is leaky — the planner still imports the Anthropic-shaped provider directly.

Kenneth's strategic asks on 2026-05-16 (carried into ADR-032 §Context):
- Steward should be more self-driven (proactive proposing, not just reactive)
- Steward should learn over time (lessons distilled from outcomes)
- Steward should be model-agnostic (Opus today, GPT tomorrow, Llama next week)
- Continuity across model swaps (state survives the swap)

These converge into one architectural move: **Steward becomes its own subprocess, talking to core via MCP, with state stored in core, behind a uniform Model Runtime interface.** That is the headline of ADR-032 §Decision.

**What's in this bundle**: 3-layer state stores (P1), Model Runtime abstraction (P2), subprocess extraction with PM2 supervision (P3), three autonomy levels (P4), parity-shadow migration (P5), diagnostics panel + PR (P6).

**What's explicitly out**: dashboard visual changes (frozen post-polish PR #24), MCP transport semantics, persistence.ts schema changes beyond the new tables, and tests/dashboard/* (visual freeze).

---

## Reference reading (read these first, in order)

1. `CLAUDE.md` — project invariants. Invariants #1 (tests are derivative) and #2 (never lose files) both apply here. Files in this BOM that will exceed 15KB: `src/steward-agent/main.ts`, `src/steward-agent/loop.ts`, the three migration SQL files. Verify each via `bash stat -c %s` + `bash tail -5` before commit.
2. `adr/032-steward-model-portable-agent.md` — the architectural decision. Sections you will reference repeatedly:
   - §Decision 1 → P3 subprocess extraction (the spawner + healthcheck shim split)
   - §Decision 2 → P1 three SQLite stores (memory.db / lessons.db / prefs.db)
   - §Decision 3 → P2 Model Runtime interface (`src/steward-agent/runtimes/types.ts`)
   - §Decision 4 → P4 autonomy levels (reactive / scheduled / proactive)
   - §Decision 5 → P2 output validation (Zod schemas, 3× retry, surface as Decision card)
   - §Decision 6 → P1 snapshot + event log restart
   - §Decision 9 → P3 boundary: trust scope + no-go list stay in daemon, NOT Steward
3. `proposed/v0.4-scheduler-bom.md` — referenced from ADR-032 §Decision 4 (scheduled autonomy). Read §Backlog + dedupe sections for the priority/capacity model P4 inherits.
4. `src/steward/v02-wiring.ts` — current in-daemon wiring entry point. `wireV02Subsystem()` is what P3 must replace with a *spawner* that fork-execs the agent and re-exposes the same handle shape.
5. `src/steward/planner.ts`, `src/steward/executor.ts`, `src/steward/loop.ts` — the planner/loop/state machinery that physically moves into `src/steward-agent/`. ~1240 LOC total.
6. `src/steward/providers/{types.ts,anthropic.ts,claude-code.ts,ollama.ts}` — the existing provider abstraction. P2 refactors this into the Model Runtime interface. The three concrete providers map to AnthropicRuntime / OpenAIRuntime (new) / OllamaRuntime (rewire `claude-code.ts` as a transport detail, not a third runtime).
7. `src/steward/ipc.ts` — already a partial fork-based IPC scaffold. P3 keeps `child_process.fork` framing as the default; the IPC-protocol open question (UDS vs named pipe vs TCP loopback) only matters if `fork` proves insufficient for cross-host federation later.
8. `src/steward/store.ts` — claim/release for the *role* (Spec 48). Distinct from the three new state stores P1 introduces. Don't conflate.
9. `ecosystem.config.cjs` — current PM2 supervisor for `stavr`. P3 appends a second app entry for `stavr-steward-agent` here.
10. `docs/stavr-progress-and-plan.md` — 15 footguns. Items 1–9 carried below.

---

## Canonical targets — table to keep open

| Phase | Spec source | Target |
|------|-------------|--------|
| P1 stores | ADR-032 §Decision 2 | `~/.stavr/steward/{memory,lessons,prefs}.db`, schema in `migrations/00{2,3,4}_steward_*.sql`, init via `src/steward-agent/db/init.ts` |
| P2 runtimes | ADR-032 §Decision 3 + §Decision 5 | `src/steward-agent/runtimes/{types,anthropic,openai,ollama}.ts`, output Zod schemas in `src/steward-agent/runtimes/schemas.ts` |
| P3 subprocess | ADR-032 §Decision 1 | `src/steward-agent/main.ts` (new entry), `src/steward/spawner.ts` (replaces v02-wiring.ts), `ecosystem.config.cjs` second app entry |
| P4 autonomy | ADR-032 §Decision 4 + v0.4 scheduler BOM | `src/steward-agent/autonomy/{reactive,scheduled,proactive}.ts`, mode selector in `prefs.db` |
| P5 migration | ADR-032 §Decision 7 (3-loop feedback) | parity shadow harness at `src/steward/parity.ts`, comparison report at `tmp/parity/<bom-id>.json` |
| P6 diagnostics | dashboard visual freeze respected | new steward panel in `src/dashboard/pages/diagnostics.ts` is ALLOWED (additive, not restyle), screenshots to `design-mockups/v0_5_steward_screenshots/` |

---

## Don't touch

- `src/dashboard/*` — **visual freeze post-PR #24**. The single exception is *additive* content in `src/dashboard/pages/diagnostics.ts` to surface the new steward subprocess panel (PID, autonomy mode, last heartbeat, lessons count). No restyling, no token changes, no shell.ts edits.
- `src/mcp/*` — MCP transport semantics frozen
- `src/persistence.ts` schema — frozen EXCEPT for additive tables required by Steward state. New tables go in their own .db files (memory.db / lessons.db / prefs.db), NOT runestone.db. Touching `src/persistence.ts` other than to add the optional `steward_agent_pid` column on the daemons table = stop and revert.
- `tests/dashboard/*` — visual contract locked. The negative assertions added in PR #24 (`not.toContain('topo-mode-chips')`, `not.toContain('class="topo-bus"')`, `not.toContain('enterprise bus')`, `not.toContain('class="bus"')`, `not.toContain('this · 8421')`, `not.toContain('STAVR DAEMON')`) are regression locks for invariant #1. Do not weaken them.
- `src/steward/store.ts` — Spec 48 role claim/release stays as-is. The three new state stores are independent.
- `migrations/001_bom_schema.sql` — existing schema is immutable.

Touching any of those = stop, revert, leave a note in the PR description.

---

## Hard rules (read before P0)

1. **Tests are derivative, not authoritative.** CLAUDE.md invariant #1. If a test asserts on planner internals that this work refactors, delete the assertion in the same commit as the refactor. Preserving a test that asserts on the old in-process call shape is a regression, not safety.
2. **Never-lose-files.** CLAUDE.md invariant #2. Every file >15KB after edit verified via `bash stat -c %s file` + `bash tail -5 file` BEFORE `git add`. If the tail doesn't end with the expected closing brace / `EOF` sentinel, the file is truncated. Recover via heredoc append. Files this BOM is likely to push past 15KB: `src/steward-agent/loop.ts`, `src/steward-agent/main.ts`, the three migrations, `src/steward/parity.ts`.
3. **DCO sign-off.** Every commit `git commit -s`. No exceptions.
4. **Per-phase commits.** One commit per phase. Don't batch. Each phase commit independently passes `npm test` and `npm run build`. If a phase regresses, revert just that commit.
5. **Push at end of each phase.** Don't accumulate unpushed commits — if the session is killed (as the polish run was), the recovery agent needs every committed phase visible on `origin`.
6. **Trust scope + no-go list stay in daemon.** ADR-032 §Decision 9. Steward operates within constraints; it does not enforce them. The output validator in P2 double-checks no tool-call escape — but enforcement is the daemon's job. Do not lift TrustStore calls into `src/steward-agent/`.
7. **Output validation mandatory.** ADR-032 §Decision 5. Every Model Runtime call returns a Zod-validated object. Malformed → reject + retry up to 3× with sharper instruction; on 3rd failure surface as a Decision card via existing `decisions` infrastructure, do not crash the loop.
8. **Process safety.** Steward subprocess crash must NOT crash the daemon. PM2 supervises both with `max_restarts: 3, restart_delay: 30000` (mirror the daemon entry). Heartbeat timeout in the daemon → mark Steward unhealthy, surface on /diagnostics, do not auto-restart from inside the daemon.
9. **Migration is shadow-first.** ADR-032 implementation note. The in-daemon Steward keeps planning real BOMs throughout P5. The subprocess Steward shadows in parallel, writing its planned BOMs to the parity log but NOT dispatching. Cutover is a separate, reviewable commit after parity-pct passes the gate (see Open Questions §4 for who picks the gate).

---

## P0 · Pre-flight (Kenneth, before CC kicks off)

~10 min. Kenneth confirms:

1. `git status` clean on `main`, PR #24 (v0.4.1 polish) merged
2. Recent commits include `5a10092` (topology port fix), `b3aebba` (streams/decide/toolkit alignment), `a3c204d` (topology drift fix), `dbd7186` (iron palette)
3. `pm2 status` shows `stavr` online with restart count <5, daemon healthy on :7777
4. `npm test` passes locally — baseline 564+ tests passing
5. `npm run build` clean
6. Trust scope created: `rapid · steward portability · 12-15h · cap 2.5M tokens` (3× polish since the surface area is bigger)
7. Disk space: `~/.stavr/` has at least 500 MB free (three new sqlite files + parity logs over the run)
8. ADR-032 §Status flipped from "Proposed" to "Accepted" by Kenneth (the spec sign-off the ADR §Acceptance requires)

Then dispatch CC with: `cc run --prompt proposed/v0_5-steward-portability-bom.md --profile turbo`

---

## P1 · Three-layer state stores (2 h)

**Files**: `migrations/002_steward_memory.sql`, `migrations/003_steward_lessons.sql`, `migrations/004_steward_prefs.sql`, `src/steward-agent/db/init.ts`, `src/steward-agent/db/types.ts`, tests in `tests/steward-agent/db/*`

### Sub-tasks

1. Three SQLite files under `~/.stavr/steward/`. Use `better-sqlite3` (already a dep) for the bindings. Schema migrations via plain SQL files applied by `src/steward-agent/db/init.ts` on first boot — mirror the existing `migrations/001_bom_schema.sql` pattern, NOT drizzle ORM. (The brief slot for drizzle is a placeholder; project convention is hand-rolled SQL files + `applyMigrations(db, dir)` walker. If a real drizzle migration is desired, surface as an open question — don't introduce a new dep mid-flight.)
2. **memory.db** — Letta/MemGPT tiers per ADR-032 §Decision 2:
   - `working_memory(key TEXT PRIMARY KEY, value_json TEXT, updated_at TEXT)` — small (<4 KB) hot context the planner sees on every call
   - `archival_memory(id TEXT PRIMARY KEY, embedding BLOB NULL, content TEXT, source TEXT, created_at TEXT)` — opaque blob store; vector column nullable because P1 ships without embeddings. (Embeddings are a v0.6 follow-up.)
   - `episodic_log(seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, kind TEXT, correlation_id TEXT, payload_json TEXT)` — every BOM step's outcome lands here. Drives the snapshot trigger in §Decision 6.
3. **lessons.db** — distilled patterns:
   - `lessons(id TEXT PRIMARY KEY, title TEXT, body TEXT, source TEXT, distilled_from_json TEXT, created_at TEXT, status TEXT)` — status ∈ {active, demoted, archived}
   - `lesson_outcomes(lesson_id TEXT, bom_id TEXT, applied_at TEXT, outcome TEXT, delta_cost_usd REAL)` — drives auto-demotion (ADR-032 §Consequences "auto-demotion")
   - Index on `lessons(status, created_at)` for the prompt-injection query path
4. **prefs.db** — user-explicit preferences:
   - `prefs(key TEXT PRIMARY KEY, value_json TEXT, updated_at TEXT)` — flat KV. Reserved keys: `autonomy_mode` (P4), `pinned_runtime`, `default_profile`, `cost_cap_daily_usd`
   - No migration history — prefs are intentionally flat and trivially rebuildable from a backup file
5. **`src/steward-agent/db/init.ts`** — function `openStewardDbs(stavrHome: string): { memory, lessons, prefs }` that opens all three, runs pending migrations from `migrations/00{2,3,4}_steward_*.sql`, returns the handles. Same `better-sqlite3` WAL + pragmas as `src/persistence.ts:initEventStore` (foreign_keys=on, journal_mode=WAL, synchronous=NORMAL).
6. **Snapshot/restore** stubs only — ADR-032 §Decision 6 says snapshot every 1000 episodic_log entries OR every 5 min, restore on Steward boot. P1 ships the trigger plumbing (a `snapshot_due()` predicate, a `take_snapshot(workingMemory, activeBomIds)` writer that lands a `snapshots/{ts}.json` file under `~/.stavr/steward/`). Restoration logic is P3 territory (the spawner reads it on cold start).

### Acceptance

- `npm test` includes new tests under `tests/steward-agent/db/`: opening empty home creates all three files, migrations apply, no-op on second open, WAL mode confirmed
- `npm run build` clean
- Manual: `stavr-steward-agent --init-only` (CLI flag added in P3, stub now if needed) creates the three files at `~/.stavr/steward/`
- Files >15KB on disk (the three migration SQL files will trend that direction) verified via `bash stat -c %s` + `bash tail -5`

### Commit

`feat(steward-agent): three-layer state stores — memory / lessons / prefs (P1 of v0.5)`

---

## P2 · Model Runtime interface (2.5 h)

**Files**: `src/steward-agent/runtimes/types.ts`, `src/steward-agent/runtimes/schemas.ts`, `src/steward-agent/runtimes/{anthropic,openai,ollama}.ts`, tests under `tests/steward-agent/runtimes/*`

### Sub-tasks

1. **Interface** at `src/steward-agent/runtimes/types.ts` per ADR-032 §Decision 3:
   ```typescript
   export interface ModelRuntime {
     name: string;
     costPerKtoken: { in: number; out: number };
     contextWindow: number;
     plan(ctx: PlanCtx, tools: ToolSpec[]): Promise<ValidatedBOM>;
     decide(req: DecideReq): Promise<ValidatedChoice>;
     summarize(events: EpisodicEvent[]): Promise<ValidatedDigest>;
   }
   ```
   The three methods replace the current single `complete()` AsyncGenerator on `StewardProvider`. Reason: the planner today asks the provider to "do everything" via prompt-engineered tool calls; ADR-032 §Decision 3 splits the responsibility so output validation (§Decision 5) has a typed schema per call shape.
2. **Schemas** at `src/steward-agent/runtimes/schemas.ts` — Zod schemas for `ValidatedBOM` / `ValidatedChoice` / `ValidatedDigest`. Reuse types from `src/types/stavr-bom.ts` where they line up; tighten where the existing types are too loose (e.g., `cost_max: z.number().positive().max(100)` to catch the off-by-1000 LLM mistake the planner has had to hand-correct twice).
3. **AnthropicRuntime** — adapt `src/steward/providers/anthropic.ts`. Keep the existing `@anthropic-ai/sdk` plumbing; wrap the three-method surface around it. The existing streaming `complete()` becomes an internal helper called by all three methods.
4. **OpenAIRuntime** — new. Use `openai` npm dep if not present (`npm install openai@^4`). Map function-calling tool spec → ToolSpec, normalize the response shape into the same Zod schemas. Defer reasoning-models support to v0.6 (gpt-5.5 base model only for P2).
5. **OllamaRuntime** — adapt `src/steward/providers/ollama.ts`. Local model, function-calling support varies by model; for models without native function calling, fall back to JSON-mode + post-hoc schema validation (which P2 already requires).
6. **Selection** — `runtimeFor(taskKind: 'plan'|'decide'|'summarize', prefs: PrefsStore): ModelRuntime`. Reads `prefs.pinned_runtime` (default `anthropic-opus`) and an optional `task_runtime_overrides_json` map. Per-task override exists so the daily self-critique batch (ADR-032 §Decision 7) can pin Ollama for cost reasons without changing the live planner runtime.
7. **Retry policy** — 3× with sharper instruction per ADR-032 §Decision 5. On the 3rd failure, do NOT throw — return a `ValidationFailure` sentinel and the calling site (planner.ts in P3) surfaces it as a Decision card. Crashing the loop on bad LLM output is the failure mode this avoids.
8. The existing `claude-code.ts` provider (Max-OAuth subprocess path) is NOT a fourth runtime — it's a transport detail of AnthropicRuntime. P2 wires it as `AnthropicRuntime({ transport: 'claude-code' | 'api' })`. The `claude-code` path stays available because users with Max plans rely on it.

### Acceptance

- Three runtime implementations export from `src/steward-agent/runtimes/index.ts`
- `tests/steward-agent/runtimes/anthropic.test.ts` — mocked SDK, asserts the three methods return schema-validated objects, asserts the 3× retry escalates instruction per attempt, asserts ValidationFailure on 3rd consecutive miss
- Same coverage for OpenAI and Ollama runtimes
- `npm run build` clean
- Memory: a single planner call should allocate <5 MB transient — assert via a `--expose-gc` test if feasible, else skip with TODO

### Commit

`feat(steward-agent): Model Runtime interface — Anthropic / OpenAI / Ollama (P2 of v0.5)`

---

## P3 · Steward subprocess extraction (3 h)

**Files**: `src/steward-agent/main.ts`, `src/steward-agent/loop.ts`, `src/steward/spawner.ts` (replaces `v02-wiring.ts` shape), `ecosystem.config.cjs` (append entry), `src/dashboard/data/steward-health.ts` (additive only)

### Sub-tasks

1. **`src/steward-agent/main.ts`** — new entry point. CLI: `stavr-steward-agent [--daemon-url URL] [--init-only]`. On boot:
   - Open the three stores from P1
   - Restore latest snapshot if present (load `working_memory`, active BOM IDs, replay `episodic_log` entries since snapshot timestamp per ADR-032 §Decision 6)
   - Resolve runtime per prefs (P2 selector)
   - Connect IPC link to daemon (use the existing `src/steward/ipc.ts` `makeStewardLink()` — fork-channel framing; the IPC-protocol choice is in Open Questions §1)
   - Send `{type:'ready'}`, then enter loop
2. **`src/steward-agent/loop.ts`** — the planner/loop machinery currently in `src/steward/loop.ts` + `planner.ts` + `executor.ts`, refactored to call ModelRuntime methods (P2) and emit/receive IPC envelopes (P1's existing ipc.ts wire format). Approximate LOC migrating: ~1240. Sub-tasks within:
   - Pull state reads (working_memory, lessons) from the new stores instead of in-memory caches
   - Replace direct `planner.plan(...)` calls with `runtime.plan(ctx, tools)`
   - Replace `provider.complete(...)` consumers with the three typed methods
   - Wire output validation per ADR-032 §Decision 5 — Zod check, 3× retry, Decision-card fallback
3. **`src/steward/spawner.ts`** — replaces `src/steward/v02-wiring.ts` semantically. Same exported handle shape (`V02SubsystemHandle`) so callers in `src/transports.ts` and `src/daemon.ts` don't change. New responsibilities:
   - `child_process.fork('dist/steward-agent/main.js', argv, { silent: true })`
   - Wrap with `makeDaemonLink()` (existing `src/steward/ipc.ts`)
   - Heartbeat: daemon sends `{type:'ping'}` every 10s; child responds `{type:'pong'}`. Missed 3 pongs → mark unhealthy, surface on /diagnostics, do NOT auto-restart (PM2 handles that per §rule 8)
   - Stop method: `shutdown()` sends `{type:'shutdown'}`, waits 2s, then SIGTERM (existing ipc.ts behavior)
4. **`ecosystem.config.cjs`** — append second app entry:
   ```js
   {
     name: 'stavr-steward-agent',
     script: 'dist/steward-agent/main.js',
     args: ['--daemon-url', 'http://127.0.0.1:7777'],
     max_restarts: 3,
     restart_delay: 30000,
     autorestart: true,
     kill_timeout: 10000,
     max_memory_restart: '2000M',
     out_file: './tmp/pm2-steward.out.log',
     error_file: './tmp/pm2-steward.err.log',
     time: true,
   }
   ```
   Lower memory ceiling (2 GB) than the daemon because Steward shouldn't be holding events; if it climbs near the ceiling that's a planner-context-retention bug worth a page.
5. **`src/dashboard/data/steward-health.ts`** — additive data fetcher only. Returns `{ pid: number | null, status: 'up' | 'down' | 'unhealthy', last_heartbeat_at: string | null, autonomy_mode: string, lessons_count: number, memory_working_keys: number }`. Wire into the diagnostics page in P6.
6. **`src/persistence.ts`** — the ONE additive change permitted: add an optional `steward_agent_pid INTEGER` column on the `daemons` table via a new migration `005_steward_agent_pid.sql`. The spawner writes its child's PID here on fork so the daemon can show it on /diagnostics even after the heartbeat link drops.

### Acceptance

- `pm2 start ecosystem.config.cjs` brings up BOTH `stavr` and `stavr-steward-agent`
- `pm2 list` shows both online, both with restart count 0 after 60s soak
- Killing the steward-agent process by PID: `stavr` daemon stays up, /diagnostics shows steward `down`, PM2 respawns within 30s (the `restart_delay`)
- Killing the daemon process: PM2 restarts daemon; steward survives, reconnects when daemon is back (or is restarted by PM2 itself if the IPC link is fatal to it — current `ipc.ts` exits on disconnect, so PM2 will respawn)
- Existing tests that hit the v02 subsystem still pass — the spawner exports the same handle shape (per invariant #1, any test asserting on *in-process* internals is rewritten in this commit)
- `npm test` and `npm run build` clean

### Commit

`feat(steward-agent): subprocess extraction + PM2 supervision (P3 of v0.5)`

---

## P4 · Autonomy levels (1.5 h)

**Files**: `src/steward-agent/autonomy/{reactive,scheduled,proactive}.ts`, `src/steward-agent/autonomy/index.ts`, tests under `tests/steward-agent/autonomy/*`

### Sub-tasks

1. **Mode selector** — `prefs.db` key `autonomy_mode` ∈ {`reactive`, `scheduled`, `proactive`}. Default: `reactive` (the v0.5 default — see Open Questions §3 on whether scheduled/proactive ship behind a flag).
2. **Reactive** (today's behavior, no functional change) — wake on `worker_step_complete` / `bom_step_done` / `decision_response` events, plan, sleep. Lift the existing loop trigger into this module so the three modes share one dispatcher.
3. **Scheduled** — per `proposed/v0.4-scheduler-bom.md` §Backlog. Cron-like timers drive `/events`: a `steward_tick` event fires per schedule, the reactive dispatcher picks it up. Capacity (max in-flight BOMs) and dedupe (same correlation_id within window) from the v0.4 brief. The cron syntax accepted: minute-level granularity (`*/10 * * * *`). Daily self-critique at `0 3 * * *` per ADR-032 §Decision 7.
4. **Proactive** — Steward proposes BOMs from observed patterns + lessons. Hard-bounded by:
   - Active trust scope must cover the proposed BOM's risk envelope (enforcement stays in daemon per rule §6)
   - Daily cost cap from `prefs.cost_cap_daily_usd` (default $2.00). Steward halts on cap.
   - Per-pattern dedupe — proactive proposals for the same pattern within 24h are auto-merged into the same Decision card, not stacked.
   - User still approves every BOM. The line ADR-032 §Decision 4 draws stays put: **Steward proposes, user approves.**
5. **Probation harness** — a new runtime (e.g., `Grok3Runtime` in v0.6) runs in shadow against live events for N=50 BOMs, comparing planned BOMs to active runtime's. Promotion requires correlation >0.8 per ADR-032 §Decision 8. P4 ships the scaffolding (`src/steward-agent/autonomy/probation.ts`); actually exercising it is v0.6.

### Acceptance

- Three new tests under `tests/steward-agent/autonomy/`: mode selector reads from prefs.db, reactive trigger fires on event, scheduled trigger fires on cron tick (mocked clock), proactive proposal respects cost cap (assertion: when daily-cost-so-far >= cap, no `bom_proposed` event fires for proactive source)
- `/dashboard/diagnostics` steward panel surfaces current `autonomy_mode` (P6 wires the UI)
- `npm test` + `npm run build` clean

### Commit

`feat(steward-agent): autonomy levels — reactive / scheduled / proactive (P4 of v0.5)`

---

## P5 · Migration + parity tests (2 h)

**Files**: `src/steward/parity.ts`, parity-log writer at `tmp/parity/<bom-id>.json`, tests under `tests/steward/parity.test.ts`, no cutover commit until parity gate passes

### Sub-tasks

1. **Existing in-process Steward keeps planning real BOMs** throughout P5. Do NOT delete `src/steward/v02-wiring.ts` yet — the spawner in P3 lives ALONGSIDE it during shadow.
2. **Parity shadow** — when the daemon fires an event that the reactive dispatcher would handle, the daemon sends the same event to BOTH:
   - the in-process Steward (today's path, drives real BOMs)
   - the subprocess Steward via IPC (P3's path, writes its planned BOM to `tmp/parity/<bom-id>.json` and does NOT dispatch)
3. **Comparison** — `src/steward/parity.ts:diffBoms(a, b)` produces a structured diff over step kind / risk class / cost estimate / step count. Byte-for-byte equality is not the gate (LLM determinism is a hard problem) — the gate is **structural parity**:
   - Same step count: hard
   - Same step kinds in sequence: hard
   - Cost estimate within ±15%: soft (logged, not gating)
   - Same risk envelope: hard
4. **Parity log rotation** — keep last 100 logs in `tmp/parity/`, GC older. The `tmp/` prefix means they don't survive `pm2 restart`; intentional — parity logs are observational, not durable.
5. **Cutover trigger** — see Open Questions §4. P5 ships the *measurement*; the *flip* is a separate commit Kenneth gates on the parity-pct report. The flip itself is a one-line change in `src/daemon.ts` swapping `wireV02Subsystem(...)` → `spawnStewardAgent(...)` and a same-commit delete of `src/steward/{v02-wiring,planner,executor,loop}.ts`.
6. **Tests under `tests/steward/parity.test.ts`** — synthetic BOMs A and B with known divergence, assert `diffBoms` classifies as hard-fail vs soft-warn correctly. Plus one integration test that runs both Stewards on a fixed event and asserts the parity log is written.

### Acceptance

- 50 parity logs accumulate in `tmp/parity/` after a 30-min soak with manual BOM dispatch from the dashboard
- Structural parity ≥ 95% across the 50 logs (the same gate Kenneth uses for the flip)
- `npm test` + `npm run build` clean
- PR description includes the parity-pct summary

### Commit

`feat(steward): parity-shadow harness (P5 of v0.5 — cutover commit gated separately)`

---

## P6 · Smoke + diagnostics panel + PR (1 h)

**Files**: additive content in `src/dashboard/pages/diagnostics.ts`, screenshots in `design-mockups/v0_5_steward_screenshots/`

### Sub-tasks

1. `npm test` — full suite, must pass (baseline 564+ from PR #24)
2. `npm run build` — must succeed
3. `pm2 start ecosystem.config.cjs --update-env` — both `stavr` and `stavr-steward-agent` come up
4. Hit `http://localhost:7777/dashboard/diagnostics` — the existing Proxmox-dense layout from PR #24 gains a new steward subprocess panel. **Additive ONLY** per the don't-touch list — no restyling, no token changes. The panel renders inside the existing diagnostics grid as a new section after `Workers + scopes`:
   - Title: "Steward subprocess"
   - PID, autonomy mode (badge: rust=reactive, sky=scheduled, amber=proactive), last heartbeat (mono timestamp + relative), lessons count, working-memory keys count
   - Bound to the `src/dashboard/data/steward-health.ts` fetcher added in P3
5. Take screenshots: `diagnostics-steward-panel.png`, `topology-with-steward-node.png` (the existing topology renders the subprocess as a `core` node — confirm it shows up), `pm2-list.png` (both processes online)
6. Save to `design-mockups/v0_5_steward_screenshots/`
7. Commit screenshots: `docs(design): v0.5 steward portability screenshots`
8. Open PR:
   - Title: `feat(steward): v0.5 portability — subprocess + 3-layer state + Model Runtime`
   - Body sections: Summary, Phase table (links to each phase commit), Reference to ADR-032 sections, Parity-pct summary from P5, Open questions resolved/deferred, "What did NOT change" (dashboard freeze respected, MCP transport untouched, persistence schema additive-only)
9. Push and tag `v0.5-portability` on the merge commit (Kenneth merges after parity review)

### Acceptance

- PR open with screenshots
- Tests green in CI
- `pm2 list` after a 5-min soak: both processes online, restart count <2 each
- /diagnostics steward panel renders with live data
- No regressions in any /api/* route, no regressions in the negative assertions added in PR #24 (run: `npm test -- tests/dashboard/`)

### Commit

`docs(design): v0.5 steward portability screenshots`

---

## Budget

- **Time**: 12–15h CC wall-clock (sequential, no parallel workers). Phase split:
  - P0: 10min (Kenneth)
  - P1: 2h
  - P2: 2.5h
  - P3: 3h ← longest, the actual subprocess move
  - P4: 1.5h
  - P5: 2h
  - P6: 1h
- **API cost**: ~$12–20 (Opus, more code-gen than the polish run)
- **LOC change**: ~2500–4000 net (most in new `src/steward-agent/`)
- **Token cap**: 2.5M (rapid mode trust scope)

---

## Rollback plan

If any phase blows up after merge:
- Revert just that phase's commit: `git revert <sha>`
- The shadow architecture in P5 means in-process Steward keeps working even if the subprocess Steward is reverted — there's no cutover until Kenneth's separate commit.
- Phases are independent enough that reverting P4 (autonomy) does NOT cascade into P3 (subprocess). Reverting P3 DOES require reverting P5 (parity reads the subprocess via IPC).

If the whole PR is broken: `git revert <merge-sha>` reverts atomically. The cutover commit Kenneth lands separately is the only irreversible step; that commit deletes the in-process planner/executor/loop files, so the rollback for the cutover itself is "revert THAT commit," which is easy.

---

## On completion

CC should:
1. Comment on the PR with: phases completed, tests passing, parity-pct summary from P5, screenshots attached, deltas vs ADR-032 (if any), pending TODOs deferred to v0.6 (embeddings on archival_memory, Grok3Runtime, real probation harness exercise)
2. Notify in `#stavr-dev` Slack channel via existing slack MCP if configured
3. Tag the workers channel: `@kenneth v0.5 steward portability ready for review · PR #__ · parity X%`
4. Update `memory/project_stavr_steward_2026_06_*.md` with the parity-pct number + the four Open Question decisions made during implementation
5. Do NOT auto-merge. Tag Kenneth for review. The cutover commit (deleting the in-process Steward) is Kenneth's, not CC's.

---

## Footgun appendix (carried + augmented from the polish brief)

1. **PowerShell `curl` ≠ real curl** — use `curl.exe` or `Invoke-RestMethod`.
2. **`pm2 restart --update-env` doesn't reload `ecosystem.config.cjs`** — use `pm2 start ecosystem.config.cjs --update-env` only if env changed. This BOM adds a second app entry to `ecosystem.config.cjs`, so the first time the steward-agent comes up you MUST run `pm2 start ecosystem.config.cjs` (not `restart`). `pm2 reload` won't pick up the new app.
3. **`pm2 env stavr` doesn't take a name** — use numeric id `pm2 env 0`.
4. **GitHub blocks self-approval of PRs** — skip `gh pr review --approve`, go directly to `gh pr merge` if instructed.
5. **Stacked-PR cascade-close** — if base branch merges, dependent PRs auto-close. Don't stack.
6. **RUNNER~1 8.3 paths on Windows** — quote paths.
7. **String.raw template literals don't nest cleanly** — use plain backticks + careful escaping. The new agent's IPC framing should NOT use template literals for JSON envelopes; use `JSON.stringify`.
8. **Edit-tool on large files (>30KB) can truncate the tail.** This BOM has at least three files trending past 30KB (`src/steward-agent/main.ts`, `src/steward-agent/loop.ts`, the executor refactor). Prefer heredoc-through-bash on fresh writes; always verify size + tail via bash before commit. CLAUDE.md invariant #2.
9. **Cowork virtualized fs silently drops Write tool output on rare occasions** — verify all writes via `bash stat -c %s` + `bash tail -5`.
10. **NEW for v0.5**: `child_process.fork` on Windows ignores the `silent: true` IO redirection in some Node versions when the parent has no stdin handle. If `stavr-steward-agent` logs to PM2 log files but the daemon doesn't see startup output, this is the culprit — use `stdio: ['ignore', 'pipe', 'pipe', 'ipc']` explicitly.
11. **NEW for v0.5**: better-sqlite3 holds a process-wide native handle. Opening three database files from the steward-agent subprocess is safe; opening the SAME file from both daemon and subprocess is NOT — that's the failure mode `~/.stavr/steward/*.db` exists to avoid. If you see `SQLITE_BUSY` in P5 parity tests, you've crossed the line — back off to the subprocess as the sole writer.
12. **NEW for v0.5**: PM2 `restart_delay: 30000` means a crashing steward-agent will respawn 30s later — enough that the daemon's heartbeat will time out and mark it down on /diagnostics. That's the intended UX. Don't shorten the delay to mask flapping.

---

## Open questions (FLAGGED — do not pre-answer)

These four decisions are deliberately not pre-decided in this BOM. If you hit one during implementation, pick the lower-risk path and document your choice in the PR description. Kenneth will revisit on review.

### §1 — IPC protocol final choice (socket vs pipe vs TCP loopback)

The current `src/steward/ipc.ts` uses `child_process.fork` framing, which works cross-platform out of the box and is what P3 ships with. But ADR-032 doesn't pin this — long-term, cross-host federation (a steward-agent running on a different machine than the daemon, for power-budget reasons or model-locality) needs a transport with a wire address.

Candidates:
- **Unix domain socket (Linux/Mac) + named pipe (Windows)** — local-only, fast, but cross-platform code paths diverge
- **TCP loopback** — cross-platform, addressable, but exposes the surface to anyone else on localhost (mitigate with a token)
- **Stick with `fork`** — simplest, works today, but bars cross-host federation

P3 ships with `fork` (the existing path). The open question is whether v0.6 should swap to UDS/pipe/TCP and if so which.

### §2 — lessons.db schema shape (free-text vs structured vs vector)

The P1 schema lands as `lessons(id, title, body, source, distilled_from_json, created_at, status)` — body is free-text. Future-proofing options:
- **Structured columns** (preconditions / trigger-pattern / suggested-action / counter-evidence) — easier to query, harder to write distillation prompts for
- **Vector column** (embedding BLOB) — enables semantic recall during planning, but adds an embedding-model dependency and an indexing cost on every lesson write
- **Stay free-text** (current P1) — simplest, planner re-reads everything every cycle, scales fine up to ~10k lessons at personal-use volume

Embeddings are flagged in P1 as a v0.6 follow-up. The structured-vs-free-text choice is what to commit to *now*. If the auto-demotion query (`SELECT lessons WHERE status='active' AND outcome_rate < 0.3`) gets gnarly, structured columns become attractive — but P1 ships free-text + a `distilled_from_json` audit field, which is recoverable.

### §3 — Autonomy level defaults: start reactive only, gate scheduled + proactive behind config flags?

P4 ships all three modes in code, with `prefs.autonomy_mode = 'reactive'` as the default. Two sub-questions:
- Do scheduled + proactive ship *enabled but unselected* (config-flippable from the dashboard), or *disabled at build time* behind an `experimental.proactive` flag in `stavr.yaml`?
- Cost-cap on proactive defaults to $2.00/day. Is that right for personal use, or is $0.50/day the right starting point? (The daily self-critique already costs ~$0.50/day per ADR-032 §Consequences.)

Lower-risk path: scheduled + proactive *enabled but not selected*. Cost cap $2.00/day. If you pick differently, document why.

### §4 — Migration cutover trigger: manual flip, time-based, or parity-pct gate?

P5 measures structural parity; the cutover (deleting in-process Steward, switching `wireV02Subsystem` → `spawnStewardAgent`) is a separate commit. Who pulls the trigger?
- **Manual** — Kenneth eyeballs the parity-pct, opens the cutover PR himself
- **Time-based** — after 72h of shadow with no incidents, CC opens the cutover PR
- **Parity-pct gate** — once parity-pct ≥ 99% over the last 200 logs, CC opens the cutover PR

The lower-risk path is manual. Time-based and parity-pct gates are tempting but neither captures "has Kenneth actually used it for real work yet." If you go anything other than manual, the cutover PR must NOT auto-merge under any circumstance.

---

## End of brief
