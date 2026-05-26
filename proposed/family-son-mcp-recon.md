# Recon: family-son-mcp Phase 0 — pre-implementation findings

**Status:** Phase 0 output. Operator review required before Phase 1 is or isn't run.
**Branch:** `feat/family-son-mcp` (off `main` at `53a32f6` — the BOM-commit tip)
**Sensitivity:** `careful` — research only, no code edits in this phase.
**Scope:** answer the BOM's one open question — *does the tool-call chokepoint enforce per-resource trust-scopes, or only per-actor tier?* — and pin whatever else the remaining phases depend on.

---

## TL;DR — go/no-go on Phase 1

The BOM's open question splits cleanly in two when you look at the code as it stands today:

1. **Tool-granularity fence — PRESENT.** A paired remote son's actor_id is stamped `peer:<deviceName>` by the transport middleware (`src/transports.ts:526-536`). `ActorPermissionStore.resolve()` (`src/security/actor-permissions.ts:175-182`) treats any actor that is NOT loopback-shape and NOT in `KNOWN_ACTORS` as **default-deny → tier NO_GO**. The chokepoint hard-denies NO_GO. So without an explicit `actor_permissions` matrix row, every tool the son tries is denied — structurally, not opt-in. This is the Phase 5.6 widening of family-mode-phase-1 (committed on main); the recon memo for that BOM (`proposed/family-mode-phase-1-recon.md`) was written before the widening landed and therefore does NOT mention it.
2. **Resource-granularity fence (per-repo, per-path) — ABSENT.** Trust-scope `param_constraints` (e.g., `{repo: "^Kstkoda/stavr$"}`) are never consulted at the chokepoint. Trust scopes also have no `actor_id` binding in their schema — they are global. They are consulted only inside `gatedAction()` (github-writes + trust/tools) and inside `host_exec`'s own pre-check. A matrix row of `tier=AUTO` for `github.read_file` lets the actor read **any repo's any file**, not just the repo a trust-scope grant would name.

So the BOM's "if per-resource enforcement is missing, Phase 1 is REQUIRED before any son connects" condition is **true at the resource layer, false at the tool layer**. The operator's call is which interpretation of "GitHub-read; nothing else" he wants — see §6 (Recommendation) below.

The memory record `stavr-trust-scope-enforcement-gap` (2026-05-23) was correct on the day it was written but is **stale on the tool-granularity half** — Phase 5.6 closed that half. The resource-granularity half is still open and matches the memory's "a connected son can invoke any tool" framing only if the operator grants a too-wide matrix row.

---

## 1. family-mode-phase-1's landed surface — confirmed present

Verified by reading the code, not the prior recon memo. Every claim below cites file:line in the current tree.

### 1.a Structural chokepoint, multi-layer gate

**Location:** `src/server.ts:394-403`, wiring `buildChokepointGate` (`src/security/decision-gate.ts:210-326`) into `wrapServerForRegistry`. Every `server.registerTool()` is patched (`src/tools/registry.ts:175-203`) so every tool handler runs through the gate before the subsystem handler sees the call.

**Layer order (top denies first), per `buildChokepointGate`:**

1. **No-Go list** (`src/trust/no-go-list.ts`) — `checkNoGo(toolId, args)` at `decision-gate.ts:227`. Identity-blind hard deny; emits a `no_go_match` audit event.
2. **Layer 0 capability switch** (`src/security/capability-overrides.ts`) — `stores.capability.check(toolId)` at `decision-gate.ts:248`. Operator runtime kill switch.
3. **Per-actor permission tier** (`src/security/actor-permissions.ts`) — `stores.actorPermissions.resolve(actor, toolId)` at `decision-gate.ts:254`. The actor identity comes from `logContext.actor_id` (AsyncLocalStorage), not a caller-supplied string.
   - **AUTO** → allow.
   - **NO_GO** → deny (`per-actor NO_GO: actor "..." cannot invoke ...`).
   - **EXPLICIT** → requires a recent operator WebAuthn assertion (`tier3-gate.ts::requireRecentTier3Assertion`) BEFORE the operator-confirmation decision opens. Without an assertion → deny + `tier3_assertion_required` audit event.
   - **CONFIRM** → opens an `await_decision` cycle via `runChokepointDecision` (`decision-gate.ts:88-190`).
4. **Trust-scope (Layer 5)** — NOT consulted at the chokepoint. (See §3.)

The chokepoint stamps `source_agent` + `tier` on every decision it opens (`decision-gate.ts:124-148`), so `respond_to_decision` can enforce no-self-approval and operator-only on a trustworthy provenance.

