# BOM: Family-mode Resource Gateway — LAN MVP

**Owner:** CC
**Sensitivity:** `high` — handles provider credentials (the vault), introduces a new network-facing endpoint that forwards requests under the owner's credential, and meters real spend. Operator approval gate between every phase; full diff dump per phase.
**Verification window:** `full` — credential handling + a new request-forwarding endpoint; the verification phase is not optional.
**Branch:** `feat/family-mode-resource-gateway`
**Base:** `main` (current — includes the v0.8 observability + audit-history work)
**Estimated scope:** 7 phases (0-6), 3-4 PRs, multi-day with operator gates.
**Depends on:** family-mode Phase 1 (`proposed/family-mode-phase-1-bom.md`) for LAN reachability + enforcement. Most of this BOM is buildable and testable loopback-first; only the live-LAN cutover waits on Phase 1 — see "Dependency & build order".

---

## Why this BOM exists

Family-mode's concrete goal (memory `stavr-family-resource-gateway-model`): the work runs under the owner's account, on the owner's resources, and the owner decides per-resource what each peer may use. Kenneth's daemon — and symmetrically any owner's daemon — becomes a **resource gateway**: it holds every provider credential (Ollama, OpenAI, Claude/Anthropic) and exposes them as scoped, metered **resource offers** to peers. The consuming tools run on the peers' own machines; the resource-consuming work routes to the gateway. Provider credentials never leave the owner's box.

This BOM is the LAN MVP: one home network, one group, Sweden/WAN deferred. Immediate target — Kenneth's son, on the home LAN, runs Claude Code against Kenneth's resources without ever holding Kenneth's credentials.

## Settled design decisions (2026-05-21, operator)

Four questions were resolved with the operator before this BOM:

