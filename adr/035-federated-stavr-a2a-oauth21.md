# ADR-035 — Federated stavR · multi-machine workers via A2A + OAuth 2.1 Resource Indicators

**Status:** Proposed
**Date:** 2026-05-16
**Related:** ADR-006 (loopback), ADR-015 (federation-readiness), ADR-016 (worker worktree isolation), ADR-017 (a2a protocol decision), ADR-022 (trust scopes), ADR-031 (observability), ADR-032 (Steward portability), ADR-033 (stavr-tray), ADR-034 (personal gateway positioning)

## Context

stavR (per ADR-034) is the personal gateway between an operator's AI assistants and their tools. Today it runs on a single machine. Kenneth's actual fleet at 2026-05-16:

- **Primary**: Windows desktop running stavR daemon
- **Two gaming PCs**: each with a discrete GPU
- **Mac**: Apple Silicon, MLX-capable
- **Synology NAS**: always-on, high-disk, no GPU

Kenneth wants to share workloads across these — local LLMs (DeepSeek-R1-Distill 70B, Llama 3.3 70B) hosted on the gaming PCs, Apple-Silicon inference on the Mac (Whisper, vision), embeddings on the Synology, daemon orchestrating from the primary. The canonical "local compute cluster" pattern from the engineering-simulation era (LSF, PBS, SLURM, HTCondor) applied to LLM inference and tool execution.

Three concerns converge into one architectural move:

