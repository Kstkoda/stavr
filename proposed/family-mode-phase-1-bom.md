# BOM: Family-mode Phase 1 — Daemon Reachable + Enforcement Wired

**Owner:** CC
**Sensitivity:** `high` — touches security primitives (the permission model), the decision-response path, and `transports.ts` (the bind). Per CLAUDE.md §9: operator approval gate BETWEEN every phase, full diff dump per phase. This is the **opposite** of a continuous megacycle — it stops for review at every phase boundary.
**Verification window:** `full` — security + transport changes; the verification phase is not optional.
**Branch:** `feat/family-mode-phase-1`
**Base:** `main` (current — includes v0.6.12, the ADR-044/045 closeout, the observability spec)
**Estimated scope:** 7 phases (0-6), 4-5 PRs, multi-day with operator gates.

---

## Why this BOM exists

Family-mode functional is the current cycle (memory `project_stavr_next_cycle_family_mode_functional`). Phase 1 makes the daemon **reachable by other machines** — and, as a hard prerequisite, makes stavR's permission model **actually enforce** before that reachability is enabled.

Two independent audits on 2026-05-20 — CC's codebase audit (branch `chore/full-codebase-audit`) and Claude's session audit — found stavR's permission model is **opt-in, not structural**: the no-go list only fires via `gatedAction()` on specific write adapters; the per-actor permission tier is never consulted at tool invocation; the Tier-3 friction string exists in three UI strings but no code path accepts one. And the decision gate can be self-answered — `cc` fires a `decision_request`, `claude-cowork` approves it, no human in the loop.

Today the daemon binds `127.0.0.1` only. That loopback bind is, functionally, the single control containing the lethal trifecta (ADR-045): nothing external can reach the daemon. **Phase 1 removes that containment** — so the enforcement must be real first.

## THE HARD RULE

**The daemon must not bind to a non-loopback interface until the permission model is enforced at the tool-invocation chokepoint AND the self-approval hole is closed.** The enforcement phases (2-4) land and merge before the bind-enable phase (5). If for any reason the enforcement phases cannot complete, Phase 5 does **not** ship — the BOM stops with the daemon still loopback-only. A reachable daemon with decorative gates is a NO-GO outcome, not an acceptable partial.

## Reference reading (CC, at Phase 0)

- `CLAUDE.md` — invariants (tests-are-derivative, never-lose-files, status-before-git-op, sensitivity flag, NO-GO handoff).
- `adr/045-mcp-server-trust-model.md` — the trust model this BOM makes real.
- `adr/034` (positioning), `adr/035` (federated A2A/OAuth), `adr/042` (federation roles/discovery).
- Memory: `project_stavr_next_cycle_family_mode_functional`, `project_stavr_four_tier_approval_model`, `project_stavr_layer_0_capability_disable`.
- Code: `src/tools/registry.ts`, `src/tools/gated-action.ts`, `src/tools/decisions.ts`, `src/trust/no-go-list.ts`, `src/trust/tools.ts`, `src/security/actor-permissions.ts`, `src/security/capability-overrides.ts`, `src/security/tier3-gate.ts`, `src/security/webauthn.ts`, `src/transports.ts`, `src/pairing.ts`, `src/federation/mdns.ts`, `src/broker.ts`.

## Don't-touch

- Dashboard pages — this is not a UI BOM (surfacing enforcement state on a page is a follow-up, not here).
- `src/persistence.ts` schema — except one additive column/table if the decision-responder validation provably needs one; flag it if so.
- Federation peer logic beyond what bind + pairing strictly needs.
- The mDNS service-name redesign (`stavr-self` collision) — that is family-mode Phase 3, not this BOM. Phase 1 here only adds the missing error handler.

---

## Phase 0 — Recon (output a findings doc, then STOP)

CC pins the facts the rest of the BOM depends on — they must not be guessed:

- **The generic tool-invocation chokepoint** — the single point every MCP tool call passes through (candidate: the dispatch path in `src/tools/registry.ts`, or the broker). Name function + file + line. If there is no single chokepoint, that itself is a finding — the BOM's Phase 2 then includes creating one.
- What `gatedAction()` currently covers and exactly what bypasses it.
- The permission components — no-go list (`src/trust/no-go-list.ts`), per-actor tier (`src/security/actor-permissions.ts`), capability master switch (`src/security/capability-overrides.ts`), Tier-3 gate (`src/security/tier3-gate.ts`) + WebAuthn (`src/security/webauthn.ts`): for each — is it callable, is it wired into invocation, is it tested? Confirm the exact layer model (L0–L4) against `project_stavr_layer_0_capability_disable`.
- The decision path — where `decision_request` is created and `source_agent` is stamped; where `respond_to_decision` validates a response. Identify exactly where the responder≠requester check belongs.
- The bind path — `bindHost` / `requireAuthWhenNonLocal` / `authConfigured` in `transports.ts`; the pairing flow in `src/pairing.ts`; what v0.7 actually built and whether cross-machine pairing currently works.

Output `proposed/family-mode-phase-1-recon.md`. **Operator reviews before Phase 1 proceeds.**

## Phase 1 — mDNS error-handling fix

