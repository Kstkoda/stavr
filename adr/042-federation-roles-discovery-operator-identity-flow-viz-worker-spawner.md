# ADR-042 — Federation roles, peer discovery, operator identity, instruction-flow visualization, worker polymorphism

**Status:** Proposed
**Date:** 2026-05-19
**Related:** ADR-034 §B (family-scale infrastructure positioning), ADR-035 (federated stavR via A2A + OAuth 2.1), ADR-036 (audit integrity baseline), ADR-040 (three-process architecture), ADR-041 (universal signal trace), the 5-layer permission model, memory `project_stavr_federation_design_decisions_2026_05_19.md`

## Context

The long-form design session on 2026-05-18/19 produced five interlocking architectural decisions that together define how stavR scales from single-operator personal tool to family-scale infrastructure (per ADR-034 §B). Each decision was reached using the 10-3-1 ideation rule (`memory/feedback_10_3_1_ideation_rule.md`) — brainstorm 10 distinct options, shortlist 3 with rationale, operator picks 1.

This ADR consolidates the five decisions, their cross-decision interactions, and the binding roadmap implications for v0.7-v1.0.

The decisions arose from concrete near-term needs:
- Family deployment (Kenneth + 2 sons, RTX 4080 Super gaming rigs) within months
- Token-sharing federation as the primary multi-machine use case
- Sons as non-developer operators — UX must accommodate 11-year-olds
- Local GPU as first-class capacity tier alongside cloud LLM
- "No lock-ins" + "the future moves rapidly" as operator's stated design values

## Decision

Five locked design decisions, treated as a coherent set:

### Decision 1 — Federation roles: per-task Originator / Participant / Convener

Roles attach to tasks (events), not to machines (installations). Every stavR instance is capability-equivalent — same code, same authority primitives. Per task or per session:

- **Originator** — the instance the operator is talking to. Holds intent, builds BOM, owns the decision log for the task. One per task. Flips when operator switches machines.
- **Participant** — instances contributing capacity (CPU, models, network position, local files) to a task originated elsewhere. Zero-to-many per task.
- **Convener** — instance hosting the federation event log for a multi-peer task. Often the Originator but can differ.

Same instance can be Originator for task A, Participant for task B, Convener for task C — concurrently. No static role config at install time. Maps to ADR-035's A2A peer model.

**Naming:** Originator / Participant / Convener was the longest-form proposal from the 10-3-1 shortlist. Shorter aliases TBD when implementing (could be Org/Part/Conv or single-letter event prefixes).

### Decision 2 — Peer discovery: layered (peers.yaml + mDNS + WebRTC)

Three discovery layers, each doing one thing well:

- **Trust root** — `~/.stavr/peers.yaml` lists known peers with their Ed25519 public keys, signed at pairing time. Discovery without trust is just a list of strangers; this file is the operator's affirmative "I trust this peer." Pairing happens via QR code on first contact, signed invitation URL via the notify fabric, or in-person ceremony for highest trust tier.
- **LAN discovery** — mDNS service type `_stavr._tcp.local` advertises instance presence on the local network. Operator's laptop + desktop find each other on the WiFi without manual configuration.
- **Internet discovery + NAT traversal** — WebRTC-style signaling: a relay server helps peers exchange ICE candidates, direct connection establishes, relay drops out. TURN fallback for peers without holepunching.

DHT-based discovery (Kademlia / BitTorrent-style) considered and rejected: trust story is hard, no demonstrated need at family-scale.

For the family deployment case: mDNS for LAN + WebRTC for internet + 3-5 peers in peers.yaml is sufficient.

### Decision 3 — Operator authentication: phased path

#### v0.7 — Option A (Tiered: channel match + passkey escalation)

Maps directly to the 4-tier action model:

| Tier | Channel match | HMAC cid | Passkey assertion |
|---|---|---|---|
| AUTO | — (scope already approved) | — | — |
| CONFIRM | ✅ | ✅ | — |
| EXPLICIT | ✅ | ✅ | ✅ |
| NO-GO | — (not bypassable via channels) | — | — |

WebAuthn / passkey for EXPLICIT actions. Cross-platform: Apple Passkey, Android Passkey, Yubikey, Windows Hello. ~600 LOC. Operator registers passkey at pairing ceremony at `/dashboard/settings/passkey`. EXPLICIT notification replies redirect to a stavR-hosted WebAuthn prompt with one-shot HMAC-signed cid.

