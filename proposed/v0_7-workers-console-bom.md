# stavR · v0.7 — Workers Console (live card UI + command injection + Steward Q&A)

> Major redesign PR. Replaces the current Streams page with an interactive Workers Console — one card per active worker showing live output tail, action buttons, AND an operator-typed command input that injects messages into running workers (e.g., `/btw also check X` to a Claude Code session). Plus bidirectional Steward ↔ worker Q&A: workers can ask questions mid-execution, Steward answers from its knowledge, operator can override. Transforms stavR from "fire-and-forget worker dispatcher" to "interactive worker fleet with operator + Steward in the loop."

**Architectural framing**: Today's workers are batch jobs that emit progress events one-way. v0.7 makes them **collaborators** — operator can steer mid-run, Steward can clarify mid-task. The Workers Console is the operator's bridge into running workers.

**Estimated wall-clock**: 14–18 hours CC sequential across 3 PRs.

**Sensitivity**: `high` per CLAUDE.md §9 — touches worker IPC primitives (stdin injection, bidirectional Q&A protocol), Steward subscription pattern, and the page operators will live on during active dispatches. Operator approval gate between PRs.

**Stop conditions**: end of any phase if `npm test` regresses, build fails, any security test demonstrates operator can inject arbitrary commands without scope check, or any test demonstrates Steward can answer worker questions outside its trust scope.

**Do NOT pause for approval** between phases within a PR.

---

## Why this matters

Current state: a CC worker runs autonomously. Operator can SEE its output via /dashboard/workers/<id> + dashboard SSE. Cannot interact mid-run. If operator notices CC is going down the wrong path, can only TERMINATE (kill the work) — not REDIRECT (add context).

Real example: CC is implementing a feature, operator notices it's about to touch a file that's now out of scope. Today: terminate + re-dispatch with updated brief. v0.7: operator types `/btw skip src/payments/* — out of scope` and CC sees the message in its conversation, adjusts course.

Second real example: shell worker doing a long calculation, hits ambiguous case (e.g., "found 2 candidate config files, which one?"). Today: worker fails or picks wrong one. v0.7: worker emits `worker_question`, Steward sees it, either auto-answers from lessons-learned (per ADR-032) or escalates to operator. Worker continues.

Third real example: parallel workers (per the stress test), operator wants to mute one without killing it. Today: only kill is available. v0.7: card-level "pause output" toggle, "mute notifications from this worker", "promote to high-attention", etc.

---

## Reference reading

1. `CLAUDE.md` — invariants
2. `adr/040-three-process-architecture.md` — Steward ↔ Engine ↔ workers contracts
3. `adr/041-universal-signal-trace.md` — bidirectional events follow same privacy model
4. `adr/032-steward-model-portable-agent.md` — Steward's lessons-learned table (used in P3 for auto-answer)
5. `src/workers/spawner.ts` — current spawn pattern; needs stdin pipe extension
6. `src/dashboard/pages/streams.ts` — current page that this BOM redesigns
7. `proposed/v0_6_6-worker-status-fidelity-bom.md` — landed first, provides lifecycle_state semantics
8. `proposed/v0_6_7-worker-spawn-hygiene-bom.md` — landed first, provides script-file pattern that supports stdin injection

---

## Don't touch