Self-contained and independent (task #70). In `src/federation/mdns.ts` `start()`: attach an `'error'` listener to the `advertised` Service and to `browser`, forwarding into the coordinator's own `error` event (already routed to a log by `federation/index.ts`). The bonjour "Service name is already in use" error is **asynchronous** — it arrives via a UDP probe response, after `publish()` has returned — so the existing `try/catch` around `publish()` cannot catch it. ~6 lines + a regression test. Removes a latent uncaught-exception path.

## Phase 2 — No-go + per-actor tier enforced at the chokepoint

Every tool call — regardless of which MCP server it targets, regardless of whether it goes through `gatedAction()` — passes through the chokepoint identified in Phase 0. At that point, structurally and unconditionally:

- The no-go list is consulted; a no-go tool is denied, full stop.
- The capability master switch (Layer 0) is consulted; a disabled capability is denied regardless of any scope.
- The per-actor permission tier is consulted; the calling actor's tier for that tool gates the call (AUTO proceeds, CONFIRM/EXPLICIT route to the decision gate).

The defining test: a tool call that does **not** go through `gatedAction()` must still hit every check. Negative-path test per layer. This is the core correction to "enforcement is opt-in."

## Phase 3 — Tier-3 EXPLICIT (WebAuthn) wiring

A Tier-3 EXPLICIT action requires a real operator passkey ceremony — `src/security/tier3-gate.ts` + `webauthn.ts` (the v0.7 infrastructure). Wire the code path that **accepts** the friction: today it exists only as three UI strings. An EXPLICIT-tier tool call blocks until a valid WebAuthn assertion from the operator. Negative test: an EXPLICIT action cannot complete without one.

## Phase 4 — Close the self-approval hole

Per operator decision (2026-05-20): gated decisions must be answered by a **non-requesting actor**.

- `respond_to_decision` rejects any response whose `responder` equals the originating `decision_request.source_agent`. The rejected attempt is recorded as an event.
- EXPLICIT / Tier-3 decisions: `responder` must be the operator via an authenticated human channel (dashboard-user / WebAuthn), not any agent.
- **Consequence — captured deliberately, eyes open:** once this merges, autonomous CC runs can no longer self-satisfy their own gated actions. Every gated action in a future BOM crunch needs a non-requesting responder — in practice, the operator. This is the intended correction to audit finding #1; it changes the autonomous-crunch model on purpose. (It does not affect this BOM's own crunch — Phase 4's change only takes effect once merged; this BOM runs `high`-sensitivity with operator gates per phase regardless.)

## Phase 5 — Non-loopback bind + cross-machine pairing

ONLY after Phases 2-4 have merged — the HARD RULE. Make the daemon usable on a routable interface: `bindHost` set to a LAN address, the `requireAuthWhenNonLocal` auth gate active, the pairing flow working machine-to-machine (Phase 0 recon identifies what v0.7 left incomplete). The daemon, now reachable, has real enforcement in front of it.

## Phase 6 — Verification

`full` window. `npm test` + `npm run build` + `tsc --noEmit` clean. Negative-path enforcement suite: a tool call cannot reach an upstream without passing no-go + master-switch + tier; an EXPLICIT action cannot complete without a WebAuthn assertion; a decision cannot be answered by its requester. Two-machine smoke: a second machine pairs with the daemon and reaches it over the LAN, and its tool calls demonstrably hit the gate.

---

## Sensitivity & cadence

`high`. **Operator approval gate between every phase** — CC stops, dumps the full diff, waits. No continuous run. Rationale: security primitives + the network bind; the cost of a wrong autonomous change here is a reachable daemon with broken enforcement — the exact NO-GO outcome the hard rule exists to prevent.

## PR grouping

- PR 1 — Phase 0 recon doc + Phase 1 mDNS fix.
- PR 2 — Phases 2-3 (no-go/master-switch/tier + Tier-3 WebAuthn).
- PR 3 — Phase 4 (close the self-approval hole).
- PR 4 — Phase 5 (non-loopback bind + pairing).
- PR 5 — Phase 6 (verification) — may fold into PR 4.

Operator reviews and approves each PR before the next phase starts.

## Definition of done

1. Every tool call passes no-go + capability master switch + per-actor tier at the chokepoint — structural, not opt-in.
2. EXPLICIT-tier actions require a valid WebAuthn assertion.
3. A decision cannot be answered by its requesting agent; EXPLICIT decisions require the operator.
4. The daemon binds non-loopback with the auth gate active and a working cross-machine pairing flow.
5. mDNS no longer emits an unhandled error on restart.
6. Full test suite green; negative-path enforcement tests present and asserting denial.
7. The hard rule held: bind-enable shipped only after the enforcement phases merged.

## Run prompt for CC

```
Read CLAUDE.md, then proposed/family-mode-phase-1-bom.md. Execute Phase 0 (recon) ONLY — output proposed/family-mode-phase-1-recon.md and STOP. Wait for operator review before Phase 1.

Sensitivity: high. Operator approval gate between EVERY phase. Full diff dump per phase. This is NOT a continuous run — you stop and wait at every phase boundary.

THE HARD RULE: the daemon must not bind non-loopback (Phase 5) until the enforcement phases (2-4) have merged. If enforcement cannot complete, Phase 5 does not ship — stop with the daemon loopback-only and hand off.

Skärp och hängslen: git status --short + git symbolic-ref HEAD before every mutating git op. One commit per phase, DCO sign-off (-s). Branch feat/family-mode-phase-1 off current main. Verify files >30KB with stat + tail before commit.

Go — Phase 0 only.
```

---

## End of BOM
