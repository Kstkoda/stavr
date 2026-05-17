# ADR-040 — Three-process architecture: Engine, Steward, Governor

**Status:** Proposed
**Date:** 2026-05-17
**Related:** ADR-032 (steward-model-portable-agent), ADR-033 (stavr-tray companion — now Governor v1), ADR-034 (positioning + team amendment), ADR-035 (federation), ADR-036 (audit integrity), ADR-037 (data lifecycle), ADR-038 (supply chain), ADR-039 (polyglot core), memory `project_stavr_team_repositioning_decision.md`

## Context

stavR began as a monolithic Node daemon with embedded planning, embedded supervision, and embedded notifications. v0.5 broke the planner into a `stavr-steward-agent` subprocess (ADR-032) — first concrete process split. ADR-033 sketched a Tauri 2 tray companion for OS integration but didn't position it as an architectural party.

The 2026-05-17 strategic audit and the operator's revised mental model surfaced the underlying shape: stavR isn't really "a daemon" — it's **three cooperating processes** with distinct lifetimes, distinct trust requirements, and distinct rates of change. Naming them and codifying the contracts between them lets every future ADR slot cleanly into one of three buckets instead of accumulating implicit dependencies.

Without this ADR, future decisions about "where does feature X live?" stay ad-hoc. With it, the answer becomes mechanical: classify X as engine concern / planner concern / OS concern, and the owner falls out.

## Decision

Adopt a **three-process architecture** with explicit names, boundaries, and contracts. Every existing and future stavR component fits into exactly one of these three parties.

### Party 1: stavR — the Engine

**Identity**: the persistent, stateful, security-critical daemon. The "engine room."

**Owns:**
- Persistent state: `runestone.db` (decisions, scopes, events, plans, audit log, credentials vault)
- MCP protocol surface: stdio + StreamableHTTP transports
- Dashboard rendering (today server-rendered; ADR-040.B candidate to extract)
- Trust scope enforcement + host_exec allowlist (eventually polyglot Rust per ADR-039)
- Audit log append + hash-chain + signing (per ADR-036)
- Event bus (in-process broker; long-term: separate sidecar per ADR-039)
- Notification fabric (v0.6: ntfy.sh + email + Telegram outbound, webhook + Telegram inbound)
- Worker dispatch (CC workers, watchdog, unity)
- Federation runtime (per ADR-035)

**Does NOT own:**
- Planning decisions (delegates to Steward)
- Process supervision (delegates to Governor)
- OS-level UI (no toast notifications, no tray icon, no auto-update — all Governor)
- Killswitch (Governor only, operator-only)

**Rate of change**: slow. Engine is the stable core. Schema migrations + transport changes + trust model are deliberate decisions with high review bar.

**Lifecycle**: long-lived (boots at machine start, runs until killed). Governor supervises restart.

### Party 2: Steward — the Planner

**Identity**: the AI-driven planner. Subprocess of Engine but independent process. Model-swappable.

**Owns:**
- Plan generation: takes a goal, produces ordered steps, cost estimate
- Model runtime selection (Anthropic / OpenAI / Ollama / future) per ADR-032
- Validation + retry pipeline (Steward retries invalid outputs, falls back to alternate model)
- Lessons-learned table (per ADR-032 §Decision 2 — `memory.db` separate from runestone)
- Strategy adjustment over time (notices repeated failures at task type → adjusts approach)
- Self-monitoring: detects own slow responses, output validation failure rates, model-error rates
- **Self-heal scope** (operator-confirmed by ADR-040 acceptance):

| Self-heal level | Steward authority | Operator involvement |
|---|---|---|
| Process restart | Governor handles | None (autonomous) |
| Validation retry + model fallback | Autonomous within scope | None |
| Continuous monitoring (output validity, latency, cost) | Autonomous | Logs to dashboard; operator can review |
| Strategy adjustment (try different model for X) | Autonomous | Logs lessons; operator can override |
| Daemon-misbehavior fix proposals (restart subsystem, run diagnostic) | Autonomous if within scope; Tier 2 CONFIRM if scope-expanding | None for in-scope; consent for scope changes |
| Schema/code changes to fix recurring issues | Always escalated (no autonomy) | Tier 3 EXPLICIT or NO-GO depending on action |

