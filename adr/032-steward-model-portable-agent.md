# ADR-032 — Steward as model-portable agent with three-layer state

**Status:** Proposed
**Date:** 2026-05-16
**Related:** ADR-022 (trust scopes), ADR-023 (shared memory), ADR-030 (event retention), ADR-031 (observability), `proposed/v0.4-scheduler-bom.md`

> **Note on numbering:** Originally drafted as ADR-030 in the 2026-05-16 design session; renumbered to 032 after the parallel observability arc claimed 030 (event retention) and 031 (observability stack).

## Context

Steward today (v0.3) lives inside the daemon process — `src/steward/` is part of the same Node runtime as the MCP transport, broker, watchdog, and dashboard. Same event loop. Same crash blast radius. Same memory ceiling. Same provider hard-coding (Anthropic via `@anthropic-ai/sdk`).

The 2026-05-15 OOM (heap exhausted at 4 GB, mark-compact freed 0.6 MB out of 4 GB) was technically a retention bug — fixed in PR #16 — but it crystallized two things:
1. Steward's in-process posture means a Steward-side leak (lessons store growing unbounded, planner context retention bug, anything) would cascade to MCP serving + dashboard + every connected worker.
2. Provider hard-coding means swapping to GPT-5.5 or Llama 3.3 70B requires touching planner code, not config.

Kenneth's strategic asks on 2026-05-16 force this:
- Steward should be more self-driven (proactive proposing, not just reactive)
- Steward should learn over time (lessons distilled from outcomes)
- Steward should be model-agnostic (opus today, GPT tomorrow, Llama next week)
- Continuity across model swaps (state survives the swap)

These four asks converge into one architectural move: **Steward becomes its own subprocess, talking to core via MCP, with state stored in core, behind a uniform Model Runtime interface.**

## Decision

1. **Steward becomes its own subprocess.** New entry point `src/steward-agent/main.ts`, runs as `stavr-steward-agent`, supervised by PM2 alongside the daemon. Communicates with daemon via MCP at `STAVR_DAEMON_URL`. `src/steward/` shrinks to a *spawner* + healthcheck shim; the planner/loop/state machinery moves to `src/steward-agent/`.

2. **Three SQLite stores in core, queried by Steward via MCP:**
   - `~/.stavr/steward/memory.db` — Letta/MemGPT-style tiers (working_memory, archival_memory, episodic_log)
   - `~/.stavr/steward/lessons.db` — distilled patterns (lessons + lesson_outcomes for auto-demotion)
   - `~/.stavr/steward/prefs.db` — user-explicit preferences (pinned brain, default profile)
   
   Separate files (not joined onto runestone.db) so backup cadence and migration can differ; corruption in one cannot take Steward down.

3. **Uniform Model Runtime interface** at `src/steward-agent/runtimes/types.ts`:
   ```typescript
   interface ModelRuntime {
     name: string;
     costPerKtoken: { in: number; out: number };
     contextWindow: number;
     plan(ctx, tools, schema): Promise<ValidatedBOM>;
     decide(req, schema): Promise<ValidatedChoice>;
     summarize(events, schema): Promise<ValidatedDigest>;
   }
   ```
   Implementations: `OpusRuntime` (Anthropic), `GPTRuntime` (OpenAI), `OllamaRuntime` (local), `GrokRuntime` (xAI). Each maps the same context schema to the same output schema; provider quirks normalized inside each implementation.

4. **Three autonomy levels** configurable in `prefs.db`:
   - `reactive` (today) — wake on event, plan, sleep
   - `scheduled` (per `proposed/v0.4-scheduler-bom.md`) — backlog + priority + capacity + dedupe
   - `proactive` (this ADR enables) — initiates BOM proposals from observed patterns + lessons; user still approves
   
   The line stays put: **Steward proposes, user approves.** BOM-approval gate and trust scopes unchanged.

5. **Output validation mandatory.** Every model output passes a Zod schema before any dispatch. Malformed → reject + retry up to 3× with sharper instruction; on 3rd failure surface as a Decision card.

6. **Snapshot + event log restart.** Periodic snapshot of working_memory + active BOM IDs every 1000 episodic_log entries OR every 5 minutes. Restore on Steward boot = load latest snapshot + replay episodic_log entries since snapshot timestamp.

7. **Three feedback loops feed lessons store:**
   - Outcome feedback (automatic) — every BOM step's success/failure/cost recorded in episodic_log
   - User feedback (via Capture-and-route, see v0.4 brief) — comments/amendments seed lesson candidates
   - Self-critique batch — daily scheduled task at 03:00 local, budget cap $0.50, generates "what I'd do differently" lessons

8. **Probation for new runtimes.** A new runtime (e.g. `Grok3Runtime`) runs in shadow against live events for N (default 50) BOMs, comparing planned BOMs to active runtime's. Promotion requires correlation > 0.8.

9. **Security stays in core, not Steward.** Trust scope + no-go list enforced in the daemon, NOT in Steward agent. Steward operates within constraints; it does not enforce them. Output validator double-checks no tool-call escape happened in the model's response.

## Consequences

**Positive:**
- Steward leak/crash cannot take down MCP serving or dashboard
- Model swap = config change (not code change); add new provider = one new file
- State survives any swap, restart, or upgrade — new Steward picks up where old one left off
- Lessons accumulate and refine the planning prompt automatically
- Steward Core Loop is a pure function of `(events, lessons, prefs) → BOM` — testable in isolation, replayable against production event log

**Negative we accept:**
- Inter-process communication overhead (~1-2ms per MCP call vs in-process function call, dwarfed by LLM latency)
- Two extra processes to monitor (Steward agent + watchdog companion); PM2 already supervises both
- Lessons can misfire — mitigated by `lesson_outcomes` audit + auto-demotion
- Provider divergence on tool-use semantics — Runtime layer normalizes
- Self-critique costs ~$0.50/day at current Opus pricing — bounded, can move to weekly if needed

## Alternatives considered

- **Keep Steward in daemon** — status quo. Rejected: violates the core-never-jeopardized rule.
- **Provider fine-tuning per provider** — locks learning into vendor weights. Rejected: violates portability.
- **Vector DB over decision history** — overkill for personal-scale data; structured lessons table is simpler.
- **Multi-Steward voting ensemble** — expensive, slow, BOMs rarely converge cleanly under voting.
- **Letta as external memory daemon** — adds a second always-on process, splits storage, undermines single-daemon promise.

## Implementation

`proposed/v0.5-steward-portability-bom.md` — phase-by-phase spec. ~12-15h Opus autonomous run. Sequenced after the v0.4 visible-value bundle lands (which adds OllamaProvider in the existing provider system; this ADR formalizes the abstraction).

## Acceptance for moving Status to Accepted

1. v0.5 BOM spec lands in `proposed/`
2. Kenneth signs off on phase order
3. PM2 ecosystem.config.cjs extended to supervise `stavr-steward-agent` alongside `stavr` daemon
