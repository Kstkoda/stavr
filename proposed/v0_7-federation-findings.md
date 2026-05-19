# v0.7 federation + family-mode foundation — Phase 0 findings

**Branch:** `feat/v0.7-federation-family-mode-foundation`
**Base:** `main` @ `1fe0c54` (post PR #49 — v0.7 BOM landed)
**Date:** 2026-05-19
**Author:** CC (autonomous dispatch — operator: Kenneth)
**Sensitivity:** high
**Status:** Phase 0 complete. **HOLD before Phase 1** — operator approval required on three load-bearing items below.

---

## TL;DR

Phase 0 recon surfaced three items that the operator needs to confirm before I burn ~6–10 hours of autonomous work on a path that may be wrong. The architectural decisions ARE locked (in ADR-042, not the memory files the BOM cited — those don't exist, but the substance is identical). The blockers are about scope, dependency choices, and a contradiction between two queued v0.7 BOMs.

Per CLAUDE.md §9 (sensitivity high → operator approval gate between phases) and §7 (NO-GO handoff = clean transfer with concrete next steps), this is the natural pause. I have not touched code outside this findings doc.

---

## A. Decision substrate — RESOLVED

The BOM Context section lists five memory files as "locked design decisions, DO NOT re-litigate":

```
project_stavr_federation_design_decisions_2026_05_19.md
project_stavr_team_repositioning_decision.md
project_stavr_four_tier_approval_model.md
project_stavr_small_ux_branding_followups.md
project_stavr_layer_0_capability_disable.md
```

**None of these exist** in `C:/Users/stenl/.claude/projects/C--dev-cowire/memory/`. The memory dir contains: MEMORY.md, cc-mega-brief.md, cowire-test-patterns.md, cowire-windows-ci-gotchas.md, overnight-run-2026-05-17.md, v065-governor-mvp-branch.md.

**Mitigation:** ADR-042 (`adr/042-federation-roles-discovery-operator-identity-flow-viz-worker-spawner.md`) inlines all five decisions in full detail. I am treating ADR-042 as the canonical source. Cross-reference:

| Decision | Source of truth |
|---|---|
| 1 — Per-task Originator/Participant/Convener roles | ADR-042 §Decision 1 |
| 2 — Layered discovery (peers.yaml + mDNS + WebRTC) | ADR-042 §Decision 2 |
| 3 — Phased auth (v0.7 passkey, v1.0 federation-key derivation) | ADR-042 §Decision 3 |
| 4 — Topology instruction-flow viz (actor nodes + particles + click-inspector) | ADR-042 §Decision 4 — *out of scope for this BOM; in PR γ per ADR-042 roadmap* |
| 5 — Worker polymorphism (MCP-server-as-worker spawner protocol) | ADR-042 §Decision 5 |

The other three memory files (team repositioning, four-tier model, small UX followups, layer-0 disable) are referenced for context. The substance of "four-tier model" is already in `src/tools/categories.ts::TIERS` (AUTO/CONFIRM/EXPLICIT/NO_GO) — see §F below.

**Action required from operator:** confirm that ADR-042 is the canonical substitute for the missing memory files, OR write the memory files first, OR redirect.

---

## B. Tier 3 EXPLICIT mechanism — CONTRADICTION between v0.7 BOMs

Two queued v0.7 BOMs implement the **same** EXPLICIT tier with **different** mechanisms:

| BOM | EXPLICIT mechanism | Lineage |
|---|---|---|
| `v0_7-tier-3-explicit-consent-bom.md` | **Typed friction string** ("type the branch name to confirm") | Pre-ADR-042; aligned with `src/security/actor-permissions.ts` doc + `src/tools/categories.ts` comments + `src/security/policies.ts` |
| `v0_7-federation-family-mode-bom.md` Phase 1 (this run) | **WebAuthn passkey assertion** (within 60s of action) | ADR-042 Decision 3 v0.7, dated 2026-05-19 |

These are not additive — they are alternative gates for the same tier. The codebase currently *documents* EXPLICIT as friction string (see `src/tools/categories.ts:44` and `src/security/actor-permissions.ts:12`) but does **not yet wire the enforcement** in the request path. Either mechanism would be a first-time wiring; choosing passkey changes the documented contract.

ADR-042 (newer; 2026-05-19) supersedes the documentation by intent. The tier-3-explicit-consent BOM (in `proposed/`) was authored before ADR-042 was drafted.

**Action required from operator:** confirm one of:

1. **Passkey wins (ADR-042 path)**: tier-3-explicit-consent BOM is retired; this BOM Phase 1 stands. I will update `src/tools/categories.ts` + `src/security/actor-permissions.ts` doc comments in Phase 1 to reflect passkey instead of friction string.
2. **Friction string wins (tier-3-explicit BOM path)**: Phase 1 of this BOM is retired; do the federation work without changing the EXPLICIT gate. Passkey deferred or scoped to "federation peer EXPLICIT only" (peers verify each other's actions via operator's passkey, but local EXPLICIT still uses friction).
3. **Both layered**: typed friction string + passkey assertion required for EXPLICIT (double-friction). ~1.4x effort of option 1.

My recommendation: **option 1 (passkey wins)**. Friction-string typing is in many ways weaker than passkey for a 4080-Super-rig family deployment where Windows Hello is already installed on all three machines, and passkey is the natural identity root for the v1.0 federation-key derivation Decision 3 plans to layer on. The Lex Insculpta "operator feels the weight" intent is preserved by passkey's biometric/PIN re-auth on every EXPLICIT action.

But this is the operator's call — it changes documented behavior.

---

## C. Bundling vs ADR-042's 3-PR roadmap

ADR-042 §Roadmap implications explicitly states:

> Per the binding roadmap, the five decisions ship in v0.7 in **3 PRs**:
> - PR α — Decision 5 (worker spawner protocol)
> - PR β — Decisions 1 + 2 (federation roles + peer discovery)
> - PR γ — Decisions 3 v0.7 + 4 (passkey + Topology visualization)

The federation BOM bundles α (Phase 4 worker spawner) + β (Phases 2–3) + part of γ (Phase 1 passkey, no Topology viz) + Phases 5–9 (family-mode page, about page, docs, icon, NOTICE) into **one** PR. That is ~4 PRs of ADR-042's roadmap rolled together.

The `v065-governor-mvp-branch.md` memory I have on file documents the "bundled-hotfix incident lesson" — when too much scope lands in one PR the failure mode is one phase regressing and forcing a multi-phase rollback.

**Action required from operator:** confirm one of:

1. **Honor ADR-042 split**: this BOM becomes 3 sequential PRs (α / β / γ). Phase numbering this BOM uses gets renumbered. Adds ceremony but matches the binding roadmap.
2. **Bundle as BOM specifies**: one PR for all of v0.7-federation-family-mode-foundation. Operator explicitly overrides the ADR-042 roadmap recommendation. Document why in PR body.
3. **Partial split**: PR α (workers spawner protocol) goes first because it's the foundation; PR β + γ + family-mode bundle together because they all light up the federation surface together.

My recommendation: **option 3 (partial split — workers first, then federation+family-mode bundle)**. The worker spawner protocol (Phase 4) is the highest-blast-radius refactor because it changes how every existing worker type is invoked. Isolating it as its own PR lets us verify backward compat for cc / shell / unity / av-detector workers BEFORE layering federation on top. The remaining phases (1, 2, 3, 5–9) ship together as the federation foundation.

---

## D. `wrtc` is dead — Windows + Node 24 incompatibility

The BOM Phase 2 names the `wrtc` npm package explicitly. On verification:

| Package | Latest | Notes |
|---|---|---|
| `wrtc` (BOM-named) | 0.4.7 (Jan 2021, 5 years old) | Project archived. No Node 18+ binaries. Native build requires Python 2.7 + ancient toolchain. Last working Node = 14. |
| `@roamhq/wrtc` | 0.10.0 | Community fork; closer to current Node; prebuilt binaries for darwin/linux, less complete for win32. |
| `node-datachannel` | 0.32.3 | Actively maintained; built on libdatachannel (C++); CMake build on first install on Windows. Different API from wrtc but more reliable. |
| `werift` | (pure JS WebRTC) | No native build; ~10x slower; viable for signaling-only flows but not throughput. |

`wrtc` will NOT install on `node v24.14.1` (current). This is a hard blocker for Phase 2 unless the package choice is changed.

**Action required from operator:** confirm one of:

1. **`node-datachannel`** (recommended). Most actively maintained. Requires CMake on Windows (`choco install cmake` or VS Build Tools — likely already present given other native deps). Add to NOTICE as MPL-2.0.
2. **`@roamhq/wrtc`** — closer-drop-in for the BOM's wrtc API but Windows prebuilt story is weaker; may also require native build on first install.
3. **`werift`** (pure JS) — no native dep risk, sufficient for family-scale signaling, easier to ship. Latency penalty acceptable for "operator + 2 sons" load.
4. **Defer Phase 2 WebRTC**, ship mDNS + peers.yaml only in this PR. WebRTC NAT traversal becomes a follow-up. Reduces the BOM to LAN-only federation for v0.7 (which still covers the family deployment — they're all on the same LAN).

My recommendation: **option 4 (defer WebRTC, ship mDNS + peers.yaml)** for this PR, then **option 1 (`node-datachannel`)** for the WebRTC follow-up. Family deployment is LAN-only by definition (3 gaming rigs in the same house). Internet-side WebRTC NAT traversal can wait until there's a real cross-internet peer scenario. This also de-risks Phase 10 verification — no native-dep flake on Windows.

---

## E. Substrate audit — single-machine assumptions

I read transports.ts (2337 LOC), broker.ts (200 LOC), persistence.ts (1872 LOC), security/*, steward/*, observability/*, pairing.ts, ecosystem.config.cjs.

**Single-machine assumptions found:**

1. `src/transports.ts:67` — HTTP host defaults to `127.0.0.1` (loopback). Federation will require either binding to LAN interface OR running a per-peer relay through the existing daemon. Need a `peers_bind` config separate from `bind_host` so the operator can keep MCP loopback-only while federation listens on LAN.
2. `src/pairing.ts` — Spec 52 A2 pairing is **device-to-daemon** (operator's other machines pair to one daemon). This is conceptually different from peer-to-peer **daemon-to-daemon** pairing the federation needs. They should NOT share schema. Peer pairing is a new `peers` table, separate from `devices`.
3. `src/credentials/store.ts` + `src/credentials/vault.ts` — operator-only credential storage. No notion of "peer credentials" (per-peer signing keys for the federation event log). Add `peer_credentials` table separate from `operator_credentials` (Phase 1 passkey table) — three distinct identity tables avoids confusion.
4. `src/broker.ts:158-170` — broker fanout is in-process only. Federation event-mirroring across peers needs a new path that does NOT bypass the existing tap+subscriber chain; peer events arrive as if `publish()`'d but with `federation_context.origin_peer` set. Need a `publishFromPeer()` entry point that skips re-emission to peers (loop prevention).
5. `src/observability/metrics.ts` — Prom metrics labels do not include peer dimension. Adding peer labels late will spike cardinality. Plan: add `peer_id` label on all federation-related metrics from day one; existing single-machine metrics keep no peer label.
6. `ecosystem.config.cjs` — single daemon + steward subprocess. No second daemon process. Phase 10's "two daemons on different ports" needs a `start-peer.sh` or a new ecosystem profile, NOT `pm2 restart`.

**Not-single-machine-relevant but worth noting:**

7. `src/security/policies.ts:65` — `host_exec: 'EXPLICIT'` is hard-coded in the conservative profile. The Phase 1 passkey gate would intercept here. No further changes needed to policies.ts in Phase 1 (the gate sits between `respond_to_decision` and execution, not in the policy resolution).
8. `src/dashboard/pages/settings.ts` exists; Phase 1's "Operator identity" section is a new tab/section, not a new page.

---

## F. Existing tier model — already partially in place

`src/tools/categories.ts:48`: `export const TIERS = ['AUTO', 'CONFIRM', 'EXPLICIT', 'NO_GO'] as const;`
`src/security/actor-permissions.ts`: per-(actor, tool) tier override matrix, persisted in `actor_permissions` table (already in schema).
`src/security/policies.ts`: named policy presets (tight / standard / review-only) with per-tool tier defaults.
`src/security/policies-yaml.ts`: YAML import/export of the per-actor tier matrix.

What's **missing** (what Phase 1 wires):

- Request-path enforcement that distinguishes EXPLICIT from CONFIRM. Right now both go through `respond_to_decision` with no friction step.
- The Operator identity primitive (passkey OR friction string, per Item B).
- The `operator_credentials` table for passkey storage.
- The `webauthn_assertions` table for "last 60s assertion" tracking.
- Dashboard UI for the friction step (modal OR passkey re-auth prompt).

Good news: the Tier enum is already universal across the codebase, so adding enforcement is purely additive — no callsite refactor required.

---

## G. Phase 10 feasibility

Phase 10 prescribes:
- 2 ephemeral daemon instances on different ports
- mDNS discovery verification (requires multicast on the local interface)
- WebRTC handshake (depends on Item D)
- Cross-peer BOMs (Originator on instance A, Participant on instance B)
- v0.6.11 regression check (nav stress, memory leak)
- 90-min sustained load with both peers active
- pm2 restart + passkey re-auth flow

**Feasibility concerns:**

1. **90-min sustained load is wall-clock real time.** Cannot be parallelized into a single autonomous turn. It is a separate operator-supervised step (start the load, wait 90 min, check artifacts).
2. **mDNS on a single Windows host with two daemon processes** — bonjour-service binds to all interfaces by default; two listeners on the same `_stavr._tcp.local` service type may collide or both advertise. Need to verify whether bonjour-service supports `interface` filter or whether we need to run one daemon in a Hyper-V container or WSL.
3. **WebRTC peer-to-peer on same host** — same NAT box on both sides; STUN doesn't help; works in practice but needs explicit `host` candidate prioritization.
4. **The "2 daemons on different ports" pattern** is not in any existing scripts. I will need to write a `tmp/perf/spin-peer.sh` (or .ps1) to start instance B on port 7778 with a separate `~/.stavr-peer/` home dir.

**Action required from operator:** acknowledge that Phase 10 will be split into:
- Phase 10a (autonomous): write spin-peer scripts, verify mDNS + WebRTC handshake works in a 5-min smoke test, prepare verification artifacts.
- Phase 10b (operator-supervised): kick off the 90-min sustained load, monitor heap, capture artifacts, attach to PR.

---

## H. Scope of work — quantified

Reading the substrate, here's my honest estimate of the BOM as-written:

| Phase | LOC est | Files | Wall-clock |
|---|---|---|---|
| 1 — Passkey | 700 | 6 src + 6 test | 2.5–3.5h |
| 2 — Discovery | 900 | 5 src + 5 test | 3–5h (heavy on WebRTC pivot) |
| 3 — Roles | 500 | 4 src + 4 test | 2–3h |
| 4 — Spawner protocol | 600 | 5 src + 5 test | 3–4h |
| 5 — Family-mode page | 400 | 3 src + 2 test | 1.5–2h |
| 6 — About page | 200 | 1 src + 1 test | 1h |
| 7 — Docs | 300 LOC of markdown | 1 file | 1–1.5h |
| 8 — Icon | 40 | 2 src + 1 test | 0.5h |
| 9 — NOTICE | 50 LOC | 1 file | 0.5h |
| 10 — Verification | 200 LOC scripts + 90 min wait | 2 scripts + artifacts | 1h prep + 90min wait |
| **Total** | **~3900** | **~30 src + ~24 test + 4 docs** | **~16-21h** |

The BOM's "6–10 hour" estimate appears to assume a fast happy path with no rework. My estimate (16–21h) accounts for: WebAuthn integration tests with mock authenticator, mDNS firewall debugging on Windows, broker event-kind expansion cascading into existing event handler tests, and the documented "don't lose files >30KB" verification overhead.

**This is the largest single BOM in `proposed/` history.** Worth reflecting on whether it should be one PR.

---

## I. Recommendation summary

Recommended path forward (operator decides):

1. **Confirm ADR-042 substitutes for missing memory files** ✓ if so, proceed.
2. **Pick Tier 3 EXPLICIT mechanism**: my rec — passkey (option B.1).
3. **Pick PR split**: my rec — partial split (option C.3). Phase 4 ships first as its own PR.
4. **Pick WebRTC package**: my rec — defer WebRTC, ship mDNS + peers.yaml only this PR (option D.4).
5. **Acknowledge Phase 10 split**: my rec — accept 10a/10b split (item G).

If all five accepted as-recommended, the scope of THIS PR becomes:

- Phase 1 (passkey for EXPLICIT)
- Phase 2-trimmed (peers.yaml + mDNS only, no WebRTC)
- Phase 3 (federation roles)
- Phase 5 (family-mode page)
- Phase 6 (about page)
- Phase 7 (docs)
- Phase 8 (icon)
- Phase 9 (NOTICE)
- Phase 10a (verification scripts + smoke test)

Estimate: ~2400 LOC, ~22 files, ~10-13h. Still a large PR but tractable.

Phase 4 (worker spawner protocol) ships separately as its own PR before this one.
WebRTC + Phase 10b (90-min load + multi-machine on different hosts) ship as follow-ups.

---

## J. What I have NOT done

- No code changes outside this findings doc.
- No package.json modifications.
- No npm install attempts.
- No schema changes.
- The branch `feat/v0.7-federation-family-mode-foundation` is created off `main @ 1fe0c54` but has only this findings file on it.

## K. What I need from operator before Phase 1

A short answer in any form (chat, ntfy reply, or by editing the recommendations in this doc and pushing) to the five questions in §I.

If the answer is "go with all recommendations as-is," reply with anything like "go" or "proceed" and I'll start Phase 1.

---

**End of Phase 0 findings.**
