# ADR-045 — MCP-server trust model: untrusted-by-default tiering + sandboxing

**Status:** Proposed
**Date:** 2026-05-20
**Related:** ADR-038 (supply-chain integrity — stavR's *own* npm dependencies; this ADR is the MCP-server analogue), ADR-034 (personal MCP gateway positioning), the 4-tier action model, the 5-layer permission model, memory `project_stavr_next_cycle_family_mode_functional`, the 2026-05-20 lethal-trifecta security review.

## Context

stavR brokers MCP traffic *outward* to MCP servers ("connectors" / "bricks") — GitHub, Slack, Ollama, and an open-ended set the operator may add. Each MCP server is third-party code, and it presents two distinct attack surfaces:

1. **Tool outputs are untrusted content.** A GitHub issue body, a fetched web page, a file's contents — anything an MCP tool returns can carry an indirect prompt injection (OWASP LLM01). There is no deterministic fix for prompt injection at the model layer.
2. **Tool *descriptions* are an injection vector too.** The model reads every connected server's tool descriptions before any tool is called. A malicious server can attempt to steer the model purely through description text.

stavR sits at the lethal-trifecta junction by construction — private-data access + untrusted-content exposure + external-communication ability. The 2026 explosion of unverified MCP servers is the new `npm install` attack vector.

ADR-038 addresses supply-chain integrity for stavR's *own npm dependencies* (SBOM, Sigstore, npm provenance — the code stavR is built from). It does **not** address the MCP-server supply chain — the servers stavR connects out to. That is the gap this ADR fills.

Two independent audits on 2026-05-20 (CC's codebase audit, Claude's session audit) found that stavR's permission enforcement is opt-in, not structural: the no-go list, the Layer-1 actor tier, and the Tier-3 friction string are not enforced at the generic tool-invocation chokepoint. A trust model is only as real as its enforcement.

## Decision

Treat every MCP server as **untrusted by default**. Concretely:

1. **Untrusted-by-default tiering.** When a new MCP server is registered, *all* of its tools land at the **EXPLICIT** tier. The operator promotes tools individually — per-tool, with a reason — to CONFIRM or AUTO. There is no "add a server and its tools are immediately AUTO" path. The friction of promoting tools one by one *is* the defense against the npm-install trap; it is deliberate.

2. **Process sandboxing.** Each MCP server runs in its own OS process at least privilege — Node `--permission` (stable since Node 23.5) or equivalent: no filesystem access beyond what it declares, no ambient network beyond its endpoint. A compromised connector cannot reach the operator's disk or the credential vault.

3. **Tool descriptions are untrusted content.** A server's tool descriptions are surfaced to the operator for review at registration time; they are not silently fed to the model as authoritative configuration. Description changes between versions are flagged.

4. **Enforcement at the chokepoint (the load-bearing part).** The per-tool tier MUST be checked at the single generic tool-invocation point, for every tool call, regardless of which server it targets. This is the enforcement gap the two audits found; closing it is a gating sub-phase of the Family-mode cycle Phase 1 (see memory `project_stavr_next_cycle_family_mode_functional`). Without it, this entire ADR is decorative.

5. **Version pinning + provenance (when available).** Pin each connector to a resolved version/hash. Adopt signed MCP manifests once the ecosystem standard solidifies — it is still emerging as of 2026.

## Consequences

**Positive**

- A newly-added MCP server cannot do anything irreversible without an explicit per-tool operator decision — the npm-install attack vector is neutered by construction.
- A compromised connector is contained to its sandbox; it cannot exfiltrate the vault or the operator's files.
- stavR's positioning ("the trust layer for AI tool access") becomes true rather than aspirational.

**Negative we accept**

- Real friction adding a server — promoting tools one by one. This is the point; it is the friction the operator *should* feel.
- Sandboxing adds a per-connector process and a declared-permissions manifest to maintain.

## Open questions

- The signed-MCP-manifest standard is still emerging — track it; do not block on it.
- Sandboxing depth on Windows specifically — Node `--permission` is cross-platform, but filesystem-scoping ergonomics differ. Needs a spike.
- Federation interaction: a federated peer is itself an MCP-traffic source. Does a peer's connector set inherit the local trust model, or does each peer vouch for its own? Defer to the Family-mode cycle.