- Worker SPAWN code (covered by v0.6.7) — only extend with stdin pipe lifecycle
- Helm / Topology / Diagnostics / Capabilities / Settings — separate pages, separate concerns
- Trust scope semantics — operator's command injection is gated by their authority on the worker (per scope grant)
- Notification fabric (PR #32+) — Workers Console raises events that flow through it, doesn't replace it
- Event taxonomy except for adding `worker_question` + `worker_answer` + `worker_command_injected` event kinds in P1
- Schema except for one new `worker_commands` table in P1
- `cc` worker internals (Claude Code is its own process; we communicate via the dispatcher pattern)

---

## Hard rules

1. **Tests are derivative** — existing Streams page tests will fully replace; update assertions per phase
2. **Never lose files** — `stat -c %s` + `tail -5` for any file >15KB
3. **Status-check before every git op** (CLAUDE.md §8)
4. **Operator command injection MUST be scope-gated** — only operator (via dashboard session with valid auth) can inject. NOT MCP clients. NOT federated peers in MVP.
5. **Steward answers are SCOPE-LIMITED** — Steward can only answer worker_question events for workers it has authority over (worker spawned within Steward's scope or under operator's direct authority that's been delegated).
6. **Worker stdin injection MUST be one-shot per command** — no maintaining open stdin handles in the Engine. Each command writes + flushes + done. Worker reads stdin opportunistically. (Prevents lockup if worker doesn't read.)
7. **For CC workers**: the injection mechanism IS the existing CC conversation tools (claude code accepts ongoing messages). For shell workers: stdin write. For unity workers: out-of-scope (no injection in v0.7).
8. **Privacy boundary** (ADR 041) — operator command injection is "in our universe" (logged fully). Steward Q&A is "in our universe" (logged fully). Federated peer commands are out-of-scope for v0.7.
9. **DCO -s, per-phase commits, push at end of each phase. 3 PRs.**

---

## Phase-group structure (3 PRs)

| PR | Phases | Scope | Wall-clock |
|---|---|---|---|
| #1 — Card UI + live tail | P0, P1, P2 | New Workers Console page replaces Streams, card-per-worker layout, live SSE tail per card, basic action buttons (pause output, terminate) | 5–6h |
| #2 — Command injection | P3, P4 | Per-card "send command" input that injects to worker stdin (shell) or appends-message (cc); event log + audit | 4–5h |
| #3 — Steward Q&A + operator override | P5, P6, P7 | `worker_question` event kind, Steward subscribes + auto-answers from lessons, operator override panel, full docs | 5–7h |

PR #1 alone is the UI win. PR #2 makes the page genuinely interactive. PR #3 unlocks the Steward-as-collaborator architecture.

---

## P0 · Pre-flight (Kenneth, before CC kicks off)

~5 min:
1. `git status` clean on `main`; v0.6.5 (Governor MVP), v0.6.6 (worker fidelity), v0.6.7 (spawn hygiene) merged
2. `npm test --run` baseline = current passing count
3. Confirm: Streams page is OK to be REPLACED (not preserved alongside). Default: replace; redirect old URLs.
4. Dispatch CC with PR #1 brief

---

## P1 · Workers Console page + per-worker cards (PR #1, 2.5h)

**Files**:
- `src/dashboard/pages/workers.ts` (new — replaces `streams.ts`)
- `src/dashboard/widgets/worker-card.ts` (new) — single worker's card
- `src/dashboard/data/worker-card-data.ts` (new) — per-worker data fetcher
- `src/dashboard/shell.ts` — rename Streams nav link to "Workers"
- `tests/dashboard/workers-console.test.ts`

### Page structure

```
┌──────────────────────────────────────────────────────────────────┐
│ Workers Console                     [Active 3] [History] [+ New] │
├──────────────────────────────────────────────────────────────────┤
│ ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐ │
│ │ e2e-test-1       │ │ stress-7         │ │ cc-feat-v0.7-pr1 │ │
│ │ shell · 12s      │ │ shell · 18s      │ │ cc · 47m         │ │
│ │ ●●●○             │ │ ●●○              │ │ ●●●●●            │ │
│ │ green halo       │ │ amber halo       │ │ green halo       │ │
│ │                  │ │                  │ │                  │ │
│ │ [live tail]      │ │ [live tail]      │ │ [live tail]      │ │
│ │ commits=2347     │ │ ... waiting ...  │ │ Reading file...  │ │
│ │ DONE             │ │                  │ │ Compiling...     │ │
│ │                  │ │                  │ │ ❓ "which API?"  │ │
│ │                  │ │                  │ │                  │ │
│ │ [Pause tail]     │ │ [Pause tail]     │ │ [Pause tail]     │ │
│ │ [Mute notify]    │ │ [Mute notify]    │ │ [Mute notify]    │ │
│ │ [Terminate]      │ │ [Terminate]      │ │ [Terminate]      │ │
│ │                  │ │                  │ │ > [send command] │ │
│ └──────────────────┘ └──────────────────┘ └──────────────────┘ │
│                                                                   │
│ [+ Spawn new worker]                                              │
└──────────────────────────────────────────────────────────────────┘
```

### Card content

- **Header**: name + type + elapsed time
- **Status indicator**: 4-dot progress (rough idea of phase) + halo color per lifecycle_state (v0.6.6)
- **Live tail panel**: last 10-20 lines of worker stdout/stderr, auto-scrolling, syntax-highlighted for common patterns
- **Question chip** ❓ (when worker has emitted `worker_question`) — operator can click to see + respond
- **Actions**: Pause Tail (UI-only, doesn't pause worker) / Mute Notify (suppress notifications from this worker) / Terminate (graceful, then force after 10s)
- **Command input** (P2 adds this): textbox + send button, sends injection to worker

### Layout rules

- 3 cards per row on 1080p+; 2 on tablet; 1 on mobile
- Cards SORT: newest active at left/top; completed move to History tab below the fold
- "Active" tab default; "History" tab shows terminated/completed/crashed in chronological order
- "+ New" button opens spawn dialog (P1 stub; full impl in P3)
- Empty state: "No workers active · spawn one to begin · [Browse capabilities]" — link to MCPs/Capabilities

### Acceptance

- Page renders at `/dashboard/workers` (and old `/dashboard/streams` redirects)
- All currently-active workers (v0.6.6 lifecycle: starting / running) get a card
- Cards subscribe to SSE for their worker's events (single multiplexed connection per page, per v0.6.8 multiplexer)
- Live tail updates within 1s of stdout/stderr emit
- Pause Tail freezes the visible UI without affecting actual worker
- Mute Notify suppresses notifications from this worker (suppress is per-card, not global)
- Terminate calls worker_terminate; card shows "Terminating..." until lifecycle_state changes
- 8+ tests passing

### Commit
`feat(workers): workers console page + per-worker cards with live tail + basic actions`

---

## P2 · Live tail polish + history tab + spawn dialog (PR #1, 2.5h)

**Files**:
- `src/dashboard/widgets/worker-tail.ts` (new) — tail-specific rendering with pattern highlighting
- `src/dashboard/widgets/worker-history.ts` (new) — terminated workers view
- `src/dashboard/widgets/spawn-dialog.ts` (new) — operator UI for spawning workers
- `tests/dashboard/worker-tail.test.ts`

### Tail polish

- Auto-scroll to bottom on new events; "Scroll to live ↓" button when operator manually scrolled up
- Syntax highlighting: ERROR/WARN/INFO/DONE keywords colored
- Tail max retention: 200 lines per worker (older lines pruned in UI; full log in DB)
- "Expand" button → opens fullscreen tail in modal
- "Copy" button → copies tail to clipboard

### History tab

- Terminated workers (v0.6.6 lifecycle: completed/killed/crashed) in reverse chronological order
- Same card layout, but:
  - No live tail (frozen at final state)
  - Different actions: "Re-spawn with same params" / "View full log" / "View artifacts"
- Pagination: 20 per page; load more on scroll

### Spawn dialog

- Operator types worker name + selects type (shell / cc / unity)
- Type-specific params: shell → shell+command; cc → branch+base+brief; unity → project path
- Sensitivity flag (per CLAUDE.md §9) — defaults to routine
- Submit → calls worker_spawn MCP; card appears in Active tab

### Acceptance

- Tail auto-scrolls + scroll-to-live works
- Pattern highlighting visible for ERROR/WARN/etc
- History tab paginates correctly
- Spawn dialog produces working worker
- 6+ tests passing

### Commit
`feat(workers): live tail polish + history pagination + spawn dialog`

### Open PR #1

`feat(workers): console redesign with per-worker cards + live tail + history (closes v0.7 PR #1)`

---

## P3 · Command injection (PR #2, 2h)

**Files**:
- `src/workers/command-injection.ts` (new) — protocol for sending commands to workers
- `src/workers/spawner.ts` — extend spawn to keep stdin pipe accessible
- `src/dashboard/widgets/worker-card.ts` — add command input textbox + send button
- `src/types/events.ts` — add `worker_command_injected` event kind
- `migrations/00X_worker_commands.sql` — additive table to log injected commands
- `tests/workers/command-injection.test.ts`

### Schema (additive)

```sql
CREATE TABLE IF NOT EXISTS worker_commands (
  id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL,
  injected_at INTEGER NOT NULL,
  injected_by TEXT NOT NULL,  -- operator_id or 'steward'
  command TEXT NOT NULL,
  delivered INTEGER NOT NULL DEFAULT 0,  -- did worker receive
  delivered_at INTEGER,
  FOREIGN KEY (worker_id) REFERENCES workers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_worker_commands_worker ON worker_commands(worker_id, injected_at DESC);
```

### Per-worker-type injection mechanism

**Shell workers**: write to stdin via the kept-alive pipe. One-shot per command. Worker reads stdin opportunistically.

**CC workers**: send as appended user message to the existing CC session. Claude Code's MCP session model supports continued conversation; injection becomes an MCP `prompts/append` call (or similar).

**Unity workers**: NO injection in v0.7 (deferred).

### Per-Hard-rule #4 — scope gating

- Operator from dashboard session: AUTO (logged but no per-action consent)
- MCP client (Cowork-Claude, federated peer): NO-GO in v0.7 (only operator's UI can inject)
- Future v0.7+: Steward can inject via its own answer-flow (PR #3 covers this)

### UI

Per worker card, below actions row:
```
> [type a command to inject...] [Send]
```

On Send:
- POST `/api/workers/<id>/command` with `{ command: "...", source: "operator" }`
- Persist to `worker_commands` table
- Emit `worker_command_injected` event
- Inject via type-specific mechanism
- Tail shows "OPERATOR: <command>" line for visibility

### Acceptance

- Operator types `echo "hello from operator"` into shell worker's command box → appears in worker's stdout via stdin pipe
- Operator types `/btw also check X` into CC worker → appears in CC's conversation as next user message
- Audit trail in `worker_commands` table for every injection
- Negative test: MCP client tries to call inject endpoint → 403
- 6+ tests passing

### Commit
`feat(workers): operator command injection per worker type with audit`

---

## P4 · UX polish for command injection (PR #2, 2h)

**Files**:
- `src/dashboard/widgets/worker-card.ts` — command-input ergonomics
- `src/dashboard/widgets/command-history.ts` (new) — show recent commands per card

### Sub-tasks

1. **Command history per card**: small dropdown showing last 5 commands injected; click to re-send
2. **Command templates per worker type**:
   - CC: `/btw`, `/clarify`, `/skip <path>`, `/focus on`, `/done when`
   - Shell: arbitrary stdin
3. **Keyboard shortcuts**: Ctrl+Enter sends; Esc clears
4. **Visual confirmation**: card briefly highlights green when command lands
5. **Failure handling**: if injection fails (worker not reading stdin, CC session unreachable), show inline error in card

### Acceptance

- Operator workflow: type → Ctrl+Enter → see command in tail → see green flash → see worker react
- Command history dropdown shows last 5 with timestamps
- Template buttons insert into textbox (don't auto-send)
- 4+ tests passing

### Commit
`feat(workers): command injection UX polish — history + templates + shortcuts`

### Open PR #2

`feat(workers): command injection per worker (operator → worker, audit-logged) (closes v0.7 PR #2)`

---

## P5 · `worker_question` event + Steward subscribe + auto-answer (PR #3, 2h)

**Files**:
- `src/types/events.ts` — add `worker_question` + `worker_answer` event kinds
- `src/workers/question-protocol.ts` (new) — convention for workers to ask questions
- `src/steward/worker-qa.ts` (new) — Steward's subscriber that auto-answers from lessons (per ADR-032)
- `tests/steward/worker-qa.test.ts`

### Convention for workers to ask questions

Workers (especially CC, but also custom shell workers) can emit:
```ts
broker.publish({
  kind: 'worker_question',
  source_agent: 'cc:worker-XXX',
  correlation_id: workerCorrelationId,
  payload: {
    question_id: uuid,
    question_text: "Two candidate config files found: ./config/dev.yml and ./config/local.yml. Which should I use?",
    context: { file_paths: [...], current_task: "..." },
    timeout_ms: 60_000,  // wait this long before falling back to default
    default_answer: "./config/local.yml"  // optional
  }
});
```

### Steward subscribes

Steward subscribes to `worker_question` events for workers spawned within its scope. For each:
1. Check Steward's lessons-learned table (per ADR-032 §Decision 2): "Have I answered a similar question before with success?"
2. If lesson match with high confidence (>0.8): emit `worker_answer` with the lesson's answer + `source: "steward-lesson"`
3. If no lesson or low confidence: escalate to operator (emit `notification_requested` with the question + answer-options)
4. Operator answers via dashboard → emit `worker_answer` with `source: "operator"`
5. Worker receives answer, continues

### Acceptance

- Synthetic test: emit `worker_question` from a CC worker → Steward sees it, picks from lessons, emits `worker_answer`, worker proceeds
- Test: no lesson match → notification fires to operator → operator answers via dashboard → worker proceeds
- Test: timeout → default_answer used, `worker_answer_timeout` event logged
- 6+ tests passing

### Commit
`feat(workers): worker_question event + Steward auto-answer from lessons + operator escalation`

---

## P6 · Operator answer UI in Workers Console (PR #3, 2h)

**Files**:
- `src/dashboard/widgets/worker-question-panel.ts` (new) — shows pending questions per worker card
- `src/dashboard/widgets/worker-card.ts` — surface question chip
- Tests

### UI

When a worker has a pending question:
- Card header shows ❓ chip (yellow halo)
- Tail shows the question text
- Below tail: "AWAITING ANSWER" panel with:
  - Question text
  - Steward's suggested answer (if any) with confidence score
  - Operator response: textbox + [Use Steward's answer] [Override with operator answer] [Use default + log] buttons
  - Timer: time remaining before timeout

### Steward override path

Operator can click "Override with operator answer" to bypass Steward's suggestion. This is logged as `worker_answer_overridden` for Steward to learn from (refine lessons-learned).

### Acceptance

- Pending questions surface visually on card
- Steward's suggestion visible with confidence
- Operator can accept, override, or use default
- Timer counts down accurately; auto-uses default at 0
- 5+ tests passing

### Commit
`feat(workers): operator answer UI for worker questions + Steward override path`

---

## P7 · Docs + bidirectional protocol spec (PR #3, 1.5h)

**Files**:
- `docs/workers-console.md` (new) — operator guide
- `docs/worker-question-protocol.md` (new) — protocol spec for worker authors
- `docs/cc-injection-recipes.md` (new) — what `/btw` and other CC injection patterns do
- `CHANGELOG.md` v0.7 entry

### Operator guide content

- Tour of the page
- How to spawn a worker
- How to inject commands (per type)
- How to handle worker questions (auto vs operator override)
- Best practices for shell worker stdin patterns
- Best practices for CC `/btw` use

### Acceptance

- First-time operator can: spawn worker, inject command, answer a question
- Worker author can read protocol spec and implement `worker_question` correctly

### Commit
`docs(workers): operator guide + protocol spec + cc injection recipes`

### Open PR #3

`feat(workers): Steward Q&A + operator override + docs (closes v0.7)`

---

## Budget

- **Time**: 14–18h CC across 3 PRs
- **API cost**: ~$15–25
- **LOC change**: ~2,500–3,500 net
- **Token cap**: 2M (split across 3 PRs)
- **New deps**: none (uses existing SSE + MCP infrastructure)
- **Schema change**: 1 additive table (`worker_commands`); event taxonomy extension

---

## Footgun appendix

1. **Stdin pipe deadlock** — if shell worker isn't reading stdin (e.g., long Get-FileHash that never reads stdin), an unconsumed write may block. Use non-blocking write + buffered queue with overflow drop (5 commands max queued).
2. **CC session injection** — Claude Code's MCP session model needs to accept appended messages mid-session. If CC isn't designed for this, may need to use a side-channel (e.g., write to a file CC polls). Investigate at P3 start.
3. **Audit completeness** — every command, every question, every answer is a logged event. Volume could be high during interactive sessions. Confirm event retention handles it.
4. **Operator vs Steward race on questions** — both could try to answer simultaneously. First-write-wins via DB constraint + event ordering. Loser sees "Answered by [operator/steward] · your response ignored".
5. **Lessons-learned confidence calibration** — Steward auto-answer threshold (0.8 confidence) is heuristic. Track false-positive rate; tune.
6. **Question timeouts during operator AFK** — if operator is away when question fires, default_answer used. Notification still fires so operator can investigate retroactively.
7. **Federated peer authority** — v0.7 explicitly NO-GO for peer command injection. Future v0.8+ adds federated worker control with peer trust scope.
8. **Mute Notify per-worker** — when operator mutes a worker's notifications, ALL events from that worker stop ringing the phone. But events still flow to dashboard + Steward subscribers. Document the difference.
9. **Spawn dialog with cc worker type** — needs operator's branch + base + brief. Could be a longer form; dialog should support markdown preview of the brief.
10. **History tab pagination** — 20 per page with infinite scroll; older workers (>30 days) only via "Show all" toggle (expensive query).

---

## Open questions (FLAGGED — do not pre-answer)

### §1 — Should command-input support multiline messages or single line only?

Default: single line + Shift+Enter for newline. Long messages should go to a separate "send rich command" dialog.

### §2 — Should Steward's auto-answers require operator confirmation if confidence is below 0.95?

Default: 0.8 auto, 0.5-0.8 suggest-but-wait-for-operator, <0.5 escalate. Tunable per-operator.

### §3 — Should there be a "broadcast command" feature (send same message to all active workers)?

Default: NO in v0.7. Sounds useful but risk of spraying confusing context. Operator should target specific workers.

### §4 — Should worker_question events be visible in `/dashboard/decide`?

Default: YES — they're decisions too. Show in Decide queue with worker context.

### §5 — Should there be a "kill all crashed workers" bulk action in History tab?

Default: NO in v0.7. Individual archival, not bulk. Bulk actions invite mistakes.

---

## Run prompt for CC (PR #1)

```
Read CLAUDE.md first. Then read proposed/v0_7-workers-console-bom.md and execute P0-P2 sequentially.

Sensitivity: HIGH. Operator approval gate between PRs. Status-check before every mutating git op (CLAUDE.md §8).

Work on a NEW branch: `git checkout -b feat/v0.7-workers-console-pr1` from latest main (which includes v0.6.5/v0.6.6/v0.6.7 merged). Never commit to main.

Rules: one commit per phase, DCO -s, file size verify >15KB, npm test must pass, after P2 opens PR STOP. Don't proceed to PR #2.

Open questions §1-§5 flagged — pick conservative default.

Go.
```

## Run prompts for CC (PR #2 + PR #3)

```
[PR #2]
PR #1 merged. Scope: P3 (command injection) + P4 (UX polish). Open PR at end of P4. Same rules. Go.

[PR #3]
PR #2 merged. Scope: P5 (worker_question + Steward) + P6 (operator answer UI) + P7 (docs). Open PR at end of P7. Same rules. Go.
```

---

## End of brief
