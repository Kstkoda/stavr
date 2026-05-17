# stavR · v0.6.9 — Tool catalog + Topology permissions matrix + Layer 0 capability disables

> Major redesign PR (3 PRs). Implements the operator's two biggest visibility/control gaps surfaced during the 2026-05-17 audit:
> 1. **"I see nothing about what tools stavR has"** — adds `/dashboard/tools` page listing all ~60 stavR-exposed MCP tools with description, category, current tier, recent invocations, who called them
> 2. **"manage rights for stewards / anyone in those tools"** — adds per-actor permissions matrix overlaid on Topology, with the new **Layer 0 Capability Master Switch** (operator runtime hard gate per-tool that overrides all scope grants)

This is the BOM that makes the 5-layer governance model (Lex Insculpta → No-Go → Capability Master Switch → Per-actor Permissions → Trust Scopes) VISIBLE + EDITABLE in the operator UI. Without it, governance is conceptual; with it, the operator literally points-and-clicks their authority.

**Estimated wall-clock**: 12–16 hours CC sequential across 3 PRs.

**Sensitivity**: `high` per CLAUDE.md §9 — touches permission semantics, runtime authorization gates, the operator's primary control surface. Operator approval gate between PRs.

**Stop conditions**: end of any phase if `npm test` regresses, build fails, any test demonstrates Layer 0 disable can be bypassed (active scope or operator's own scope shouldn't override), or any test demonstrates the permissions matrix UI can corrupt stored permissions silently.

**Do NOT pause for approval** between phases within a PR.

---

## Why this matters

Operator's questions during audit (verbatim 2026-05-17):
- *"how many tools do i have available in stavr, i see nothing about that anywhere"*
- *"they should be available in topo so i can granular manage the rights stewards or anyone will have in dose tools"*
- *"if i disable a write feature on github integration in the topo map, it does not matter what trust scope is there because the capability is temporary or permamently disabled"*

Three asks, one BOM. Closes the entire operator-visibility-and-control loop for stavR's tools.

**Lex Insculpta posture**: operator-sovereignty becomes UI-actionable. Today the operator can authorize via trust scope (one-time grant) but cannot pre-shape what tools an actor CAN call independent of scope grants. With v0.6.9: operator builds a baseline policy (per-actor tier per-tool) AND can master-disable tools entirely. Scope grants then operate WITHIN that baseline.

Per memory: `project_stavr_layer_0_capability_disable.md` is the architectural spec; this BOM is its implementation.

---

## Reference reading

1. `CLAUDE.md` — invariants
2. Memory `project_stavr_layer_0_capability_disable.md` — Layer 0 design
3. Memory `project_stavr_four_tier_approval_model.md` — 4-tier model (AUTO/CONFIRM/EXPLICIT/NO-GO)
4. `adr/022-trust-scopes-supersede-per-action-confirm.md` — trust scope semantics this lives WITH
5. `adr/040-three-process-architecture.md` — Engine owns the permission registry; Topology surfaces it; Governor enforces at OS-level if extreme
6. `src/tools/*` + grep for `server.registerTool` — the existing tool registration surface to introspect
7. `src/security/trust-scopes.ts` — current authorization logic to extend
8. `src/dashboard/pages/topology.ts` — existing page that gains the permissions overlay
9. `proposed/v0_6_8-diagnostics-engine-room-bom.md` — diagnostics work that's complementary (engine room shows USAGE; this BOM shows AUTHORITY)

---

## Don't touch

- Lex Insculpta source (`src/security/lex-insculpta.ts` if it exists) — unchanged
- No-Go list semantics (Layer 2) — Layer 0 is ABOVE it, doesn't change how no-go works
- Trust scope EXPIRY semantics (Layer 4) — Layer 0 disables don't affect scope expiry
- Notification fabric — orthogonal
- Worker lifecycle (covered by v0.6.6) — orthogonal
- Steward subprocess code — orthogonal
- The MCP tool registration mechanism itself (`server.registerTool`) — extend metadata, don't change how registration works

---

## Hard rules

