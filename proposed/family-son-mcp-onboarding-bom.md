# BOM: Family — a son's Claude Code, fully gatewayed through stavR

**Owner:** CC.
**Sensitivity:** mixed — `careful` for pairing / MCP wiring / son-side config; `high` for the chokepoint enforcement change (Phase 1, conditional) and the LLM-gateway credential path (Phase 5).
**Branch:** `feat/family-son-mcp`.
**Base:** `main`.
**Verification window:** a real two-machine smoke (Kenneth's stavR + one son's machine) IS the verification — not CI.
**Estimated scope:** a recon + 6 phases, 3-4 PRs.

---

## Why this BOM exists

Family mode. A son's Claude Code runs on his own machine but is **steered through Kenneth's stavR gateway on two channels**:

- **LLM inference** — the son's CC routes its model calls (`ANTHROPIC_BASE_URL`) to Kenneth's gateway, which holds the real credential (Kenneth's Claude Max), forwards to Anthropic, and meters per son. The hard control: no gateway, no inference.
- **MCP tools** — the son's CC gets its tools from stavR's `/mcp` endpoint; every tool call is 4-tier gated and trust-scoped; tool credentials never leave Kenneth's box.

The son runs **no stavR daemon** and **no spawned CC worker processes** — his CC is interactive and son-driven; he installs Claude Code himself, the normal way.

family-mode-phase-1 is **landed** (verified 2026-05-25): the tool-call chokepoint enforces no-go + Layer-0 master switch + per-actor tier; Tier-3 EXPLICIT requires WebAuthn; the self-approval hole is closed; non-loopback bind is capable behind `requireAuthWhenNonLocal`.

## Decisions locked (do not re-litigate)

- **Two channels are gatewayed — LLM inference + MCP tools. Native/local CC tools are NOT restricted.** Decided by Kenneth 2026-05-25: the son's own Bash / Read / Write / Edit / WebFetch etc. run freely on his own machine — no managed-settings lockdown, no permission fence, no hooks. The gateway governs **Kenneth's resources** (his Claude credit, his brokered tool credentials), not the son's local sandbox. The son's machine is the son's.
- Son = thin client: no son-side stavR daemon, no spawned CC worker processes for him.
- Reachability via a WireGuard mesh Kenneth runs himself (or same-LAN). NOT Tor, NOT Tailscale-the-service.
- Cowork is out of scope — account-bound, not proxyable.
- Tool/provider credentials never leave Kenneth's box. Non-negotiable.

## Open question — resolved in Phase 0

Does the tool-call chokepoint enforce **per-resource trust-scopes**, or only the **per-actor tier**? Memory `stavr-trust-scope-enforcement-gap` (2026-05-23) says tier-only. If tier-only, a connected son can invoke any tool stavR exposes — gated by tier but not sandboxed to a resource set. Phase 0 settles it; Phase 1 is conditional on the answer.

## Phases

**Phase 0 — recon.** Confirm family-mode-phase-1's landed surface. Determine whether per-resource trust-scope enforcement is wired at the chokepoint or only per-actor tier. Inventory what the LLM gateway (Phase 5) builds on — the provider abstractions (`src/steward/providers/anthropic`, `claude-code`, `ollama`), the credential vault, and the metering primitives. Output: `proposed/family-son-mcp-recon.md` + a go/no-go: if per-resource enforcement is missing, Phase 1 is REQUIRED before any son connects.

**Phase 1 — (conditional, `high`) close the trust-scope enforcement gap.** Only if Phase 0 finds it open. Make the chokepoint enforce per-resource trust-scopes, default-deny — a son's grant must bound *what* his actor may call, not just gate it by tier. Operator approval gate; per-phase commit + full diff. If large, spins out as its own `high`-sensitivity BOM.

**Phase 2 — daemon reachability.** Configure Kenneth's daemon: `bindHost` to the WireGuard/LAN address, `requireAuthWhenNonLocal` on. Stand up the WireGuard mesh (Kenneth's stavR host + one son's machine). Confirm from the son's machine: `/healthz` answers; `/mcp` without a token is refused.

**Phase 3 — device pairing.** Exercise `/pair/initiate` + `/pair/complete` machine-to-machine; the son's machine receives a device bearer token. Confirm a non-loopback `/mcp` request with the token is accepted, without it returns 401.

**Phase 4 — MCP tool channel.** Define the son's trust-scope grant — a named individual, default-deny, the specific tools/resources only. On the son's machine, add an MCP-server entry to his Claude Code config pointing at `https://<stavr-wg-addr>/mcp` with the bearer token. His CC now draws brokered, 4-tier-gated tools from stavR.

**Phase 5 — (`high`) LLM inference channel.** Expose an Anthropic-compatible gateway endpoint on stavR: it accepts the son's CC inference calls, authorizes against the son's trust-scope (per-scope metered allowance — unit / cap / refill, per the resource-gateway design), forwards to Anthropic with Kenneth's credential, and meters + logs per son. On the son's machine, set `ANTHROPIC_BASE_URL` (and the gateway auth) so his CC routes all inference through it. Credential-handling code is `high` sensitivity. If the endpoint build is large, it spins out as its own BOM and this phase becomes the son-side wiring + integration only.

**Phase 6 — two-machine smoke.** From the son's Claude Code: an in-scope MCP tool call succeeds and is visibly 4-tier gated; an out-of-scope tool call is denied; an inference call is metered through the gateway and shows in Kenneth's audit log; a Tier-3 action raises a decision that reaches Kenneth (Telegram); the son's **native local tools (Bash, Write, Edit) run normally and unrestricted** — confirming the deliberate non-restriction; tool/provider credentials are confirmed never transmitted to the son's machine.

## Definition of done

1. The son's Claude Code, on his own machine, routes both its MCP tool calls and its LLM inference through Kenneth's stavR.
2. Every tool call passes the 4-tier chokepoint; out-of-scope calls denied; inference metered per son.
3. Tier-3 actions route an approval to Kenneth; nothing irreversible runs without him.
4. The son's native local tools run **unrestricted** — by design, not by omission.
5. No credential and no daemon ever lands on the son's machine; no CC worker processes spawned for him.
6. Verified by a real two-machine smoke, not CI alone.

## Run prompt for CC

```
Read CLAUDE.md, then proposed/family-son-mcp-onboarding-bom.md.

Execute Phase 0 (recon) ONLY, then STOP for operator review. Phase 0's output —
proposed/family-son-mcp-recon.md plus the per-resource-enforcement go/no-go —
determines whether Phase 1 is needed; the operator decides before you proceed.

Sensitivity: careful for Phase 0; Phase 1 (if triggered) and Phase 5 are high —
operator approval gate, full diff per phase. Skärp och hängslen: git status
--short + git symbolic-ref HEAD before every mutating git op. Branch
feat/family-son-mcp off main. Per-phase commits, DCO sign-off (-s).

Go — Phase 0 only.
```

---

## End of BOM