### 1.b The decision route's self-approval hole — closed

`respond_to_decision` and `dashboard/.../respond` both run through `mayRespond` (`src/security/respond-policy.ts`). Verified by transports.ts:2724-2730 reading `logContext.actor_id` (set by HTTP middleware, not the caller body) before invoking the response path. The originating `source_agent` is stamped on the decision row by the chokepoint (decision-gate.ts:130), so the responder ≠ requester check has a trustworthy provenance.

### 1.c Non-loopback bind + bearer-auth — wired and active

`src/transports.ts`:
- bind-host guard at `transports.ts:210-219`: refuses non-loopback unless `authConfigured` (≥1 active paired device) AND `requireAuthWhenNonLocal` allows it.
- Bearer-auth middleware (`transports.ts:411-437`) active iff `authConfigured && !isLoopback`. Public allowlist: `/healthz`, `/pair/initiate`, `/pair/complete`.
- After bearer-auth, the **Phase 4.5 actor-id stamper** (`transports.ts:526-536`) sets `logContext.actor_id`:
  - `req.device` present → `peer:<deviceName>`.
  - Else loopback signal → `loopback:<corr>`.
  - Else → `'unknown'`.
- After the stamper, the **Phase 5 loopback-only fence** (`transports.ts:554+`) returns 403 on `/dashboard/*` and `/events/sse` for non-loopback callers — so a paired peer with a valid token still can't tail the operator's audit log.

### 1.d Test-mode bypass — guarded both ways

`STAVR_CHOKEPOINT_TEST_AUTO_APPROVE=1` only enables the chokepoint auto-approve when `VITEST=true` or `NODE_ENV=test` (`decision-gate.ts:70-72`). The daemon's boot guard (`src/daemon.ts`, search `assertNoChokepointTestBypassInProduction`) refuses to start if the env var is set without the test signal. Every actual bypass emits a `decision_chokepoint_test_bypass` audit event. Not a production-reachable hole; recorded here so the operator sees it during recon.

---

## 2. Where the per-actor permission matrix lives — and what default-deny means

`src/security/actor-permissions.ts:53-57`:

```ts
function isOperatorShapeActor(actorId: string): boolean {
  if (actorId === 'unstamped-loopback') return true;
  if (actorId.startsWith('loopback:')) return true;
  return (KNOWN_ACTORS as readonly string[]).includes(actorId);
}
```

`KNOWN_ACTORS` (line 32): `['operator', 'cowork-claude', 'cc', 'steward']`.

`ActorPermissionStore.resolve(actorId, toolId)` (`actor-permissions.ts:175-182`):

```ts
resolve(actorId, toolId): ResolvedTier {
  const row = this.get(actorId, toolId);
  if (row) return { tier: row.tier, source: 'matrix' };
  if (isOperatorShapeActor(actorId)) {
    return { tier: defaultTierFor(toolId), source: 'default' };
  }
  return { tier: 'NO_GO', source: 'default-deny' };
}
```

The header comment on the function (lines 148-174) is explicit:

