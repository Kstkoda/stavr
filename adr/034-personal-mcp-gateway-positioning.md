# ADR-034 — stavR as personal MCP gateway (positioning, scope, non-goals)

**Status:** Proposed
**Date:** 2026-05-16
**Related:** memory `project_stavr_2026_audit_findings.md`, ADR-022 (trust scopes), ADR-031 (observability), ADR-035 (federation)

## Context

The 2026 MCP and agentic AI ecosystem has consolidated around the **MCP gateway** pattern — a layer between AI assistants and the tools they invoke that provides governance, audit, scope enforcement, and registry. Every well-known player (Mint MCP, IBM ContextForge, TrueFoundry, Bifrost, Operant AI, Tyk AI Studio, Arcade, Nango) positions as an **enterprise gateway** — multi-tenant, sub-millisecond latency, SSO, compliance reports, zero-trust.

stavR has been calling itself a "local-first agent broker." On inspection, that framing understates what stavR actually does. It already:
- Brokers MCP traffic between many AI clients and many MCP servers
- Maintains a registry of installed bricks
- Audits every action through the broker's event log (now with retention per ADR-030)
- Enforces trust scopes + no-go list (ADR-022, ADR-018) before any tool dispatch
- Hosts the Helm dashboard the operator uses to govern, observe, and approve
- Exposes Prometheus metrics + OTel traces (ADR-031) for production-grade observability

That's a gateway. The 2026-05-16 strategic audit (memory `project_stavr_2026_audit_findings.md`) surfaced this as Finding #1.

The strategic question: which lane?
1. **Enterprise gateway** — compete with Mint/Bifrost/Operant. Requires multi-tenancy, SSO, compliance. Wrong fit; abandons local-first.
2. **Personal daemon** (status quo) — undersells the features; competitors hear "agent broker" and assume LangGraph/CrewAI clone.
3. **Personal gateway** — empty lane. Single-operator, local-first, MCP-native, governed by the operator.

## Decision

1. **Adopt "personal gateway" as stavR's explicit category.** Public-facing copy leads with this. Internal architecture is unchanged — the positioning is communicative.

2. **Canonical positioning sentence**, to appear in README hero, share card secondary line, NOTICE prior-art section:
   
   > *"stavR is the personal gateway between your AI assistants and your tools — local-first, MCP-native, governed by you."*

3. **Explicit non-goals** so contributors and users know what stavR is NOT:
   - Not a multi-tenant gateway. No tenant isolation, no per-tenant audit segmentation.
   - Not a hosted SaaS. Operator runs it on their own machine; never cloud.
   - Not an SSO target. OAuth to LLM providers (Anthropic, OpenAI) is the only auth complexity.
   - Not a compliance reporter (SOC2 / ISO 27001 / HIPAA). The event log is auditable, but generating compliance-formatted reports is out of scope.
   - Not an enterprise marketplace operator. The MCPs page (v0.4) browses the public github.com/mcp registry; stavR does not host or vet servers.

4. **Explicit goals** so the category is understood positively:
   - Personal gateway for one operator's AI fleet, on their own machines
   - Local-first storage of audit logs, lessons, configuration, credentials
   - MCP-native on both sides (AI clients → stavR → MCP servers)
   - Federation across the operator's own machines (per ADR-035) — not across tenants
   - First-class governance: trust scopes, no-go list, BOM-driven approval, per-profile cost ceilings
   - Production-grade observability built-in (ADR-031): metrics, traces, profiling endpoints

5. **Tessera Protocol overlap stays reframed as interop**, not competition. Tessera defines a wire format for capability tokens; stavR is the gateway that *uses* such tokens. When OAuth 2.1 + Resource Indicators interop lands (ADR-035 scope), if Tessera's tokens become the de facto standard, stavR adopts them as the serialization for its trust scopes.

6. **Visual identity stays exactly as designed.** Iron palette (rust on bone), ᚱ Raido rune, Helm naming — all consistent with "personal" (operator's machine, operator's runestone, operator's command center). No rebrand.

7. **Marketing surfaces to update** (concrete deliverables):
   - `README.md` hero — replace "local-first agent broker" lead with the personal gateway sentence; keep the old phrase as a secondary descriptor for backward-compat searches
   - `proposed/POSITIONING.md` — rewrite to match this ADR (or remove in favor of this ADR being the source of truth)
   - `NOTICE` — extend prior-art section to cite enterprise gateway players (Mint, Bifrost, Operant, etc.) as adjacent-not-competing
   - GitHub repo About sidebar — set to one-sentence description
   - GitHub topics — add `personal-gateway`, `mcp-gateway`
   - Share card SVG — long tagline `LOCAL-FIRST · MCP-NATIVE · YOUR MACHINE` already aligned; add sub-line `the personal gateway` when next regenerated

## Consequences

**Positive:**
- Empty lane gets claimed. "Personal MCP gateway" is unowned in the 2026 market.
- Mental model becomes legible. Users see what stavR does at a glance.
- Explicit non-goals prevent feature creep — when someone proposes "let's add multi-tenancy" the answer is documented.
- ADR-035 federation becomes a coherent extension — personal gateway federates with the operator's own machines, not across tenants.
- Tessera and A2A overlaps both become interop stories rather than competition.

**Negative we accept:**
- Loses the "agent broker" framing. Mitigated by keeping it as a secondary descriptor.
- Invites comparison to enterprise gateways in the wrong lane. Mitigated by explicit non-goals + prominent "personal" qualifier.
- May slow adoption with users who hear "gateway" and assume "enterprise complexity." Mitigated by trivially simple install + operator-facing copy.
- Category name is descriptive, not catchy. Accept this; descriptive is better than clever for a new category.

## Alternatives considered

- **Stay "local-first agent broker"** — undersells; doesn't claim available market.
- **Become an enterprise gateway** — months of work that abandons local-first.
- **"Personal AI operations console"** — emphasizes operator UX but understates MCP-native commitment.
- **"Personal agent runtime"** — analogous to LM Studio but understates the BOM/governance layer.
- **Position around BOM only** — BOM is the plan format; gateway is the category that BOM lives inside.

## Acceptance for moving Status to Accepted

This ADR moves to "Accepted" when:
1. README.md hero updated to the personal gateway sentence
2. `proposed/POSITIONING.md` updated to match (or removed)
3. NOTICE extended with adjacent-players context
4. At least one new public surface (repo About / share card / release notes) uses the new framing

No code changes required for acceptance. This ADR is positional, not structural.
