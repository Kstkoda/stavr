# BOM: feat/v0.7-federation-family-mode-foundation

**Owner:** CC (autonomous)
**Sensitivity:** high (security primitive + new network protocol + new authoritative auth path)
**Verification window:** full (90 min — touches transport layer, broker session lifecycle, new persisted state)
**Branch:** `feat/v0.7-federation-family-mode-foundation`
**Base:** `main` (post PR #48 v0.6.11)
**Estimated scope:** 11 phases, ~6-10 hour autonomous run, +3000 LOC across ~30 files

---

## Context — design decisions already locked (read memory before Phase 0)

This BOM implements the v0.7 megacycle. The architectural decisions are ALL locked in memory files. **DO NOT re-litigate**:

- `project_stavr_federation_design_decisions_2026_05_19.md` — 5 decisions (federation roles, discovery, operator auth, Topology viz, worker polymorphism)
- `project_stavr_team_repositioning_decision.md` — family-scale + small-team positioning
- `project_stavr_four_tier_approval_model.md` — Tier 3 EXPLICIT mechanism
- `project_stavr_small_ux_branding_followups.md` — icon advertisement, family-mode doc, About page, NOTICE
- `project_stavr_layer_0_capability_disable.md` — Layer 0 hard gate
- ADR-033 (Governor), ADR-034 (positioning) §B, ADR-042 (federation candidate)

CC reads these at Phase 0 and treats them as ground truth.

## What this BOM ships

**Family-scale infrastructure foundation** — turns stavR from a single-machine personal gateway into a small federation that Kenneth + his 2 sons can run together. Three machines, three Stewards, federated by stavR's peer protocol, with WebAuthn passkey gating Tier 3 (EXPLICIT) operator-only actions.

Anchor scenarios (test in Phase 10):

1. Kenneth (Originator) dispatches a BOM. His Steward executes on his machine. Sons' machines see it via the federation event stream but cannot mutate.
2. Sons dispatch local BOMs. Their Steward is a Participant by default; high-tier actions require Originator (Kenneth's) passkey via cross-machine approval.
3. A peer machine drops off the network. Originator's BOMs queued for that peer either reroute to local or stall with operator notification.

---

## Phases

### Phase 0 — Recon (read-only, ≤45 min)

- Read all memory files listed above
- Read current substrate: `src/transports.ts`, `src/broker.ts`, `src/persistence.ts`, `src/observability/*`, `src/steward/*`, `src/security/*`, `ecosystem.config.cjs`
- Audit single-machine assumptions: anywhere code assumes `localhost` / `127.0.0.1` / "the one process" / unguarded URLs
- Write findings → `proposed/v0_7-federation-findings.md`. Commit + push BEFORE Phase 1.

### Phase 1 — WebAuthn passkey primitive (operator identity)

**Goal:** Operator can register a passkey via `/dashboard/settings#identity` and authenticate it for Tier 3 EXPLICIT actions.

- `src/security/webauthn.ts` — registration (attestation) + authentication (assertion) flows using `@simplewebauthn/server` v13+ (verify latest stable in Phase 0)
- `src/security/identity-store.ts` — persists registered credentials in runestone.db (new table: `operator_credentials`)
- `/api/auth/register` + `/api/auth/verify` endpoints in `src/transports.ts`
- `/dashboard/settings` page gets an "Operator identity" section: list registered credentials, register new, revoke
- Tier 3 EXPLICIT actions in the broker now require a verified passkey assertion within last 60s OR fresh re-auth
- Unit tests + integration tests (mock authenticator via `@simplewebauthn/types`)
- Per-phase commit. Push.

### Phase 2 — Peer discovery (layered: peers.yaml → mDNS → WebRTC)

**Goal:** Peer machines on the same LAN auto-discover each other; operator can configure trusted peers explicitly.

- `src/federation/peers.ts` — load `~/.stavr/peers.yaml`, parse, validate
- `src/federation/mdns.ts` — advertise `_stavr._tcp.local` via bonjour-service; discover others
- `src/federation/webrtc.ts` — establish data channels between peers (signaling via existing daemon HTTP, NAT traversal via STUN — use `wrtc` package, verify in Phase 0)
- `src/federation/peer-registry.ts` — tracks discovered + configured peers, their trust level (`local-equivalent` | `verified` | `untrusted`)
- `/dashboard/family-mode` placeholder page lists discovered peers (Phase 5 fleshes out)
- Per-phase commit. Push.

### Phase 3 — Per-task federation roles

**Goal:** Each BOM carries a role assignment — Originator / Participant / Convener — and the broker enforces per-role permissions.

- `src/types/federation.ts` — `FederationRole` type, `FederationContext` interface
- BOM schema extends with `federation: { originator: peer-id, role: ..., convener?: peer-id }`
- Broker events gain `federation_context` field
- New event kinds: `peer_joined`, `peer_left`, `bom_role_assigned`, `federation_handoff_started`, `federation_handoff_completed`
- Participant role enforcement: a Participant can mirror Originator's events but cannot mutate without explicit grant
- Originator's passkey verification REQUIRED for any cross-peer Tier 3 action — links Phase 1 + Phase 3
- Per-phase commit. Push.

### Phase 4 — Worker spawner protocol (MCP-server-as-worker)

**Goal:** Workers are MCP servers spawned via a generic protocol — replaces the current hardcoded shell/cc worker types per Decision 5 in federation memory.

- `src/workers/spawner-protocol.ts` — defines the contract: spawner config schema, lifecycle (spawn / running / completed / errored / terminated), event reporting
- `src/workers/spawner-mcp.ts` — implementation that spawns an MCP server child process and treats it as a worker
- Existing shell/cc worker types refactored to use the new protocol as adapter (backward compat)
- Per-phase commit. Push.

### Phase 5 — `/dashboard/family-mode` page

**Goal:** Operator surface for managing the federation — peer status, role assignments, trust levels.

- New page in `src/dashboard/pages/family-mode.ts`
- Tabular view of peers: name, machine, trust, connection status (green/amber/red — same convention as Engine chip), current role for active BOMs
- Action buttons (Tier 3 EXPLICIT, passkey-gated): adjust trust, force handoff, revoke peer
- Audit log entries inline per peer
- Per-phase commit. Push.

### Phase 6 — `/dashboard/about` page

**Goal:** Non-developer-facing landing page (audience: Kenneth's sons, 11yo).

- New page `src/dashboard/pages/about.ts`
- Plain-language explanation of what stavR is, what the brain modes mean (Shadow/Cloud/Local per locked Shadow-mode design — NOTE: that's v0.8 work, in v0.7 just reference it as "coming soon")
- Visual: a friendly diagram of the topbar chips with annotations
- Link to family-mode quickstart (Phase 7)
- Per-phase commit. Push.

### Phase 7 — `docs/family-mode.md` quickstart

**Goal:** Written guide for setting up a multi-machine family deployment.

- `docs/family-mode.md` — Setup section (install stavR on each machine), Federation section (configure peers.yaml or rely on mDNS auto-discovery), Identity section (register passkeys per operator), Trust section (mark trusted peers), Trouble section (NAT issues, mDNS firewall, etc.)
- Worked example: 3-machine setup (Kenneth as Originator, 2 sons as Participants)
- Per-phase commit. Push.

### Phase 8 — MCP server icon advertisement (~40 LOC)

**Goal:** Cowork's connector sidebar shows the Raido rune `ᚱ` instead of a generic "S" for stavR.

- `src/server.ts` + `src/transports.ts` — extend `serverInfo` to advertise icon (per MCP SDK 1.x — verify exact field name in Phase 0)
- Embed the Raido rune as base64 SVG OR reference a published URL
- Quick win — small commit. Push.

### Phase 9 — NOTICE attribution review

**Goal:** Make sure all third-party deps + people are properly attributed in the NOTICE file.

- Audit `NOTICE` against new deps added in this BOM (`@simplewebauthn/*`, `bonjour-service`, `wrtc`, etc.)
- Add any missing required attribution clauses
- Per-phase commit. Push.

### Phase 10 — Verification (full window, 90 min minimum)

**Goal:** Verify the anchor scenarios work end-to-end without regression.

- Spin up 2 ephemeral daemon instances on different ports (simulates 2 machines on the same LAN)
- Verify mDNS discovery works between them
- Verify WebRTC handshake completes
- Register passkeys on each instance (use simplewebauthn mock authenticator in test mode)
- Run synthetic BOMs that span peers (Originator on instance A, Participant on instance B)
- Run nav stress + memory check (from v0.6.11 verification protocol — heap should remain stable)
- Confirm no regression on existing v0.6.11 fixes (Plans nav, version chip, memory panel, etc.)
- Confirm `pm2 restart stavr` followed by passkey re-auth works (avoids breaking deployment flow)
- 90-min sustained load with both peers active
- Open PR with full verification artifacts

---

## Constraints (per CLAUDE.md hard invariants)

- Per-phase commits, `git commit -s` (DCO)
- `git status --short` + `git symbolic-ref HEAD` before every git op (rule #8)
- Don't-touch list applies — see CLAUDE.md §3 for current list. NOTE: Phase 1-3 INTENTIONALLY touch `src/persistence.ts` (new `operator_credentials` table) and `src/transports.ts` (new auth endpoints + WebRTC signaling). This is in-scope; operator pre-authorizes those touches as part of this BOM.
- Tests are derivative — delete legacy assertions that conflict
- File writes >30 KB verified with `stat -c %s` + `tail -5`
- NO-GO handoff if blocked

## Don't-touch list for THIS BOM (in addition to CLAUDE.md defaults)

- `src/observability/*` — leak fix verified clean in v0.6.11; don't add new spans without an explicit memory check
- `tmp/perf/*` — CC's load-runner artifacts from v0.6.11; reuse for Phase 10 verification

## Definition of done

1. PR opened against `main`, all CI green
2. Phase 10 verification time-series + screenshots attached to PR description
3. Anchor scenarios documented as passing in PR body
4. Memory leak fix (PR #47) still verified holding under federation load (no regression)
5. `/dashboard/family-mode` and `/dashboard/about` both reachable + functional
6. `docs/family-mode.md` walkthrough complete (operator can follow it from scratch)
7. WebAuthn passkey gates Tier 3 EXPLICIT actions verifiably (test included)
8. MCP server advertises Raido rune icon (verify in Cowork connector sidebar)
9. ntfy notification on PR ready