- **Q1 — Quota is per-resource.** One generic primitive: a **metered allowance** = (unit, cap, refill rule, cost function). Each resource is metered in its own natural unit; no cross-resource currency, no money conversion. The owner's pool for a resource is **partitioned per grantee** — each grantee draws only their sub-allowance, never the whole pool; the owner reserves a slice for themselves. This designs out "when it hits 0 everyone dies."
- **Q2 — Exhaustion: graceful pause, then ask, then lossless checkpoint.** At a configurable threshold (operator's stated 98%), the grantee's work **gracefully pauses** — no new requests start, in-flight requests finish. The gateway raises an `await_decision` to the owner for additional resources. If the owner does not respond within the decision window, the work **checkpoints and quits** — no work lost (git worktree + commits persist; the task resumes from the last step). **No automatic fallback** — any redirect to another resource is the owner's decision when they answer.
- **Q3 — Audience: individual or group, never public.** A resource offer's audience is exactly one of: a named individual the owner has a peer link with, or a group the owner is a member of. Nothing is shared unless explicitly offered (default-deny). The word "public" does not exist in the model.
- **Q4 — Precedence: individual quota overrules group.** A grantee has one deterministic quota per resource. An individual grant replaces any group-derived quota for that person; context does not change it. The no-go / safety deny-floor is **core and absolute** — it overrides everything, always; quota resolution is a separate layer and cannot touch it.

## THE HARD RULE (inherited)

The gateway endpoint, once a peer on the LAN uses it, is a non-loopback network surface. Family-mode Phase 1's hard rule governs: **the daemon must not serve the gateway on a non-loopback interface until the permission model is enforced at the tool-invocation chokepoint.** This BOM builds and verifies the gateway **loopback-first**; the live-LAN cutover (Phase 5) ships only after family-mode Phase 1's enforcement phases have merged. A reachable gateway with un-enforced gates is a NO-GO outcome, not an acceptable partial.

## Dependency & build order

Most of this BOM is independent of Phase 1 and buildable now: the offer/allowance primitives, the metering engine, the gateway endpoint, the proxy logic — all testable loopback (a local client → the gateway → a provider). Only **Phase 5 (live-LAN cutover)** depends on Phase 1's non-loopback bind + enforcement. This BOM and family-mode Phase 1 can therefore proceed in parallel and converge at the cutover.

## Reference reading (CC, at Phase 0)

- `CLAUDE.md` — invariants (tests-are-derivative, never-lose-files, status-before-git-op, sensitivity flag, NO-GO handoff).
- The settled decisions above; memory `stavr-family-resource-gateway-model`, `stavr-phase0-federation-substrate-decision`, `stavr-next-cycle-family-mode-functional-2026-05-20`.
- `proposed/family-mode-phase-1-bom.md` — the reachability/enforcement substrate.
- Code: `src/steward/providers/{types,anthropic,claude-code,ollama}.ts`, `src/credentials/{types,vault,store,tools}.ts`, `src/trust/{tools,store,no-go-list}.ts`, `src/transports.ts` (the HTTP server that will host the gateway endpoint), `src/server.ts`, `src/observability/llm-metrics.ts` + `metrics.ts`.

## Don't-touch

- Family-mode Phase 1's files (the bind, the enforcement chokepoint, pairing) — that is Phase 1's BOM; this one consumes the result, it does not reshape it.
- The cross-site / WAN substrate (per-group-hub peering to Sweden) — deferred; this is the single-LAN MVP.
- Cowork integration — see Open Items; it is not in this BOM's scope.

---

## Phase 0 — Recon (output a findings doc, then STOP)

Pin the facts the rest of the BOM depends on — they must not be guessed:

- The provider abstraction in `src/steward/providers/` — the `types.ts` contract, what `anthropic.ts` / `ollama.ts` / `claude-code.ts` expose, and whether a provider can be driven by a request originating outside the Steward.
- The credential vault + grant model — `CredentialRecord`, `CredentialGrantRecord` (`uses_remaining`, `expires_at`, `revoked_at`). Confirm it can hold the owner's Anthropic / OpenAI credentials and whether `credentialUse` can serve them to an internal request-forwarder.
- The HTTP server in `transports.ts` — how a new route is added, how requests are authenticated, whether it can host a non-MCP, Anthropic/OpenAI-shaped endpoint.
- Trust-scopes — how a scope expresses (tool, args, target); whether "target = a group" is already supported or new.
- Existing metering — `observability/llm-metrics.ts` is observability only (Prometheus counters), NOT durable per-grantee accounting. Confirm, so Phase 2 builds the durable side and merely emits into it.
- **Decide the grantee-identification model for the MVP:** direct grantee-token (the son's Claude Code presents a gateway token; simplest) vs daemon-to-daemon peer relay (the fuller federation form). Recommend one, with reasons.

Output `proposed/family-mode-resource-gateway-recon.md`. **Operator reviews before Phase 1 proceeds.**

## Phase 1 — Resource-offer + metered-allowance primitives

The data layer. A `ResourceOffer`: { resource ref, owner, audience (individual | group), allowance template }. A `MeteredAllowance`: { unit, cap, refill rule (one-shot | per-window | free-on-completion), cost-function ref, per-grantee partitions }. Additive persistence (new tables), types, CRUD, and the trust-scope extension so an offer is expressed as a scope. Default-deny: no offer = no access. Q4 precedence (individual replaces group-derived quota) is resolved here. Fully unit-testable, no network.

## Phase 2 — Metering engine

The consume / check / refill logic. Given (grantee, resource, request) → resolve the grantee's partition → run the resource's cost function → check remaining → record consumption. Implement the refill rules (one-shot reset, per-window roll, free-on-completion release). Implement the **98%-of-partition** threshold detection that Phase 3 hooks. Concurrency-safe (two in-flight requests near the edge must not both pass). The durable per-grantee balance is a new store; it also emits into `observability/llm-metrics.ts` so consumption shows on existing metrics/dashboards. Unit-testable.

## Phase 3 — The gateway endpoint(s) + the Q2 exhaustion behavior

The request-forwarding surface, loopback-bound for now:

- An **Anthropic-compatible** endpoint — so a Claude Code with `ANTHROPIC_BASE_URL` set to the gateway routes through it.
- An **OpenAI-compatible** endpoint — covers OpenAI and Ollama, which both speak it.
- Flow: authenticate the grantee → resolve the offer + allowance → metering check (Phase 2) → forward to the real provider with the **owner's** credential from the vault → record consumption → return the response.
- **The Q2 behavior:** at 98% of the grantee's partition, graceful pause — refuse new requests with a clear signal, let in-flight finish — and raise an `await_decision` to the owner. On owner timeout (the existing decision deadline), emit a checkpoint signal so the consuming task writes state and exits cleanly. No automatic fallback.

Loopback end-to-end testable: a local client → gateway → provider.

## Phase 4 — Owner controls + grantee onboarding

The owner-facing surface to create/revoke offers and set partitions/quotas (CLI + the existing trust-scope tooling; a dashboard surface is a follow-up, not here). The grantee-side onboarding: issue a grantee their gateway credential and produce the exact `ANTHROPIC_BASE_URL` / env config their Claude Code needs — per the grantee-identification model decided in Phase 0.

## Phase 5 — Live-LAN cutover (gated on family-mode Phase 1)

ONLY after family-mode Phase 1's enforcement phases have merged and the daemon can bind non-loopback. Serve the gateway on the LAN interface behind Phase 1's auth gate. The son's machine, on the home LAN, points his Claude Code at the gateway and runs real work against Kenneth's resources — metered, partitioned, gated.

## Phase 6 — Verification

`full` window. `npm test` + `npm run build` + `tsc --noEmit` clean. Negative-path suite: a request with no offer is denied; a grantee cannot exceed their partition; one grantee draining their partition does not touch another's or the owner's reserved slice; at 98% the pause + `await_decision` fires; on owner-timeout the checkpoint signal is emitted and no work is lost; the no-go floor still denies a forbidden tool regardless of any offer. Loopback end-to-end: a Claude Code against the gateway consuming an allowance through to exhaustion. Live-LAN smoke (with Phase 1 done): the son's machine over the LAN.

---

## Open items

- **Cowork cannot be proxied.** Cowork is an account-bound desktop app with no `ANTHROPIC_BASE_URL`-equivalent custom-endpoint hook, so the resource-gateway model does not reach it. The son's Cowork running "under the owner's account" would require logging that Cowork into the owner's account directly — credential-sharing, which this model deliberately avoids. **This BOM delivers Claude Code (plus OpenAI/Ollama-compatible clients) only.** Cowork is an unresolved separate question — answer it after verifying Cowork's auth model against current docs.
- **The Claude quota is a budget intention, not a hard guarantee.** A metered allowance on the Claude resource sits on top of Anthropic's shared Max 5-hour pool. The gateway can ration "son A gets X" but cannot stop son B draining the underlying pool first. Ollama and OpenAI allowances are real (the owner's GPU, the owner's key); the Claude one is best-effort unless the gateway also tracks the live Max window.

## Sensitivity & cadence

`high`. Operator approval gate between every phase; full diff dump per phase; no continuous run. Rationale: the gateway forwards requests under the owner's provider credentials and meters real spend — the cost of a wrong autonomous change here is a credential-handling or billing fault.

## PR grouping

- PR 1 — Phase 0 recon doc.
- PR 2 — Phases 1-2 (offer/allowance primitives + metering engine).
- PR 3 — Phases 3-4 (gateway endpoint + Q2 exhaustion behavior + owner controls/onboarding).
- PR 4 — Phases 5-6 (live-LAN cutover + verification) — gated on family-mode Phase 1.

Operator reviews and approves each PR before the next phase starts.

## Definition of done

1. An owner can offer a resource to an individual or a group, with a per-resource metered allowance, partitioned per grantee.
2. A grantee's request is metered against their partition; exceeding it is impossible; one grantee cannot drain another's partition or the owner's reserved slice.
3. At 98% the work gracefully pauses and the owner is asked; on owner-timeout the task checkpoints and quits with no work lost.
4. A grantee's Claude Code, pointed at the gateway, runs real work against the owner's resources — the owner's credential never leaves the owner's machine.
5. The no-go floor still denies forbidden actions regardless of any offer.
6. Full suite green; negative-path tests assert each denial.
7. The hard rule held: the gateway went live on the LAN only after family-mode Phase 1's enforcement merged.

## Run prompt for CC

```
Read CLAUDE.md, then proposed/family-mode-resource-gateway-bom.md. Execute Phase 0 (recon) ONLY — output proposed/family-mode-resource-gateway-recon.md and STOP. Wait for operator review before Phase 1.

Sensitivity: high. Operator approval gate between EVERY phase. Full diff dump per phase. This is NOT a continuous run — you stop and wait at every phase boundary.

THE HARD RULE: the gateway is built and verified loopback-only. The live-LAN cutover (Phase 5) ships only after family-mode Phase 1's enforcement phases have merged. Do not bind the gateway non-loopback before then.

Skärp och hängslen: git status --short + git symbolic-ref HEAD before every mutating git op. One commit per phase, DCO sign-off (-s). Branch feat/family-mode-resource-gateway off current main. Verify files >30KB with stat + tail before commit.

Go — Phase 0 only.
```

---

## End of BOM