1. **Tests are derivative** — if existing tests assert "tool X is callable for actor Y if scope grants it," extend to "AND Layer 0 capability is enabled"
2. **Never lose files** — `stat -c %s` + `tail -5` for any file >15KB
3. **Status-check before every git op** (CLAUDE.md §8)
4. **Layer 0 disable beats EVERYTHING below it** — no scope grant, no per-actor permission, no operator-authority can override a Layer 0 disable without first re-enabling. Only Lex Insculpta beats Layer 0 (and Lex requires source-code change to amend, so it's a higher-friction override by design).
5. **Persistence**: Layer 0 state + permissions matrix MUST survive daemon restart. Stored in DB (additive tables) + serialized to `~/.stavr/capability-overrides.yaml` (human-readable mirror operator can edit manually)
6. **Audit**: every Layer 0 toggle + every permission-matrix change emits an event with operator + timestamp + duration + before/after state. Per ADR-041's "our universe" universal trace.
7. **UI-API separation**: every permission change goes through a typed API endpoint (not direct DB writes from page); enables future scripting + federation auditing
8. **NEVER allow an MCP client to change permissions** — only the operator (via dashboard session with valid auth) can edit the matrix. MCP-tool-to-edit-permissions is hard NO-GO.
9. **DCO -s, per-phase commits, push at end of each phase. 3 PRs.**

---

## Phase-group structure (3 PRs)

| PR | Phases | Scope | Wall-clock |
|---|---|---|---|
| #1 — Tool catalog + introspection API | P0, P1, P2 | Discover all registered tools, build catalog metadata, ship `/dashboard/tools` browse page | 4–5h |
| #2 — Permissions matrix + Layer 0 disables | P3, P4, P5 | Per-actor tier matrix on Topology, Layer 0 master-switch UI, persistence layer, runtime authorization changes | 5–7h |
| #3 — Named policies + import/export + docs | P6, P7, P8 | Save matrix configurations as named policies (e.g., "tight", "developer", "review-only"), import/export YAML, operator guide | 3–4h |

Each PR is independently merge-able. PR #1 alone delivers the tool catalog visibility. PR #2 adds the editable control plane. PR #3 polishes for reusability.

---

## P0 · Pre-flight (Kenneth, before CC kicks off)

~5 min:
1. `git status` clean; verify v0.6.6 (PR #36 worker fidelity) ideally merged for the lifecycle helpers it provides — NOT a strict dep, but PR #2 benefits from worker-fidelity counters
2. `npm test --run` baseline = current passing count
3. Dispatch CC with PR #1 brief

---

## P1 · Tool introspection — registry + metadata (PR #1, 1.5h)

**Files**:
- `src/tools/registry.ts` (new) — central tool catalog with metadata
- `src/tools/categories.ts` (new) — tool categorization (worker / scope / github / steward / etc.)
- Extend `src/server.ts` to record every `server.registerTool` call into the registry
- `tests/tools/registry.test.ts`

### Registry data shape

```typescript
interface ToolMetadata {
  id: string;              // e.g., "worker_spawn", "host_exec"
  category: ToolCategory;  // 'worker' | 'scope' | 'github' | 'steward' | 'credentials' | 'subscription' | 'notification' | 'shell' | 'other'
  description: string;     // pulled from tool's MCP description field
  defaultTier: Tier;       // default per-actor tier (AUTO / CONFIRM / EXPLICIT / NO_GO)
  reversibility: 'reversible' | 'irreversible';
  paramsSchema: unknown;   // Zod schema introspected
  registered_at: string;
  registered_by: string;   // which subsystem registered it
}
```

### Acceptance

- Every existing `server.registerTool(name, ...)` call also calls `registry.record(meta)` 
- ~60+ tools enumerated correctly
- Categories auto-derived from id prefix + module
- 8+ tests passing

### Commit
`feat(tools): central registry + categorization for all MCP tools`

---

## P2 · `/dashboard/tools` browse page (PR #1, 2h)

**Files**:
- `src/dashboard/pages/tools.ts` (new)
- `src/dashboard/data/tools-data.ts` (new) — fetcher
- `src/dashboard/widgets/tool-card.ts` (new)
- `src/dashboard/shell.ts` — add "Tools" nav link (between MCPs and Capabilities)
- `tests/dashboard/tools-page.test.ts`

### Page design

```
┌──────────────────────────────────────────────────────────────────┐
│ Tools · 62 registered · 47 called in last 24h                    │
│ Filter: [All ▾] [Category: All ▾] [Search...]    Sort: name/usage│
├──────────────────────────────────────────────────────────────────┤
│ ┌──────────────────────┐ ┌──────────────────────┐ ┌────────────┐│
│ │ worker_spawn         │ │ host_exec            │ │ emit_event ││
│ │ category: worker     │ │ category: shell      │ │ category:..││
│ │ default tier: CONFIRM│ │ default: EXPLICIT    │ │ default:.. ││
│ │ 23 calls last 24h    │ │ 47 calls last 24h    │ │ 0 calls .. ││
│ │ top callers:         │ │ top callers:         │ │ ...        ││
│ │  - cowork-claude (15)│ │  - cowork-claude (45)│ │            ││
│ │  - operator (8)      │ │  - operator (2)      │ │            ││
│ │ [details →]          │ │ [details →]          │ │            ││
│ └──────────────────────┘ └──────────────────────┘ └────────────┘│
└──────────────────────────────────────────────────────────────────┘
```

Click card → drawer with full metadata + recent invocations + per-actor breakdown.

### Acceptance

- All registered tools visible
- Search/filter work
- Recent invocations counted accurately (last 24h, from events table)
- Top-callers correctly attributed
- 6+ tests passing

### Commit
`feat(dashboard): /dashboard/tools browse + filter + per-tool detail drawer`

### Open PR #1

`feat(tools): catalog + browse page (closes v0.6.9 PR #1)`

---

## P3 · Layer 0 capability storage + runtime gate (PR #2, 1.5h)

**Files**:
- `src/security/capability-overrides.ts` (new) — Layer 0 storage + check
- `src/persistence.ts` (extend) — additive table `capability_overrides`
- `src/security/authorization.ts` (extend) — Layer 0 check BEFORE existing tier check
- `tests/security/capability-overrides.test.ts`

### Schema (additive)

```sql
CREATE TABLE IF NOT EXISTS capability_overrides (
  tool_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,       -- 'enabled' | 'disabled-temporary' | 'disabled-permanent'
  disabled_until INTEGER,    -- unix ms; for 'disabled-temporary'
  reason TEXT,               -- operator's note
  set_by TEXT NOT NULL,      -- operator identifier
  set_at INTEGER NOT NULL
);
```

### Runtime check ordering (5-layer model)

```
authorize(tool_id, actor, params):
  1. Lex Insculpta hard check (source-code constants) → if hit, return DENY
  2. No-Go rules check (allowlist exclusions) → if hit, return DENY
  3. Layer 0 capability check → if disabled, return DENY    ⭐ NEW
  4. Per-actor permission check (Layer 3) → if tier=NO_GO, DENY
  5. Trust scope check (Layer 4) → if scope active + covers, allow per tier
```

### YAML mirror

`~/.stavr/capability-overrides.yaml` written on every change:

```yaml
# stavR capability overrides — operator-editable
# Disabling a tool here overrides all scope grants regardless of scope state.
# Edit then send SIGHUP to daemon, or use dashboard.
tools:
  github_merge_pr:
    state: disabled-temporary
    disabled_until: '2026-06-01T00:00:00Z'
    reason: 'pause all merges during release freeze'
    set_by: operator
    set_at: '2026-05-18T08:00:00Z'
  host_exec:
    state: enabled
```

### Acceptance

- Disabling `worker_spawn` via API → next worker_spawn MCP call returns DENY regardless of active scope
- Re-enabling restores normal authorization
- Temporary disable expires at `disabled_until` (event emitted on transition)
- YAML mirror writes correctly + readable on restart
- 8+ tests passing (including: scope active + Layer 0 disabled → DENY; no scope + Layer 0 enabled → DENY by normal tier; etc.)

### Commit
`feat(security): Layer 0 capability master switch (operator runtime hard gate above scopes)`

---

## P4 · Per-actor permissions matrix (PR #2, 2h)

**Files**:
- `src/security/actor-permissions.ts` (new)
- `src/persistence.ts` (extend) — additive `actor_permissions` table
- `src/security/authorization.ts` (extend) — Layer 3 check uses this
- `tests/security/actor-permissions.test.ts`

### Schema (additive)

```sql
CREATE TABLE IF NOT EXISTS actor_permissions (
  actor_id TEXT NOT NULL,     -- 'operator' | 'cowork-claude' | 'cc:worker-NNN' | 'steward' | 'peer:<spawn>'
  tool_id TEXT NOT NULL,
  tier TEXT NOT NULL,         -- 'AUTO' | 'CONFIRM' | 'EXPLICIT' | 'NO_GO'
  set_by TEXT NOT NULL,
  set_at INTEGER NOT NULL,
  PRIMARY KEY (actor_id, tool_id)
);
CREATE INDEX IF NOT EXISTS idx_actor_permissions_actor ON actor_permissions(actor_id);
```

### Default actors (auto-registered when first seen)

- `operator` (you)
- `cowork-claude` (your Cowork session)
- `cc` (Claude Code workers, with sub-IDs per worker)
- `steward` (the Steward subprocess)
- `peer:<spawn_id>` (federated peers per ADR-035, when present)

### Acceptance

- Setting Cowork-Claude tier=CONFIRM for `host_exec` → next host_exec call from Cowork-Claude prompts for confirmation regardless of scope tier
- Setting Steward tier=NO_GO for `github_merge_pr` → Steward NEVER auto-merges, even if scope grants it
- 6+ tests passing

### Commit
`feat(security): per-actor permissions matrix (Layer 3 of 5-layer model)`

---

## P5 · Topology permissions overlay (PR #2, 1.5h)

**Files**:
- `src/dashboard/pages/topology.ts` (extend) — add permissions panel on actor-node click
- `src/dashboard/widgets/permissions-matrix.ts` (new)
- `src/dashboard/widgets/capability-disable-toggle.ts` (new)
- `src/dashboard/data/permissions-data.ts` (new) — API for matrix CRUD
- `tests/dashboard/permissions-matrix.test.ts`

### UI design

Click an actor node on Topology → side drawer opens with permissions panel:

```
┌── Permissions for: cowork-claude ──────────────┐
│ tool                  | tier         | Layer 0 │
│ ────────────────────── ────────────── ──────── │
│ worker_spawn          | CONFIRM ▾    | ✓ on    │
│ host_exec             | EXPLICIT ▾   | ✓ on    │
│ github_merge_pr       | NO_GO ▾      | ✗ DISABLED (until 2026-06-01) │
│ emit_event            | AUTO ▾       | ✓ on    │
│ ...                                            │
│                                                │
│ [Apply policy: ▾] [Save as policy...] [Reset] │
└────────────────────────────────────────────────┘
```

Above the matrix: per-tool Layer 0 master switch (operator-only). Toggle DISABLED → tool unavailable to ALL actors regardless of their per-actor tier.

### Acceptance

- Click actor node → permissions panel opens with current matrix
- Change a tier dropdown → POST to API → DB updated → next call respects new tier
- Toggle Layer 0 disable → all actors immediately blocked from that tool
- "Apply policy" loads a named policy (from PR #3)
- 6+ tests passing

### Commit
`feat(dashboard): Topology permissions matrix + Layer 0 toggle UI`

### Open PR #2

`feat(security+dashboard): Layer 0 + per-actor permissions + Topology UI (closes v0.6.9 PR #2)`

---

## P6 · Named policies (save/load/preset) (PR #3, 1.5h)

**Files**:
- `src/security/policies.ts` (new) — named permissions presets
- `src/persistence.ts` (extend) — additive `permission_policies` table
- 3 built-in policies shipped: "tight" (everything CONFIRM+), "developer" (worker_spawn AUTO for operator + steward), "review-only" (everything CONFIRM or higher)
- `tests/security/policies.test.ts`

### Acceptance

- Operator can "Save current matrix as policy 'X'"
- Operator can "Apply policy 'X' to actor Y" — overwrites Y's matrix
- 3 built-in policies present + tested
- 5+ tests passing

### Commit
`feat(security): named permission policies + 3 built-in presets`

---

## P7 · YAML import/export + operator scripting (PR #3, 1h)

**Files**:
- `src/security/policies-yaml.ts` (new)
- `governor-cli` (or stavr-cli) command: `stavr permissions export --actor cowork-claude > my-policy.yaml`
- `stavr permissions import my-policy.yaml --actor cowork-claude`
- `tests/security/policies-yaml.test.ts`

### Acceptance

- Round-trip YAML export → import → same matrix
- CLI commands work
- 4+ tests passing

### Commit
`feat(security): YAML import/export for portable policy management`

---

## P8 · Operator docs + 5-layer model visualization (PR #3, 1h)

**Files**:
- `docs/permissions.md` (new) — operator guide to the 5-layer model + how to use the matrix
- `docs/policies.md` — using named policies
- Diagram in dashboard footer: small visual showing where Layer 0 + per-actor permissions sit in the 5-layer stack
- `CHANGELOG.md` v0.6.9 entry

### Acceptance

- First-time operator can: open Topology → click actor → set permissions → save policy → export YAML → import on another machine
- Docs cover the 5 layers explicitly
- CHANGELOG comprehensive

### Commit
`docs(security): 5-layer model guide + permissions UI walkthrough`

### Open PR #3

`feat(security): named policies + YAML + docs (closes v0.6.9)`

---

## Budget

- **Time**: 12–16h CC across 3 PRs
- **API cost**: ~$20–32
- **LOC change**: ~2,500–3,500
- **Token cap**: 2M (split across 3 PRs)
- **New deps**: maybe `js-yaml` if not already present (for YAML import/export)
- **Schema change**: 3 additive tables (`capability_overrides`, `actor_permissions`, `permission_policies`)

---

## Footgun appendix

1. **Layer 0 disable must apply IMMEDIATELY** — not on next daemon restart. In-process registry updates atomically. Test: disable, immediately try to call, must DENY.
2. **YAML mirror sync** — operator editing YAML must trigger reload OR document that dashboard is the canonical source. Default: dashboard wins; YAML edits require SIGHUP to take effect.
3. **Actor identity attribution** — `cowork-claude` is one MCP session, but the operator might run multiple Cowork instances. Use session ID for fine-grain (`cowork-claude:session-X`) but show in UI as just `cowork-claude` with session detail in drawer.
4. **Steward actor** — Steward subprocess might call MCP tools via the daemon. Identity should be `steward` consistently (per ADR-040). Confirm in v0.5 wiring.
5. **Operator self-restriction** — operator CAN restrict their own tools via the matrix. Useful for "I'm about to do something stupid, restrict myself" pattern. Test it works.
6. **Layer 0 vs No-Go** — Layer 0 is RUNTIME operator-settable; No-Go is SOURCE-CODE permanent. If operator wants to permanently disable, they can disable in Layer 0 (permanent state) OR submit a PR to add to No-Go list (source change).
7. **Policy conflicts** — applying policy X overwrites individual tier choices. Default: confirm with operator before overwriting non-default tiers ("Policy X will overwrite 12 custom tiers — proceed?").
8. **Audit completeness** — every change logged. Operator can answer "who set Steward's host_exec to EXPLICIT, when, why?" via the events table.

---

## Open questions (FLAGGED — do not pre-answer)

### §1 — Should Layer 0 disables be peer-replicated under federation (ADR-035)?

Default: NO in v0.6.9. Each operator's stavR has its own capability overrides. A federated peer's disable doesn't affect your local. Revisit when federation team mode matures.

### §2 — Should there be a "panic mode" master switch that disables ALL non-essential tools in one click?

Default: NO in v0.6.9 but flag as v0.7+ candidate. Operator can apply the "tight" preset for similar effect.

### §3 — Should the matrix support time-windowed permissions ("Cowork-Claude can host_exec only 09:00-18:00")?

Default: NO in v0.6.9. Layer 4 trust scopes have time-bounded grants which cover most of this. Conditional time-windowing is a v0.7+ candidate.

### §4 — Should default tier per tool be UPGRADABLE only (operator can make stricter, not looser, than registered default)?

Default: operator CAN make looser (with friction). Friction = require explicit confirmation when downgrading. Documented in UI.

### §5 — Should there be a "policy preview" mode that shows what would change before applying?

Default: YES. Always show diff before apply.

---

## Run prompt for CC (PR #1)

```
Read CLAUDE.md first. Then read proposed/v0_6_9-tool-catalog-and-permissions-bom.md and execute P0-P2 sequentially.

Sensitivity: HIGH. Operator approval gate between PRs. Status-check before every mutating git op (CLAUDE.md §8).

Work on a NEW branch: `git checkout -b feat/v0.6.9-tools-pr1` from latest main. Never commit to main.

Rules: one commit per phase, DCO -s, file size verify >15KB, npm test must pass per commit. After P2 opens PR, output final delta report and STOP. Don't proceed to PR #2.

Open questions §1-§5 flagged — pick conservative defaults, document in PR body.

Go.
```

## Run prompts for CC (PR #2 + PR #3)

```
[PR #2]
PR #1 merged. Scope: P3 (Layer 0 storage) + P4 (per-actor permissions) + P5 (Topology UI). Open PR at end of P5. Same rules. Go.

[PR #3]
PR #2 merged. Scope: P6 (named policies) + P7 (YAML import/export) + P8 (docs). Open PR at end of P8. Same rules. Go.
```

---

## End of brief