> Anything else (paired peers `peer:*`, the transport's `'unknown'` stamp for non-loopback requests without a verified device, future unrecognized actor_id shapes) → default-deny: tier NO_GO, source `'default-deny'`. The chokepoint hard-denies NO_GO before the gatedAction trust-scope check runs.

> Trust-scope-driven authorization for default-denied actors would be a future widening (chokepoint scope-aware override or a new tier-resolution layer).

**That last sentence is exactly the Phase 1 work this BOM contemplates.** The code's own comment names the gap as a "future widening" — confirming Phase 1 is a real gap, not a misread of the codebase.

### 2.a What this means for the son

The son's paired token resolves to `peer:<name>`. With no matrix row for him:

- Every tool call → `actor_permissions.resolve('peer:son-alice', '<tool>')` → `{tier: 'NO_GO', source: 'default-deny'}`.
- The chokepoint denies with: `per-actor NO_GO: actor "peer:son-alice" cannot invoke <tool> (source=default-deny)`.

To let him do anything, the operator MUST add explicit `actor_permissions` rows. The matrix is the authoring surface.

### 2.b What the matrix CAN express today

Per-tool tier, default-deny. So the operator can author:

| actor_id | tool_id | tier | effect |
|---|---|---|---|
| peer:son-alice | `github.read_issue` | AUTO | son reads issues without prompts |
| peer:son-alice | `github.read_pr` | AUTO | son reads PRs without prompts |
| peer:son-alice | `github.read_file` | AUTO | son reads file contents |
| peer:son-alice | `github.list_prs` | AUTO | son lists PRs |
| peer:son-alice | `github.create_pr` | CONFIRM | son can propose PRs; operator confirms each one |
| (no row for anything else) | | | NO_GO at chokepoint |

> **Critical — tool IDs must use the exact dotted form.** `actor_permissions.resolve()` does a verbatim key lookup against the registered tool ID. The adapters register tools as `github.read_issue`, `github.read_pr`, `github.list_prs`, etc. (dot-separated namespace). A row authored with underscores (`github_read_issue`) silently never matches — the son gets default-deny NO_GO on every call even though the operator believes the row was granted. Use the dotted form throughout. See `docs/family-son-mcp.md §4.3` for the authoritative seed list.

That gives **tool-granularity fencing**. The son is bounded to the listed GitHub read tools (plus optionally CONFIRM-gated write tools), and **denied everything else** structurally.

### 2.c What the matrix CANNOT express today

Per-resource granularity within a tool. The matrix only keys on `(actor_id, tool_id)`. It has no concept of "this actor can call `github.read_file` against repo Kstkoda/stavr but not against repo Kstkoda/private". To bound a tool by resource, the chokepoint would need to consult trust-scope `param_constraints` for the calling actor — which is Phase 1's work.

---

## 3. Trust-scope (Layer 5) — where it lives and where it doesn't

### 3.a Schema and matcher

`src/trust/types.ts`:

```ts
export interface ActionMatcher {
  tool: string;
  param_constraints?: Record<string, unknown>;  // string '^...' = regex, else equality
  reason?: string;
}
export interface TrustScope {
  id: string;
  // ...
  granted_by: string;
  allowed_actions: ActionMatcher[];
  forbidden_actions?: ActionMatcher[];
  // ...
  // NO actor_id field.
}
```

Important: trust scopes have NO actor binding. There is no "this scope applies to actor X" column. The matcher (`src/trust/matcher.ts:matchesAny`) checks tool name + param constraints only.

### 3.b Where trust-scope IS consulted

Grep `findActiveScopeFor` / `scopeCovers`:

- `src/tools/gated-action.ts:90-144` — the trust-scope short-circuit. **Only callers**: `src/adapters/github-writes.ts` (GitHub *write* tools) and `src/trust/tools.ts` (`trust_scope_grant`, `trust_scope_extend`).
- `src/security/host-exec-tool.ts` — `host_exec`'s own bespoke pre-check (allowlist + trust-scope match).
- `src/workers/orchestrator.ts` — for the worker_dispatch path.
- `src/steward-bug-fix.ts` — Steward's path.

That's the entire enforcement surface.

### 3.c Where trust-scope is NOT consulted

The chokepoint (`buildChokepointGate` in `src/security/decision-gate.ts`) never references the trust store. Every tool that doesn't route through `gatedAction()`/`host_exec`/orchestrator simply doesn't see scope at all — it's gated by tier alone.

### 3.d What this means in practice

Suppose the operator grants the son a trust scope with `allowed_actions: [{tool: 'github.read_file', param_constraints: {repo: '^Kstkoda/stavr$'}}]`. The son calls `github.read_file({repo: 'Kstkoda/private', path: 'secrets.txt'})`. What happens at the chokepoint:

1. No-go list — no entry matches → pass.
2. Capability switch — not disabled → pass.
3. Per-actor tier — if operator added an AUTO row for `peer:son-alice × github.read_file`, tier resolves to AUTO → ALLOW.
4. Handler runs. Trust-scope is NEVER consulted at this gate. The son reads `Kstkoda/private/secrets.txt`.

The only thing that saves the operator from this scenario today is **NOT granting the AUTO matrix row in the first place** — i.e., relying on the tool-level fence and accepting that read tools can't be repo-bounded.

**This is the resource-granularity gap.**

---

## 4. The reachability + pairing surface — fit for Phase 2 / 3

Phase 2 of family-son-mcp wants: bind to WireGuard/LAN, require auth, `/healthz` answers, `/mcp` without token refuses.
Phase 3 wants: `/pair/initiate` + `/pair/complete` work machine-to-machine, the son's token grants `/mcp` access.

The code as it stands today supports both:

- **Bind-host:** `--bind-host <addr>` CLI flag wired through `src/daemon.ts` to `transports.ts`. The transport refuses non-loopback bind without auth configured (`transports.ts:210-219`).
- **Pairing CLI both sides:** `stavr pair bootstrap` (host) + `stavr pair remote-host` (device) at `src/cli.ts:510-548+`.
- **Pairing HTTP:** `/pair/initiate` (loopback-only) and `/pair/complete` (public allowlist) wired in transports.ts.
- **Bearer-auth middleware:** active on non-loopback (`transports.ts:411-437`), public allowlist for `/healthz` + pair endpoints, otherwise 401.

No code work required for Phase 2 or Phase 3 — they are operator-side setup (WireGuard, daemon launch flag, pair ceremony). The Phase 5 caveat from family-mode-phase-1's recon still stands: `STAVR_PEER_ID` defaults to `'stavr-self'`, which collides if multiple stavR daemons advertise on the same LAN. Recommend setting `STAVR_PEER_ID` per host before bringing the daemon up non-loopback. The family-son-mcp BOM only has one daemon (Kenneth's), so this is a smaller concern here, but worth noting for hygiene.