1. **Multi-machine worker dispatch** — workers spawn on the right machine, not always locally
2. **OAuth 2.1 + Resource Indicators** — the formal MCP authorization standard (audit Finding #3)
3. **A2A v1.0 (April 2026)** — the agent-to-agent protocol (audit Finding #4)

OAuth 2.1 RIs are the credential format. A2A is the wire protocol. Multi-machine workers are the capability that emerges from both. ADR-015 anticipated federation; ADR-017 reserved A2A as a future surface; ADR-032 made Steward model-portable. This ADR is the next step.

## Decision

1. **A new lightweight binary `stavr-spawn`.** Single purpose: host workers on a remote machine. Runs on each non-primary machine. Memory-safe systems language (Rust or Go; defer to implementer). Companion to the daemon and to `stavr-tray` (ADR-033) — purpose-built sentinels with narrow scope.

2. **Asymmetric architecture — primary + spawn nodes.** One primary holds Steward state and authority; spawn nodes hold local execution capacity. Symmetric federation (multiple primaries) is out of scope for v1.0; revisit in v1.1+ for cross-operator pairing (Kenneth's home + colleague's home).

3. **A2A v1.0 wire protocol.** Primary advertises Steward as A2A peer at `/.well-known/agent.json`. Each spawn node advertises its capabilities + free capacity at its own `/.well-known/agent.json`. Discovery via mDNS on LAN (`_stavr-spawn._tcp.local`) plus static config in `~/.stavr/peers.yaml`. Transport: mTLS over Tailscale or LAN.

4. **OAuth 2.1 + Resource Indicators replace the trust-scope wire format.** Trust scopes remain the operator UX (the "ts-a4c1 · 7/10 · 53m left" affordance). Underneath:
   - Primary acts as embedded OAuth 2.1 authorization server
   - Each grant produces a JWT with `iss`, `aud`, `resource` (RFC 8707), `scope`, `exp`, `jti`, and `cnf` confirmation claims (`cost_cap_usd`, `action_count_cap`)
   - Resource Indicator binds token to a specific spawn node (token issued for `gaming-pc-1` cannot be presented at `mac`)
   - JWKS published at `/.well-known/jwks.json`
   - Standard revocation endpoint `POST /oauth/revoke`
   - No-go list (ADR-018, ADR-022) enforced *in addition to* OAuth scope verification — token grants capability class, no-go blocks specific (tool, risk_class, target) regardless

5. **Pairing flow** via one-time code:
   ```
   On primary:    stavr peers invite --machine gaming-pc-1
                  → outputs: Pairing code: ABCD-EFGH-1234 (10 min validity)
   
   On new machine: stavr-spawn pair --primary https://primary.local:7777 --code ABCD-EFGH-1234
                   → generates keypair, sends CSR with code, primary signs cert
   ```
   After pairing, mTLS keypair on each side. Pairing code is single-use, short-lived.

6. **Capability declaration per spawn node** with extensible schema. Yes/no semantics for v1, refined later as fleet diversity grows:
   ```yaml
   node_id: <uuid>
   label: gaming-pc-1
   capabilities:
     has_gpu: true                     # yes/no semantics
     gpu_vram_gb: 24                   # extensible: present when known
     ram_gb: 64
     cpu_cores: 16
     inference_engines:
       ollama: { version: "0.4.2", port: 11434 }
     loaded_models:
       - id: "deepseek-r1-distill-llama-70b-q4"
         vram_used_gb: 22
     available_models:
       - "llama-3.3-70b-q4"
     shared_storage:
       type: "nfs"
       mount: "synology://models/"
   load:
     active_workers: 1
     max_concurrent: 4
   ```
   Steward treats unknown capability fields as opaque hints — older Steward versions still match correctly via yes/no fallback. Forward-compatible schema, present-day simple semantics.

7. **Model Registry** as a new primitive on the primary. Tracks every model available across the fleet:
   ```typescript
   interface ModelEntry {
     id: string;                        // "deepseek-r1-distill-llama-70b-q4"
     capabilities: CapabilityTag[];
     file_path: string;                 // on shared storage (Synology NFS)
     size_gb: number;
     quantization: string;
     requires: { vram_gb?, compute_cap?, accelerator? };
     hosted_on: string[];               // currently loaded
     available_on: string[];            // can be loaded
   }
   ```
   Steward's planner queries the Model Registry by capability + profile to pick the best fit, then issues a scoped token to the chosen node.

8. **Capability-aware dispatch** in Steward's planner:
   - BOM step capability + active profile → candidate models from Model Registry
   - Filter candidate nodes by free capacity
   - Pick best (free_slots × capability_match × proximity); issue scoped token; A2A POST to node's `/dispatch`
   - Spawn node validates token, accepts dispatch, spawns worker, returns worker WebSocket URL
   - Primary records dispatch in event log; **worker stream is point-to-point between primary and spawn node, NOT brokered through the daemon** (per the core-never-jeopardized rule + ADR-031 observability boundary)

9. **Failover.** If dispatched node goes offline mid-task (heartbeat missed 3×):
   - Primary re-dispatches to next-best-fit node; new scoped token issued
   - Original worker's partial work persists in failed node's `~/.stavr-spawn/workers/<id>.log` for forensic
   - Auto-Capture event filed (`type: investigate`)

10. **Primary outage tolerance.** If primary dies (stavr-tray notifies, PM2 restarts per ADR-033 + ADR-031):
    - Spawn nodes keep running workers alive until scope tokens expire
    - Workers persist state locally
    - Primary recovers → spawn nodes re-register → Steward observes still-running workers and decides adopt-or-terminate

11. **Cowork as A2A peer** (decision recorded 2026-05-16). When Anthropic's Cowork adopts A2A, Steward and Cowork's chat-side agent collaborate as A2A peers — distinct from Cowork being an MCP client of stavR. Track as external dependency on Anthropic's Cowork team's A2A timeline.

## Consequences

**Positive:**
- Operator's home compute becomes a real cluster — local LLMs on gaming PCs, Apple-Silicon on Mac, embeddings on Synology, all addressable through the same BOM machinery
- OAuth 2.1 + RIs is the standard wire format — interop with Tessera + any other MCP-aware system
- A2A v1.0 advertises Steward as a peer — Cowork (when ready) and any A2A-aware client collaborate without bespoke integration
- "Core never jeopardized" extends naturally — primary doesn't broker worker stdout across the network; each spawn node owns its workers' streams
- Failover is automatic and bounded
- Asymmetric (one primary + many spawn) avoids the coordination problems of multiple Stewards

**Negative we accept:**
- Adds a binary (`stavr-spawn`) per remote machine. Mitigated by trivially simple pair-by-code UX.
- Adds protocol surface (A2A + OAuth 2.1 + mTLS + capability declarations + heartbeats). Well-understood standards, not bespoke wire formats.
- Failover during a BOM is genuinely hard. Distributed-systems lessons apply. Mitigated by single-point-of-failure semantics for v1.0 (in-flight workers survive primary outage; new dispatches block).
- Trust model is multi-party. Compromising any spawn node compromises whatever scope tokens it holds. Mitigated by short token lifetimes and narrow scopes.
- mDNS discovery is fine on home LAN, unsafe on hostile networks. Mitigated by static-config override and operator documentation.
- Cowork-as-peer depends on Anthropic Cowork's A2A timeline (external).

## Implementation phasing (v0.6 → v1.0)

This ADR is implemented over four version bumps:

- **v0.6** · OAuth 2.1 + Resource Indicators on trust scopes. Refactor token format under existing UX. Single-machine. Validates token model end-to-end.
- **v0.7** · A2A endpoint on primary. Publish `/.well-known/agent.json`. Steward addressable as A2A peer.
- **v0.8** · `stavr-spawn` binary + first remote node. Pairing flow. Capability declarations. End-to-end test of dispatch + scope token + worker stream with one Mac or one gaming PC.
- **v0.9** · Multi-node fleet + Model Registry + capability-aware routing + failover. Full LLM cluster use case.
- **v1.0** · Production release.

Each version is a separate BOM (~8-15h Opus run each). BOM specs:
- `proposed/v0.6-oauth21-trust-scopes-bom.md`
- `proposed/v0.7-a2a-endpoint-bom.md`
- `proposed/v0.8-stavr-spawn-bom.md`
- `proposed/v0.9-fleet-model-registry-bom.md`

(All BOMs need to be re-drafted in current chat with commit-immediately discipline; previous drafts hit the Cowork-virtualized-fs footgun.)

## v1.1+ scope

**Cross-primary federation** (Kenneth's home + colleague's home). Each retains its own Steward, BOM library, lessons. Either can dispatch workers to the other's spawn nodes (with explicit per-job approval initially). Scope tokens carry `iss` claim. Lessons NOT shared by default; explicit opt-in. Use cases: borrow colleague's idle GPU at 2am; share a Unity build farm. Out of scope for v1.0.

## Acceptance for moving Status to Accepted

1. Kenneth signs off on the v0.6 → v1.0 phasing
2. Four phase BOMs drafted in `proposed/` AND committed to git
3. OAuth 2.1 + RI behavior concretely specified (token claims, JWKS shape, revocation flow)
4. A2A endpoint shape concretely specified (capability declaration JSON, dispatch envelope, response shape)
5. Cowork-as-A2A-peer dependency captured as external risk