#### v1.0 — Layer Option B on top (Federation-key derivation)

The passkey IS the operator's root identity. Sub-keys derive via BIP32-Ed25519 for per-channel and per-peer signing. Operator identity becomes a first-class noun in the event store — every `decision_response`, `trust_scope_granted`, `peer_paired` carries the operator's Ed25519 signature derived from passkey root. Federation peers verify signatures against operator's root public key without trusting each other's daemons.

Significantly more work (~2500-4000 LOC). DID document format for operator identity (`did:key:z6Mk...` or `did:web:operator.example.com`). Builds on v0.7's pluggable auth chain + OperatorIdentity interface placeholders (see Decision 3 Medium placeholders below).

#### Option C (mTLS device-bound) — deferred indefinitely

Decided NOT to ship Option C natively. Reverse-proxy compatibility (operator can put Caddy/nginx in front of stavR for mTLS termination) is the escape hatch. Re-evaluate only if:
- Enterprise customer specifically requests mTLS, OR
- Operator deploys stavR on a network where local-loopback can't be trusted, OR
- Compliance audit (SOC 2, ISO 27001) requires transport-layer device proof

**Medium placeholders to ship in v0.7 to leave the door open:**
- Pure doc-only — this ADR documents Option C deferred + trigger conditions
- Schema fields — every auth-relevant event gets `operator_id` + nullable `device_id` + `trust_source` enum
- Pluggable auth-chain middleware — auth as a chain of validators (channel, hmac, passkey today; mtls slot reserved)
- `OperatorIdentity` interface abstraction — passkey is one impl; cert-bound is a future impl; both behind same interface
- Reverse-proxy compatibility — verify daemon plays nicely behind external mTLS-terminating nginx/caddy (respect X-Forwarded-For, no host header assumptions)

The pluggable auth chain + OperatorIdentity abstraction are also needed for Option B v1.0 (federation-key derivation), so they are paid-forward not paid-twice.

### Decision 4 — Topology instruction-flow visualization

Three complementary layers on the Topology constellation, all sharing the existing `source_agent` event field as the data source.

#### Noun layer — Source nodes as first-class actors

Operator + CC + Cowork-Claude + each remote stavR peer appear as **first-class actor-nodes** on the topology, distinct from stavR-internal nodes (MCPs / workers / DB). When operator is typing in Cowork, the "operator (cowork)" actor-node lights up; when a remote peer sends instructions, the "peer-<name>" actor-node lights up. Maps directly to Decision 1 — every entity that issues instructions is a peer-node on the graph.

