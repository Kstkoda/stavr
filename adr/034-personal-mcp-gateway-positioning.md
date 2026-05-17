# ADR-034 — stavR as personal MCP gateway (positioning, scope, non-goals)

**Status:** Proposed — **Amended 2026-05-17 (see Amendment §A at bottom)**
**Date:** 2026-05-16 (original) · 2026-05-17 (amendment)
**Related:** memory `project_stavr_2026_audit_findings.md`, memory `project_stavr_team_repositioning_decision.md`, ADR-022 (trust scopes), ADR-031 (observability), ADR-035 (federation), ADR-036 (audit integrity), ADR-037 (operator-data lifecycle), ADR-038 (supply-chain), ADR-039 (polyglot core)

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

---

## Amendment §A — Extend positioning to "personal-or-small-team trusted-AI broker" (2026-05-17)

### Amendment context

The 2026-05-17 strategic audit (memory `project_stavr_team_repositioning_decision.md`) raised the question: does stavR's positioning prevent it from serving the natural next-user, a small team of trusted operators (3–10 people) sharing one stavR instance?

The original ADR-034 says "Not a multi-tenant gateway. No tenant isolation, no per-tenant audit segmentation." That stands. But "small team of trusted operators sharing one instance" is not multi-tenancy — it's still **one operator entity** (the team), where each member has a recognized identity and their actions are individually attributable. This is a meaningful market gap between "solo developer" and "enterprise gateway" that no other 2026 product owns.

### Amended decision

1. **Extend the public-facing category from "personal MCP gateway" to "personal-or-small-team trusted-AI broker."** Public-facing copy primary line stays personal-first (still the largest audience); secondary line adds team mode as a recognized capability.

2. **Updated canonical positioning sentence:**
   
   > *"stavR is the personal — or small-team — gateway between your AI assistants and your tools. Local-first, MCP-native, governed by you."*

   The em-dash phrasing makes team mode legible without diluting the personal-first audience.

3. **Team-mode operating model** (new explicit goals):
   - Up to ~10 operators share a single stavR instance running on a designated machine (the "host") OR each operator runs their own instance federated via ADR-035
   - Each operator has their own Ed25519 keypair (per ADR-036) — actions are individually cryptographically attributable
   - Trust scopes can be granted by any operator with a "grantor" role; revoked by any operator with a "revoker" role; default model is all operators are both
   - Audit log is shared, append-only, signed per-actor (ADR-036) — every operator can verify every other operator's actions
   - No external IDP. Team membership = your keypair is in `~/.stavr/keys/team/*.pub`; addition is a manual file copy or via a future paired-bootstrap flow

4. **Original non-goals stay** (still in force):
   - Not a multi-tenant gateway (no tenant isolation between organizations)
   - Not a hosted SaaS
   - Not an SSO target
   - Not a compliance reporter
   - Not an enterprise marketplace operator

5. **New non-goals** (clarifying team mode):
   - Not a permission system with fine-grained RBAC — team mode assumes all operators are mutually trusted; coarse roles only
   - Not a chat / collaboration tool — operator communication happens out-of-band; stavR provides the audit trail, not the chat
   - Not a multi-org product — team mode is for one organization (or one collective); separate organizations run separate stavR instances

6. **Roadmap implications** (informational; sequenced in the 14-week plan):
   - ADR-036 (audit integrity) becomes baseline because team mode requires cryptographic per-actor attribution
   - ADR-037 (operator-data lifecycle) becomes baseline because team mode loses ALL operators' data on single-machine failure
   - ADR-038 (supply-chain integrity) becomes baseline because the trust circle expands beyond one operator
   - ADR-039 (polyglot core) becomes prioritized because the security primitives matter more when shared
   - ADR-035 (federation via A2A + OAuth 2.1) becomes the primary growth axis — team mode → federated team mode is the natural next step
   - The v0.6 → v0.7 → v0.8 feature pipeline (notifications, Tier 3 EXPLICIT, audit history dashboard) is preserved in priority — all three are team-mode-enabling

### Amendment consequences

**Positive:**
- Opens an unowned market lane (solo-developer-pro / small-team trusted-AI broker) without abandoning personal-first audience
- ADR-035 federation gains a clear product story (sharing across a team's own machines)
- Existing architecture decisions all extend naturally — no rebuild required, just additive ADRs 036-039
- Lex Insculpta + 4-tier approval + trust scopes work identically in team mode

**Negative we accept:**
- Slightly less clean category positioning (the em-dash phrasing is more nuanced than "personal gateway")
- Team-mode features (shared keys directory, per-actor pubkey verification) add a small surface area that personal-only operators don't need
- Marketing must communicate two adjacent stories without diluting either

### Amendment alternatives considered

- **Stay personal-only** — leaves the team market lane to a competitor
- **Reposition entirely to small-team** — abandons the larger personal-developer audience
- **Build separate "stavR" (personal) and "stavR Team" products** — fragments the codebase and the brand; rejected
- **Add multi-tenancy with full RBAC** — what every enterprise gateway does; explicitly out of scope per original non-goals

### Amendment acceptance

The amendment moves Status forward (still "Proposed" overall) when:
1. Public-facing copy updates use the new em-dash phrasing where space allows; original "personal MCP gateway" remains acceptable shorthand
2. ADRs 036-039 land (this amendment is informational; those are load-bearing)
3. At least one team-mode test exists (e.g., two operators sharing keypairs both successfully grant scopes and the audit log shows both)
4. Docs include a "team mode quickstart" section in `docs/team-mode.md`