`STAVR_WEBAUTHN_RP_ID` also defaults to `localhost`. For a non-loopback bind, the operator needs to set this to the hostname / WireGuard address that the dashboard will be reached on — otherwise the passkey ceremony won't validate origin.

---

## 5. Where the son's connection actually breaks down — quick mental model

End-to-end path for `son's CC → tool call → stavR`:

1. Son's CC sends `POST /mcp` to `https://<wg-addr>:<port>/mcp` with `Authorization: Bearer <device-token>`.
2. Bearer-auth middleware (`transports.ts:411-437`): hashes token, looks up `devices` table, finds row, attaches `req.device`. (Without token → 401.)
3. Actor-id stamper (`transports.ts:526-536`): `req.device` present → `logContext.actor_id = 'peer:<deviceName>'`.
4. MCP dispatch finds the registered tool handler.
5. Chokepoint gate (`decision-gate.ts:buildChokepointGate.check`):
   - Reads `logContext.actor_id` → `'peer:son-alice'`.
   - No-go check → pass (unless tool in no-go list).
   - Capability check → pass.
   - `actor_permissions.resolve('peer:son-alice', toolId)`:
     - If matrix row exists → that tier.
     - Else (no matrix row, not operator-shape) → **NO_GO**.
   - NO_GO → chokepoint denies with `per-actor NO_GO: ...`.
6. If tier resolved is CONFIRM → opens `await_decision` → operator notified via Telegram + dashboard → operator approves/rejects.
7. If tier resolved is EXPLICIT → first checks recent WebAuthn assertion → if absent, deny; if present, opens decision.
8. If tier resolved is AUTO → handler runs.

**The son's "what can I do?" surface is the set of `(actor_id, tool_id)` matrix rows the operator has authored, plus the default-deny floor for everything else.** Trust-scope grants do not enter this picture at the chokepoint.

---

## 6. Recommendation — Phase 1 go/no-go

Two coherent stances; the operator picks:

### Option A — Accept tool-granularity, SKIP Phase 1

If "GitHub-read; nothing else" is interpreted as **tool-level** ("the son can call these specific read tools, and nothing else"), Phase 1 is NOT required.

The recipe:
1. Pair the son's machine (Phase 3 of the BOM).
2. Author `actor_permissions` rows for the son's actor_id × the GitHub read tools he needs (e.g., `github.read_issue`, `github.read_pr`, `github.read_pr_diff`, `github.read_file`, `github.list_prs`, `github.list_issues`, `github.read_commit`, `github.read_workflow_run`).
3. Set tier = AUTO for what should pass silently, or CONFIRM for "I want to see each call" (CONFIRM gives Kenneth a Telegram prompt per call, which IS the per-resource gate, at the cost of friction).
4. Leave every other (son, tool) cell empty → NO_GO at chokepoint.

Operator surface: the existing `/dashboard/permissions` page (which already understands paired-peer actors per the matrix UI).

**Pros:** zero code. Phase 1 is skipped. Smoke can start tomorrow.
**Cons:** if the son's tier for a read tool is AUTO, it reads ANY repo — no per-repo fence. If the operator wants per-repo, he must keep that tool at CONFIRM and approve each call interactively. (Annoying for high-volume read patterns; fine for write paths where one CONFIRM per call is what you'd want anyway.)

### Option B — Demand resource-granularity, RUN Phase 1

If "GitHub-read; nothing else" means **resource-level** ("the son can read repo X but not repo Y, without operator interaction each time"), Phase 1 is REQUIRED. The work:

