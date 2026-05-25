# BOM: Family — onboard a son as a remote MCP client of stavR

**Owner:** CC.
**Sensitivity:** mixed — `careful` for config / pairing / CC-side wiring; `high` for any tool-call-chokepoint enforcement change (Phase 1, conditional).
**Branch:** `feat/family-son-mcp`.
**Base:** `main`.
**Verification window:** a real two-machine smoke (Kenneth's stavR + one son's machine) IS the verification — not CI.
**Estimated scope:** a recon + 5 phases, 2-3 PRs.

---

## Why this BOM exists

Family mode, fast path. The resource-gateway model (memory `stavr-family-resource-gateway-model`) says a son's tools route to Kenneth's daemon. Kenneth's chosen mechanism: the son's **Claude Code becomes a thin remote MCP client** of Kenneth's stavR — his CC points at the daemon's `/mcp` endpoint; stavR brokers and 4-tier-gates every tool call; tool/provider credentials never leave Kenneth's box.

The son runs **no stavR daemon** and **no spawned CC worker processes** — his CC is interactive and son-driven; only its MCP tool calls are brokered. This deliberately sidesteps family-mode-phase-2 (the son-side installer) entirely: the son installs Claude Code himself, the normal way, and adds one MCP-server config entry.

family-mode-phase-1 is **landed** (verified 2026-05-25 — `family-mode-phase-1 Phase 2/3/4/5` tags throughout `src/`): the tool-call chokepoint enforces the no-go list + Layer-0 master switch + per-actor tier; Tier-3 EXPLICIT requires a WebAuthn assertion; the self-approval hole is closed; non-loopback bind is capable behind `requireAuthWhenNonLocal`. The keystone is done — what remains is config, pairing, and one open enforcement question (below).

## Decisions locked (do not re-litigate)

- Son = pure remote MCP client. **No** son-side stavR daemon. **No** spawned CC worker processes for the son.
- Reachability via a **WireGuard mesh Kenneth runs himself** (or same-LAN). NOT Tor, NOT Tailscale-the-service.
- **Cowork is out of scope** — account-bound, no custom-endpoint hook, not proxyable.
- Tool/provider credentials never leave Kenneth's box. Non-negotiable — it is the point of the model.

## Open question — resolved in Phase 0

Does the tool-call chokepoint enforce **per-resource trust-scopes**, or only the **per-actor tier**? Memory `stavr-trust-scope-enforcement-gap` (2026-05-23) says tier-only. If tier-only, a connected son can invoke *any* tool stavR exposes — gated by tier (AUTO / CONFIRM / EXPLICIT) but **not** sandboxed to "GitHub-read and nothing else." Phase 0 settles this against current code; Phase 1 is conditional on the answer.

## Phases

**Phase 0 — recon.** Confirm family-mode-phase-1's landed surface. Determine precisely whether per-resource trust-scope enforcement is wired at the chokepoint or only per-actor tier. Output: `proposed/family-son-mcp-recon.md` + a go/no-go — if per-resource enforcement is missing, Phase 1 is REQUIRED before any son connects; if present, Phase 1 is skipped.

**Phase 1 — (conditional, `high`) close the trust-scope enforcement gap.** Only if Phase 0 finds it open. Make the chokepoint enforce per-resource trust-scopes, default-deny — a son's grant ("GitHub-read; nothing else") must actually bound what his actor can call, not just gate it by tier. Operator approval gate; per-phase commit + full diff. If this proves large, it spins out as its own `high`-sensitivity BOM rather than bloating this one.

**Phase 2 — daemon reachability.** Configure Kenneth's daemon: `bindHost` to the WireGuard/LAN address, `requireAuthWhenNonLocal` on. Stand up the WireGuard mesh (Kenneth's stavR host + one son's machine). Confirm from the son's machine: `/healthz` answers; `/mcp` without a token is refused.

**Phase 3 — device pairing.** Exercise `/pair/initiate` + `/pair/complete` machine-to-machine; the son's machine receives a device bearer token. Confirm a non-loopback `/mcp` request with the token is accepted, and without it returns 401.

**Phase 4 — scope the son + son-side CC config.** Define the son's trust-scope grant — a named individual, default-deny, the specific tools/resources only. On the son's machine, add an MCP-server entry to his Claude Code config pointing at `https://<stavr-wg-addr>/mcp` with the bearer token. (LLM-inference routing via `ANTHROPIC_BASE_URL` is a separate, optional follow-up — out of scope here.)

**Phase 5 — two-machine smoke.** From the son's Claude Code: an in-scope tool call succeeds and is visibly 4-tier gated; a Tier-3 / irreversible call raises a decision that reaches Kenneth (Telegram); an out-of-scope tool call is denied; tool credentials are confirmed never transmitted to the son's machine. The "son works under Kenneth's gate" experience, end to end.

## Definition of done

1. A son's Claude Code, on his own machine, makes tool calls brokered through Kenneth's stavR.
2. Every call passes the 4-tier chokepoint; out-of-scope calls are denied — per-resource enforcement confirmed present (Phase 0) or closed (Phase 1).
3. Tier-3 actions route an approval to Kenneth; nothing irreversible runs without him.
4. No credential and no daemon ever lands on the son's machine; no CC worker processes are spawned for him.
5. Verified by a real two-machine smoke, not CI alone.

## Run prompt for CC

```
Read CLAUDE.md, then proposed/family-son-mcp-onboarding-bom.md.

Execute Phase 0 (recon) ONLY, then STOP for operator review. Phase 0's output —
proposed/family-son-mcp-recon.md plus the per-resource-enforcement go/no-go —
determines whether Phase 1 is needed; the operator decides before you proceed.

Sensitivity: careful for Phase 0; Phase 1 (if triggered) is high — operator
approval gate, full diff per phase. Skärp och hängslen: git status --short +
git symbolic-ref HEAD before every mutating git op. Branch feat/family-son-mcp
off main. Per-phase commits, DCO sign-off (-s).

Go — Phase 0 only.
```

---

## End of BOM