Color palette per actor class:
- Operator: rust (matches the iron palette accent)
- CC: blue (matches CC's nature as an external client)
- Cowork-Claude: teal (matches the steward family)
- Remote stavR peer: cyan
- switch-default (fallback): neutral

#### Verb layer — Colored + iconified particles

Instructions flow as particles along edges between actor-nodes and stavR-internals. Color = source class. Icon embedded in particle = specific source identity (person for operator, bot for CC, chat-bubble for Cowork-Claude, globe for remote peer, clock for switch-default).

Performance: cap concurrent particles at 200; older ones evict FIFO. Use `requestAnimationFrame` not `setInterval`. CSS-animated transforms, not JS-positioned per frame.

#### Drill-down layer — Click-inspector

Click any particle → side inspector shows source_agent + signed-by (Decision 3 Option A passkey when v0.7 lands) + correlation_id + payload + arrival timestamp + cross-link to corresponding event in event store.

### Decision 5 — Worker polymorphism: MCP-server-as-worker via "spawner protocol"

Workers are not a fixed enumeration of built-in types, nor are they plugins loaded via a stavR-proprietary mechanism. Instead, **every worker type is itself an MCP server** implementing a small "worker spawner protocol":

Required MCP tools any worker-type server must implement:
- `worker_init(prompt, context, budget)` → returns worker session id + capabilities
- `worker_step(session_id)` → returns one step of progress (could be a tool call, status update, or completion)
- `worker_finalize(session_id, reason)` → cleanup

Optional MCP tools for richer behavior:
- `worker_pause(session_id)` / `worker_resume(session_id)`
- `worker_inject(session_id, instruction)` — operator directives mid-flight
- `worker_inspect(session_id)` → current state for the Topology inspector

stavR's spawner is the orchestrator. Calls the worker's MCP tools per the BOM. Watches events. Routes results back to Steward / BOM next-step.

Built-in worker types (cc, openai-codex, python, pwsh, bash, sql) ship as MCP servers in `src/workers/<type>/mcp-server.ts`. They follow the same spawner protocol as any third-party worker. **External workflow tools** (n8n, Temporal, Airflow, LangGraph) integrate via their own MCP server — same model as worker types. No special plugin path for them.

**Why this is strictly better than a stavR-proprietary plugin architecture:**

- Leverages a standard you already pay the cost of (MCP). No competing "stavR plugin standard" to define and maintain.
- Multi-language polyglot for free: Python (most popular for LLM dev), TypeScript, Go, Rust, .NET — pick what fits the task.
- Lock-in resistant by construction: MCP is governed by an open consortium (Anthropic / Microsoft / OpenAI co-signed spec 2025). Not a stavR-proprietary protocol.
- Family federation works naturally: son's local Ollama runs as a worker MCP server on his 4080 Super; his stavR registers it as a worker backend; when Ollama can't handle the task, his stavR routes via federation (Decision 1+2) to dad's stavR, which uses dad's Claude account with quota scopes (Decision 3 + the 5-layer permission model).
- Audit: every worker action goes through MCP calls, already logged in stavR's event store. No new audit surface for plugin actions vs native actions — they're the same.
- Discovery: same way stavR already finds MCP servers (manifest, registry, runtime discovery). No new "plugin discovery" system.

**Capability typing** (every worker advertises its capabilities via the MCP `tools/list` and `resources/list` calls) is the natural v1.0+ destination. The MCP-server-as-worker decision makes the path to capability-typed routing trivial — it's a thin scheduler layer on top, not a separate refactor.

## Cross-decision interactions

- **Decision 1 + Decision 4** — actor nodes on Topology are how the operator visually sees the Originator/Participant/Convener model in action. The roles are nouns on events; the actor nodes are how those nouns render. With family federation, the actor nodes include "son's stavR (peer)" — the same particle stream that flows between operator and CC also flows between dad's stavR and sons' stavRs.
- **Decision 1 + Decision 5** — federation roles attach to events; worker MCP servers emit events with role attribution. Worker spawner protocol must include a `role` parameter so the spawned worker tags its events correctly (originator/participant/convener).
- **Decision 2 + Decision 3** — peer pairing (Decision 2's QR / invitation handshake) is where the operator's passkey root key signs the peer's public key. Pairing is the trust-bootstrap; passkey is the trust-root. Family-pairing ceremony: dad pairs his stavR with each son's stavR using QR code; passkey signs son's stavR identity.
- **Decision 3 v0.7 → v1.0** — the Option A passkey-store is the literal root from which Option B's BIP32-Ed25519 sub-keys derive. Same hardware key, more derivation depth.
- **Decision 4 + Decision 3** — when a particle's source is "operator," the inspector shows the operator's passkey signature on the underlying event (Decision 3 Option A makes this real). Forensic-quality audit comes for free once the auth layer is in place.
- **Decision 5 + Decision 1** — workers as MCP servers federate naturally. Son's local Ollama worker MCP server is just an MCP server; dad's stavR could (with explicit federation grant) call it as a worker too. Cross-family capability sharing without any new abstraction.

## Consequences

**Positive:**
- Five interlocking decisions form a coherent architecture for family-scale stavR deployment per ADR-034 §B
- Federation roles, discovery, operator identity, observability, and worker polymorphism all reuse a single standard (MCP) rather than inventing parallel abstractions
- Sons' deployment case validates the federation architecture before it has to serve abstract team scenarios
- Lock-in resistance is structural: every decision leans on open standards (MCP, WebAuthn, Ed25519, mDNS, WebRTC, DID)
- Operator identity becomes a first-class concept across operator-replies, peer-pairing, signed events — single primitive across the system (v1.0)
- Topology visualization makes federation traffic forensically auditable in real time

**Negative we accept:**
- Five decisions land in v0.7 (Decisions 1, 2, 3-A, 4, 5) — substantial coordinated work, likely 3 PRs minimum per the suggested split (worker spawner protocol / federation / passkey + Topology viz)
- BIP32-Ed25519 hierarchical key derivation (Decision 3 v1.0 Option B) is niche territory; sourcing or building this is non-trivial
- Family-mode UX simplifications (Decision 4 actor-nodes, simplified language for non-developer operators per ADR-034 §B) add surface area that solo-developer operators don't need

## Alternatives considered

For each decision, 10 alternatives were brainstormed and 3 shortlisted per the 10-3-1 rule. Full alternatives are documented in `memory/project_stavr_federation_design_decisions_2026_05_19.md`. Notable rejected options:

- Decision 1: static binary roles per install (rigid, no failover), Raft-style failover (overkill for personal/family), capability-based with no roles (too abstract for current needs)
- Decision 2: DHT discovery (Kademlia, IPFS-style — trust story too hard), centralized registry (defeats local-first), Tailscale mesh VPN (dependency on Tailscale's coordinator)
- Decision 3: TOTP only (weaker than passkey, harder UX), blockchain wallet signature (over-engineered, niche audience), out-of-band phone-call confirmation (synchronous, fragile)
- Decision 4: floating text labels per particle (dies at scale), source-segregated lanes (breaks constellation aesthetic — too Sankey), 3D depth by source (visual gimmick, doesn't add information)
- Decision 5: code-fork extensibility (no runtime addition), Docker container workers (hostile to family-tool framing), WebAssembly modules (ecosystem still maturing), full plugin architecture with manifest + sandboxing + signing (overkill for current N, MCP-server pattern is strictly better)

## Roadmap implications

Per the binding roadmap, the five decisions ship in v0.7 in this order (likely 3 PRs):

- **PR α — Decision 5 (worker spawner protocol + MCP-server worker types)** — foundation. Refactor cc.ts as MCP server implementing spawner protocol. New worker types: openai-codex, python, pwsh, bash, sql each as MCP servers.
- **PR β — Decisions 1 + 2 (federation roles + peer discovery)** — enables family deployment. Per-task Originator/Participant/Convener; peers.yaml + mDNS + WebRTC signaling.
- **PR γ — Decisions 3 v0.7 + 4 (passkey + Topology visualization)** — operator surface. Tiered auth with passkey for EXPLICIT; Topology actor-nodes + flow particles + click-inspector.

**v1.0 candidate** — Decision 3 v1.0 Option B (federation-key derivation, BIP32-Ed25519 sub-keys layered on Option A passkey root).

**v1.5+ candidate** — capability-typed worker routing as a thin scheduler layer on top of Decision 5's MCP-server-as-worker model.

## Acceptance for moving Status to Accepted

This ADR moves to "Accepted" when:

1. PR α (Decision 5 worker spawner protocol) ships and the existing cc worker is refactored as an MCP server implementing the protocol
2. PR β (Decisions 1+2 federation roles + discovery) ships and peers.yaml + mDNS + WebRTC signaling are functional
3. PR γ (Decisions 3 v0.7 + 4) ships — passkey for EXPLICIT works end-to-end; Topology shows actor-nodes + particles + click-inspector
4. At least one family-mode federated test exists: dad's stavR and one son's stavR exchange a federated trust scope, son's stavR consumes parent's Claude tokens within the scope, the originating instance verifies the consuming instance's actions via the operator's passkey signature, and the Topology view on dad's stavR renders a particle representing son's federated request

## Critical-audit cycle note

This ADR's Decision 5 was reshaped by an explicit operator request to "challenge and audit my thinking critically" mid-conversation. The original 10-3-1 produced two candidate paths (hybrid LLM+code worker types, or plugin architecture); operator initially picked the more ambitious plugin path. Cowork-Claude critically audited that choice — argued YAGNI + plugin ecosystems need N>>1 + attack surface concerns. Operator then revealed the family-deployment context (which had been implicit until that point), which invalidated the YAGNI premise. Re-thinking produced Decision 5's MCP-server-as-worker option, which wasn't in the original 10 alternatives but emerged from the back-and-forth.

The pattern (challenge → context reveal → new option emerges) is worth preserving for future design questions and is documented in `memory/feedback_10_3_1_ideation_rule.md`. The 10-3-1 rule didn't produce the right answer on the first pass; the critique cycle did.

---

**Author:** Kenneth Stenlund (operator, picks) + Cowork-Claude (ideation, audit, drafting)
**Session record:** memory `project_stavr_federation_design_decisions_2026_05_19.md`