**Does NOT own:**
- Actually executing the plan (Engine's executor does that)
- Trust scope grants (operator does that via Engine's decide flow)
- OS-level UI
- Storing audit data (Engine's runestone)

**Rate of change**: fast. New models arrive every 6-12 months. Strategy refinements happen weekly. Steward expected to evolve continuously without disturbing Engine.

**Lifecycle**: long-lived subprocess, started + supervised by Governor (or PM2 today). Crashes are recoverable: Governor restarts, Steward reloads lessons from `memory.db`.

**Replaceability**: a future operator should be able to swap stavR's Steward for an alternate implementation (different model orchestrator, different planning algorithm) by replacing the subprocess binary — no Engine changes required. This is the "easily replaced as models get better" promise.

### Party 3: Governor — the OS Layer

**Identity**: the operator-facing desktop application. Tauri 2 (Rust + WebView). Runs at user-login.

**Owns:**
- Process supervision: starts, monitors, restarts Engine + Steward
- Auto-update: polls release index, verifies Sigstore signatures (per ADR-038), swaps binaries in place, restarts daemon
- OS-level notifications: subscribes to Engine's notification events, renders native toasts (Windows / macOS / Linux)
- Tray icon + quick-action menu: pause/resume daemon, open dashboard, view recent decisions
- **Killswitch** (operator's panic button, four levels):

| Level | Action | Trigger |
|---|---|---|
| STANDBY | Daemon stops accepting new MCP requests; existing actions complete | Operator clicks "Pause" |
| HALT | Daemon SIGTERM + wait; Steward SIGTERM; pending decisions preserved | Operator clicks "Stop all" |
| KILL | Daemon SIGKILL + Steward SIGKILL; no graceful shutdown | Operator clicks "Kill" (confirmation modal) |
| REVOKE-ALL | KILL + wipes all active trust scopes from runestone | Operator clicks "Emergency revoke" (Tier 3 EXPLICIT friction) |

Killswitch is **operator-only**. Steward cannot trigger any level. Engine cannot trigger any level. AI (Cowork-Claude, CC, federated peers) cannot trigger any level. Only the human operator clicking in the Governor tray, OR the operator running `governor-cli killswitch <level>` from a shell the operator owns.

**Does NOT own:**
- Persistent state (Engine's runestone is authoritative)
- Planning logic (Steward)
- Dashboard rendering (Engine serves it; Governor just opens a browser to localhost:7777)
- Trust scope decisions (Engine's decide flow)
- Notification fabric (Engine sends; Governor only renders OS-level toasts)

**Rate of change**: medium. Auto-update mechanics are stable once built. Tray UI gets feature additions. OS integration may need maintenance per Windows/macOS/Linux releases.

**Lifecycle**: long-lived, started at user-login (Windows Run key / macOS LaunchAgent / Linux systemd-user). Survives Engine + Steward crashes by design.

**Replaces PM2.** Today PM2 supervises Engine + Steward; Governor takes over once built. PM2 stays around as a transitional fallback until Governor is operator-tested for ≥30 days.

### Inter-party contracts

**Engine ↔ Steward:**
- Transport: JSON-RPC over stdin/stdout (long-lived subprocess), HTTP fallback if subprocess pattern needs revision
- Engine sends: `plan_request {goal, context}`, `cancel_plan {plan_id}`, `feedback {plan_id, outcome}`
- Steward sends: `plan_response {plan_id, steps, cost}`, `plan_failed {plan_id, reason}`, `lessons_updated {topic, lesson}`, `self_heal_request {action, justification}`
- Heartbeat: Engine pings Steward every 30s; missing pong → Governor restarts Steward
- Steward sees: Engine's MCP transport (to call back through it for additional context), `memory.db` (its own state)
- Steward does NOT see: `runestone.db` directly (must request via Engine API)

**Engine ↔ Governor:**
- Transport: HTTP on loopback 127.0.0.1:7777 (Engine's dashboard port — Governor opens this URL in browser for full UI)
- Plus IPC for control: Unix domain socket / Windows named pipe at `~/.stavr/governor.sock` (Governor → Engine: pause/resume; Engine → Governor: notification events, health pings)
- Engine sends: `notification_event {kind, severity, title, body}` for OS toast rendering
- Governor sends: `pause`, `resume`, `health_check`, `request_shutdown {grace_seconds}`
- Auto-update flow: Governor stops Engine via `request_shutdown` → swaps binary → starts Engine → waits for `/healthz` 200

**Governor ↔ Steward:**
- Minimal direct contact. Governor supervises (start/stop) but doesn't talk Steward's protocol.
- Governor receives Steward `process_died` event from its supervisor logic → restarts Steward → Steward reloads `memory.db` → resumes.

## Consequences

**Positive:**
- Clear ownership boundaries — every new feature gets classified Engine/Steward/Governor unambiguously
- Independent evolution — Steward can swap models every 12 months without Engine churn; Governor can update Tauri without Engine churn
- Crash isolation — Steward OOM doesn't take down Engine; Engine crash doesn't take down Governor; Governor stays running to recover both
- Killswitch is architecturally correct — operator controls Governor; Governor is the only path to stopping everything; no in-band killswitch (which a compromised daemon could disable)
- Self-heal is bounded — Steward's autonomy is enumerated above; ambiguity removed
- Auto-update becomes safe — Governor owns the binary swap, not the daemon (daemon swapping its own binary is the classic "can't pull the rug out from under yourself" problem)
- Aligns with the "personal-or-small-team trusted-AI broker" team-direction repositioning — Engine = shared truth, Steward = shared planning brain, Governor = each operator's personal control surface (one Governor per machine, even in team mode)
- Polyglot core (ADR-039) fits naturally — Rust binary called by Engine; Steward is independent of that choice
- Federation (ADR-035) fits naturally — each federated stavR has its own Engine + Steward + Governor; peers communicate Engine-to-Engine

**Negative we accept:**
- Three processes to monitor instead of one. Operational complexity rises. Mitigated by Governor being the supervisor (operator sees three icons / status entries in tray, not three terminal windows).
- Killswitch is hard-coded operator-only. No "ops automation can trigger emergency revoke." Intentional — the operator's sovereignty trumps automation convenience.
- ADR-033 is partially subsumed (the Tauri 2 implementation details still apply; the architectural framing supersedes).
- Slightly higher install footprint: Governor adds ~10-15MB binary (Tauri 2 + WebView), Steward adds its own Node process. Negligible on modern hardware.
- Existing in-process Steward must complete cutover before this architecture is real. Until then, two stewards run side-by-side per v0.5 shadow mode.

## Alternatives considered

- **Stay monolithic single-daemon** — what we had before v0.5. Doesn't scale architecturally (every concern adds surface to one process), doesn't support model-swap cleanly, doesn't allow Governor to recover the daemon (chicken-and-egg).
- **Two parties: Engine + Steward only (no Governor)** — keeps PM2 as supervisor. Loses OS-level notifications + operator killswitch + auto-update. Doesn't address the "PM2 corruption keeps biting us" pain.
- **Two parties: Engine + Governor only (Steward in-process)** — keeps planning embedded. Loses model-swap velocity (every new model = Engine redeploy). Doesn't scale as models evolve.
- **Microservices: split Engine further (event bus separate, dashboard separate, trust scopes separate)** — premature for the scale stavR runs at. Three processes is the right grain for personal-or-small-team. Microservices is the wrong grain.
- **Single process, threads** — Node's worker_threads could give isolation without subprocess overhead. Loses crash isolation (a thread panic can still corrupt shared state). Subprocess is the right primitive.
- **Steward-as-MCP-server** — Steward could be just another MCP server the Engine talks to. Considered — but Steward's interface is richer than typical MCP (long-lived planning, feedback loop, lessons memory). Custom JSON-RPC over stdio is the better fit; revisit if MCP evolves to support long-lived stateful sessions natively.

## Implementation notes (not part of decision)

**Existing work:**
- ✅ Engine exists (today's daemon)
- ✅ Steward subprocess exists in shadow mode (v0.5 PR #31)
- ⚠ Steward cutover pending (delete in-process planner; swap to subprocess for real planning) — v0.5.5 candidate
- ❌ Governor doesn't exist (ADR-033 sketches it; ADR-040 supersedes the framing)

**Sequencing (suggested):**
1. **v0.5.5: Complete Steward cutover** — small dispatch, kills the shadow window, makes Steward the only planning path. ~1-2h CC.
2. **v0.6 PR #3: Notifications UI** — settings panel. Already-dispatched.
3. **v0.8: Audit history dashboard** — operator-visible value. ~7-9h CC.
4. **v1.0 milestone: Governor v1** — Tauri 2 tray, PM2 replacement, OS notifications, basic killswitch (STANDBY + HALT levels). 3-4 week effort (Rust ramp + Tauri 2 build pipeline + cross-platform packaging). Single big dispatch or multi-phase.
5. **v1.1: Auto-update** — Governor pulls signed binaries per ADR-038. 1-2 weeks.
6. **v1.2: Full killswitch** — KILL + REVOKE-ALL levels with Tier 3 EXPLICIT friction. 1 week.

**Naming polish for marketing surfaces (later, separate doc):**
- "Engine room" / "the Engine" is good evocative branding; consider using in operator docs + share cards
- "Governor" has a nice double meaning (governs the system + is the operator's governor on AI autonomy)
- "Steward" already established; keep

**Open question for follow-up ADR:**
- Where does the credentials vault live — Engine (today) or split into a fourth party (Vault)? Vault-as-fourth-party gives stronger isolation but adds complexity. Defer until specific pain emerges.

## Acceptance for moving Status to Accepted

This ADR moves to "Accepted" when:
1. Steward cutover commit lands (v0.5 in-process planner deleted, Steward subprocess is the only planning path)
2. Governor v1 spec (separate BOM) is drafted and reviewed
3. Engine ↔ Steward JSON-RPC contract is formalized in code (TypeScript interface in shared types file)
4. Engine ↔ Governor IPC contract is formalized in code (same)
5. At least one operator-facing doc references the three parties by name (introduces the architecture to readers)
6. ADR-033 is updated with a "see ADR-040 for top-level framing; this ADR covers implementation details" header