1. Add an `actor_id` (nullable) column to `trust_scopes` so a scope can be bound to one actor — or introduce a sibling `actor_scopes` join table. (Schema decision — flag in Phase 1 PR description.)
2. Extend `buildChokepointGate` (Layer 3.5 between tier and ALLOW): if tier resolved to AUTO/CONFIRM/EXPLICIT and the tool is in the son's actor-bound scope's `allowed_actions`, override-allow OR (cleaner) require an active actor-bound scope cover BEFORE returning ALLOW; absent that, deny.
3. Default-deny mode for paired peers: even if matrix says AUTO, require an actor-bound scope cover for the specific args. Equivalent semantics: matrix is "may this actor try this tool at all?", scope is "for which params is the try allowed?".
4. UI / CLI surface to let the operator author `actor_scopes` rows. Today the trust-scope tools (`trust_scope_grant`) don't accept an actor binding.
5. Bombardment-rig oracle: "no peer can invoke a tool outside its actor-bound scope."

**Scope sizing:** non-trivial. The BOM correctly anticipates this: *"If this proves large, it spins out as its own `high`-sensitivity BOM rather than bloating this one."* My read: Option B IS a separate BOM. ~3-5 phases of its own — schema, store, chokepoint integration, surface (CLI / dashboard), tests + smoke.

### My recommendation

**Option A**, with the following operator-side discipline:

- Tier=AUTO for read tools that genuinely scan many repos (e.g., `github.list_prs` across all visible repos is fine for a son who's exploring).
- Tier=CONFIRM for read tools where per-repo matters (e.g., `github.read_file` — confirm each one so the operator sees the path before approving).
- No write tools in the son's matrix until the operator is comfortable.
- Revisit Option B as a follow-up BOM once the day-to-day friction of Option A teaches Kenneth what the actual access pattern is.

Rationale: Phase 5.6 already gives a STRUCTURAL fence (tool-level, default-deny). That alone is a meaningful safety property and a real shipping milestone. Per-resource fencing is a 2nd-order refinement — worth doing eventually but not blocking the first two-machine smoke. The "is the model actually working" question gets answered without it. And ADR-022 (trust scopes supersede per-action confirm) is still valid — when the operator wants per-resource fencing in the future, the existing trust-scope vocabulary is the natural place to land it.

---

## 7. Open items the operator should decide before any next phase

1. **Option A vs Option B** — the go/no-go on Phase 1 itself.
2. **If Option A:** the exact list of GitHub read tools to seed in the son's matrix. Today's read-tool inventory in `src/adapters/github.ts` would be the source list. Roughly: `github.read_issue`, `github.read_pr`, `github.read_pr_diff`, `github.read_pr_review_comments`, `github.read_file`, `github.read_commit`, `github.read_workflow_run`, `github.list_prs`, `github.list_pr_files`, `github.list_issues`, `github.list_commits`, `github.list_branches`, `github.list_labels`, `github.list_workflow_runs`. Confirm.
3. **The son's actor_id naming convention.** The pair-complete flow assigns a `device.name` from the CLI flag (`stavr pair remote-host -n <name>`). The resulting `peer:<name>` is what Kenneth will type into the matrix. Recommend a deliberate convention — e.g., `son-<firstname>` — so the matrix is readable. Locked in at pair time.
4. **`STAVR_PEER_ID`** — set to a per-host value (e.g., the operator's hostname) before bringing the daemon up non-loopback, to dodge `stavr-self` mDNS collisions in any future federation work. Not load-bearing for this BOM since there's only one daemon, but cheap to do.
5. **`STAVR_WEBAUTHN_RP_ID`** — set to the WireGuard hostname / address that will be the dashboard's origin BEFORE the operator pairs the WebAuthn passkey. Otherwise Tier-3 EXPLICIT actions from any non-loopback path won't validate origin. (Loopback-only operator dashboard access would still work with the default `localhost`, but if Kenneth uses the dashboard from any other interface, RP id must match.)

---

## 8. Memory updates the operator may want after reviewing this

(I won't write these without explicit operator sign-off, but flagging the deltas.)

- `stavr-trust-scope-enforcement-gap` (2026-05-23) — **partially superseded** by family-mode-phase-1 Phase 5.6. Tool-level fence is now structural via actor_permissions default-deny. Resource-level fence remains open. Suggest revising the memory body to reflect the split, or replacing with a tighter `stavr-resource-granularity-fence-gap` memo.
- `stavr-family-resource-gateway-model` (if it exists) — note that the "son's CC = remote MCP client" mechanism is supported end-to-end by the code today; the only operator-side prerequisite is `actor_permissions` matrix authoring.

---

## End of Phase 0 recon

Next step: **operator review.** No Phase 1 code change has been made. Phase 1 (if any) begins only after the operator picks Option A or Option B (or a variant) and signals to proceed.
