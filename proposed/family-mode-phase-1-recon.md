# Recon: Family-mode Phase 1 — pre-implementation findings

**Status:** Phase 0 output. Operator review required before Phase 1 begins.
**Branch:** `feat/family-mode-phase-1` (off `main` at `b80c602` — chore/hygiene-sweep merge)
**Sensitivity:** `high` — security primitives + transport bind. No code edits in this phase; output is this document only.

This document pins the load-bearing facts the rest of the BOM's phases assume. Anything stated below is grounded in a file:line reference so subsequent phases can be checked against ground truth without re-deriving.

---

## TL;DR

1. **A structural chokepoint already exists** (`wrapServerForRegistry`, `src/tools/registry.ts:171`) — every `server.registerTool(...)` is patched so every tool handler runs through `wrapHandlerWithGate` before the subsystem code sees the call. Phase 2 does **not** need to introduce a new chokepoint; it needs to extend the gate's `check()` (today wired only to Layer 0) so it also consults no-go + per-actor tier + Tier-3.
2. **The permission model IS opt-in today** — confirmed. `gatedAction()` is called from exactly two files (`src/adapters/github-writes.ts`, `src/trust/tools.ts`). Every other tool — `host_exec`, `worker_*`, decisions, credentials, steward, federation, emit_event — bypasses no-go entirely. `requireRecentTier3Assertion` is called from zero production sites.
3. **The self-approval hole is real** — `respond_to_decision` (`src/tools/decisions.ts:125`) accepts any `responder` string and does no equality check against the originating `source_agent`. Persistence (`src/persistence.ts:983`) also enforces nothing. The decisions table does **not** store `source_agent` at all today; it is stamped only on the `decision_request` event. Phase 4 therefore needs either an additive `source_agent` column on `decisions` or an event-lookup at validation time. Flagged per the BOM's Don't-touch carve-out.
4. **Cross-machine pairing is built and wired end-to-end** — CLI (`stavr pair bootstrap` + `stavr pair remote-host`), HTTP endpoints (`/pair/initiate`, `/pair/complete`), bearer-auth middleware, bindHost CLI flag, `requireAuthWhenNonLocal` refusal logic. What v0.7 left incomplete: nothing for Phase 5 *itself* — the bind-enable scope is to set `bindHost` non-loopback, verify a real two-machine pair, and confirm the auth gate fires. The federation **event-mirror** path (peer A → peer B's MCP gateway) is a separate Phase 3 concern, not Phase 5's responsibility.
5. **mDNS error path is the small fix Phase 1 expects** — `MdnsCoordinator.start()` returns synchronously from `driver.publish()`, but bonjour's "Service name in use" error arrives asynchronously via a UDP probe response. Neither `this.advertised` (the `Service`) nor `this.browser` has an `'error'` listener attached. The coordinator's `'error'` event itself is already routed to `log.warn` in `src/federation/index.ts:89` — so Phase 1 only adds the two missing forwarders and a regression test.

---

## 1. The generic tool-invocation chokepoint

**It exists.** It is `wrapServerForRegistry` in `src/tools/registry.ts:171`, invoked once per MCP session in `createSwitchServer` (`src/server.ts:343`).

```ts
// src/tools/registry.ts:171-199
export function wrapServerForRegistry(
  server: McpServer,
  registry: ToolRegistry,
  registered_by = 'server',
  gate?: RuntimeToolGate,   // ← the policy hook
): void { … }
```

It patches `server.registerTool(name, config, handler)` so:

1. Every registration is recorded in `ToolRegistry` (the catalog).
2. The supplied `handler` is wrapped via `wrapHandlerWithGate(toolId, handler, gate)` (`registry.ts:210`) so the SDK ultimately calls a function that runs `gate.check(toolId, args[0])` **before** the subsystem handler.

Hook surface for Phase 2:

```ts
// src/tools/registry.ts:160-169
export interface RuntimeToolGate {
  check(toolId: string, args: unknown): { allowed: boolean; reason?: string };
}
```

It is currently wired with a single concern — Layer 0 capability overrides (`src/server.ts:343-350`):

```ts
wrapServerForRegistry(server, toolRegistry, 'server.ts', {
  check(toolId: string): { allowed: boolean; reason?: string } {
    const res = capabilityStore.check(toolId);
    return res.allowed ? { allowed: true } : { allowed: false, reason: res.reason };
  },
});
```

**Subsystems that go through this wrapper today** — every one of them, because every subsystem calls `server.registerTool` and the wrapper patches the method on the singleton McpServer instance the broker hands out. Grep confirms the registration sites: `src/server.ts`, `src/adapters/github-writes.ts`, `src/workers/tools.ts`, `src/trust/tools.ts`, `src/tools/propose-plan.ts`, `src/tools/decisions.ts`, `src/steward/tools.ts`, `src/steward-ask-tool.ts`, `src/credentials/tools.ts`, `src/adapters/github.ts`, `src/security/host-exec-tool.ts`.

**Phase 2 implication:** the chokepoint is structural and complete — no need to introduce a new dispatcher. Phase 2 work is to make `gate.check()` consult the *other* policy layers (no-go, per-actor tier, Tier-3) in addition to Layer 0, and to thread the calling actor identity into the check (today only `toolId` + `args` are passed; the actor must be available too — needs a per-session actor stamping path; see §3.b below).

Test coverage of the chokepoint itself: `tests/tools/registry-gate.test.ts` — proves allow/deny short-circuit and gate-throw → toolError. The test does *not* cover layered policy yet because nothing else is wired.

---

## 2. What `gatedAction()` covers — and what bypasses it

Source: `src/tools/gated-action.ts`. Call sites (grep `gatedAction(`):

- `src/adapters/github-writes.ts` — all GitHub *write* tools (create PR / merge PR / labels / comments / issues / branches). Each call passes `scopeCheck: { tool, args, trustStore }` so the trust-scope short-circuit + no-go floor both apply.
- `src/trust/tools.ts` — `trust_scope_grant` and `trust_scope_extend` (CONFIRM-tier scope operations).

That's it. Confirmed exhaustive via Grep.

What `gatedAction()` enforces internally when called:

1. No-go check (`gated-action.ts:84`): `checkNoGo(toolName, toolArgs)` — only fires when `scopeCheck.tool` is supplied. Most callers do.
2. Trust-scope short-circuit (`gated-action.ts:90-144`): if there's an active covering scope AND no no-go match, auto-execute and record under the scope, no `await_decision`.
3. Otherwise opens an `await_decision` and blocks on `respondToDecision`.

**What bypasses gatedAction entirely** (i.e., does NOT consult no-go, does NOT consult any tier check):

| Tool family | Source | What gate it has today |
|---|---|---|
| `emit_event` | `src/server.ts:386` | Layer 0 only |
| `subscribe_to_events`, `unsubscribe`, `get_events` | `src/server.ts` | Layer 0 only |
| `await_decision`, `respond_to_decision` | `src/tools/decisions.ts` | Layer 0 only |
| `worker_spawn`, `worker_dispatch`, `worker_terminate`, `worker_*` | `src/workers/tools.ts` | Layer 0 only (no per-actor tier, no Tier-3 even though `worker_spawn`/`worker_dispatch` are CONFIRM defaults per `categories.ts`) |
| `host_exec` | `src/security/host-exec-tool.ts` | Trust-scope check + allowlist (its own bespoke pre-check, NOT via gatedAction); Layer 0 from the wrapper. No no-go, no per-actor tier, no Tier-3. |
| `credential_*` | `src/credentials/tools.ts` | Layer 0 only |
| `steward_*` | `src/steward/tools.ts`, `src/steward-ask-tool.ts` | Layer 0 only |
| `propose_plan` | `src/tools/propose-plan.ts` | Layer 0 only |
| `github_*` (reads) | `src/adapters/github.ts` | Layer 0 only |

**Phase 2 implication:** the chokepoint is right place to land the cross-cutting checks. `host_exec` has the most awkward overlap because it already does its own trust-scope + allowlist pre-check inside the handler — Phase 2 needs to fold no-go + tier into the wrapper *before* `host_exec`'s body runs, while leaving its allowlist + scope check intact (they're more specific than what the wrapper provides). The wrapper's check happens *before* the body, so this should be additive, not subtractive.

---

## 3. Permission components — wiring status

The canonical 5-layer model is documented in `src/security/capability-overrides.ts:5-13`:

```
1. Lex Insculpta hard check (source-code constants)
2. No-Go list                 (source-code seeded patterns)
3. Layer 0 capability check   ← wired
4. Per-actor permission tier  (Layer 3 — actor-permissions.ts)
5. Trust scope grant          (Layer 4 — trust-scopes.ts / trust/store.ts)
```

(Note the "Layer 3 / Layer 4" labels in that comment refer to layer *names*, not their position in the list; the per-actor tier is *check #4*, trust scope is check #5. The model in memory `project_stavr_layer_0_capability_disable` uses the position numbering.)

### 3.a No-go list

- **File:** `src/trust/no-go-list.ts`
- **Public API:** `checkNoGo(tool, args) -> NoGoEntry | undefined`, `findNoGoMatch(list, tool, args)`, `mergeUserAdditions`, `getLiveNoGoList`, `setLiveNoGoList`.
- **Wired at:** `src/tools/gated-action.ts:85` — and ONLY there.
- **Tests:** `tests/trust/no-go-list.test.ts` (logic). No invocation-time test that proves a *non-gatedAction* tool call hits no-go.
- **STARTER_NO_GO_LIST entries (12):** `fs.rm_recursive_root`, `git.force_push_default_branch`, `github.delete_repo`, `github.merge_to_default_under_seconds_old_pr`, `sql.drop_table_or_database`, `net.curl_pipe_shell`, `creds.read_ssh_or_aws`, `creds.read_env_outside_project`, `self.modify_no_go_list`, `self.modify_trust_store`, `comm.external_send`. Severities: 10 critical, 2 high.
- **Daemon-boot user-additions loader:** `mergeUserAdditions` exists in source. Confirmed not yet invoked in `src/daemon.ts` — no current load of `~/.stavr/no-go-additions.ts`. Phase 2 may want to enable it; not strictly required for the chokepoint-enforcement task.

### 3.b Per-actor permission tier (Layer 3)

- **File:** `src/security/actor-permissions.ts`
- **Public API:** `ActorPermissionStore.resolve(actorId, toolId) -> { tier, source }`, list/byActor/get/set/reset/resetActor.
- **Backing table:** `actor_permissions` (`src/persistence.ts:550`) — `(actor_id, tool_id) UNIQUE`, columns `tier, set_by, set_at`.
- **Wired at:** nowhere in the runtime authorisation path. Only consumers are the dashboard data layer (`src/dashboard/data/permissions-data.ts`, `src/security/policies.ts`, `src/security/policies-yaml.ts`).
- **Tests:** `tests/security/actor-permissions.test.ts` (store logic). No invocation-time test.
- **Default tier fallback:** when no matrix row, `defaultTierFor(toolId)` from `src/tools/categories.ts:137`. The default table seeds `host_exec: EXPLICIT`, `worker_spawn/dispatch/terminate: CONFIRM`, `respond_to_decision: AUTO`, etc. — see `src/tools/categories.ts:112-131`.
- **Phase 2 blocker — actor identity threading:** the chokepoint's `RuntimeToolGate.check(toolId, args)` doesn't receive the calling actor. Need to either (a) extend the gate signature to take an actor id, or (b) plumb actor via AsyncLocalStorage like the HTTP correlation id (`src/transports.ts:229-234` already runs every request inside `logContext.run({correlation_id})`). Option (b) generalises and avoids a wider API change. Phase 2 should pick one — recommend (b), reusing `logContext` to also stamp `actor_id`.
- **Actor identity at the transport edge:** today the daemon does not stamp an actor per MCP request. The HTTP middleware (`transports.ts:418-437`) attaches `req.device` for paired remote calls. Loopback callers (Cowork, CC) are not distinguished — every loopback call would resolve to a single default actor unless Phase 2 introduces a stamping convention (e.g., a `Stavr-Actor` HTTP header, or per-session actor from MCP initialize handshake). Naming this convention is part of Phase 2.

### 3.c Layer 0 capability master switch

- **File:** `src/security/capability-overrides.ts`
- **Public API:** `CapabilityOverrideStore.check(toolId)`, `.disablePermanent/.disableTemporary/.enable/.remove`, `.list/.get/.isDisabled/.activeDisabledCount`.
- **Backing table:** `capability_overrides` (`src/persistence.ts:538`).
- **Wired at:** `src/server.ts:343-350` — the only layer the chokepoint currently consults.
- **Tests:** `tests/security/capability-overrides.test.ts` (logic), `tests/tools/registry-gate.test.ts` (chokepoint hookup), `tests/dashboard/capability-matrix.test.ts` (dashboard).
- **Editable from:** dashboard `/dashboard/permissions` only. No MCP write tool — comment at `capability-overrides.ts:23` documents that as a deliberate hard NO.

### 3.d Tier-3 gate

- **File:** `src/security/tier3-gate.ts`
- **Public API:** `requireRecentTier3Assertion(identity, opts) -> { ok: true, assertion } | { ok: false, reason, hint }`. Returns success when the operator has a recent WebAuthn assertion (default 60s window).
- **Call sites in production code:** **zero**. Grep across `src/` confirms only `tier3-gate.ts` itself references the function name. The file's own header comment (`tier3-gate.ts:14-26`) admits this: *"NOT wired in Phase 3 (deferred to v0.7.1): host_exec's EXPLICIT-tagged paths… the orchestrator's worker_spawn/dispatch gate"*. The "Phase 3" referenced there is the *v0.7* phase, not this BOM's Phase 3.
- **Tests:** `tests/security/tier3-gate.test.ts` (logic only). No end-to-end test where an EXPLICIT-tier action blocks for a passkey.
- **Three "friction string" UI strings the BOM mentions:** these are the dashboard prompts in `src/dashboard/pages/permissions.ts` (and one or two adjacent) that visualise EXPLICIT-tier rows. No code path *accepts* a friction string today — that work is what Phase 3 wires.

### 3.e WebAuthn / passkey ceremony

- **Files:** `src/security/webauthn.ts` (coordinator, RP id resolution, register/auth ceremonies), `src/security/webauthn-routes.ts` (HTTP routes), `src/security/identity-store.ts` (credential + assertion persistence).
- **Mounted at:** `src/transports.ts:981-985` (`mountWebAuthnRoutes(app, { getCoordinator, getIdentityStore, getBroker })`) — under `/api/auth/*`.
- **RP id:** defaults to `localhost`, overridable via `STAVR_WEBAUTHN_RP_ID` env (`webauthn.ts:90`). LAN/family deployments would set this to the host's mDNS name. Phase 5's non-loopback bind makes this an operator concern, not a code concern.
- **Assertion freshness:** `DEFAULT_TIER3_ASSERTION_TTL_MS = 60_000` (`webauthn.ts:51`).
- **What's missing:** nothing in the ceremony layer. The piece missing is in `host_exec` / `worker_spawn` / wherever an EXPLICIT-tier check belongs — they need to call `requireRecentTier3Assertion` before performing the action. Phase 3 adds that call.

### 3.f Trust scope (Layer 5)

- **File:** `src/trust/store.ts` + `src/trust/tools.ts` (already read).
- **Wired at:** `src/tools/gated-action.ts:90-144` and inside `src/security/host-exec-tool.ts` (its own `findActiveScopeFor`).
- **Out of scope** for this BOM beyond noting it is correctly invoked by the two gated paths.

---

## 4. Decision path — where the self-approval hole lives

### 4.a Where `decision_request` is created

Two sites:

1. **`await_decision` MCP tool** — `src/tools/decisions.ts:49-61`. The caller supplies `source_agent` via the tool input (`source_agent: z.string().default('cc')`, `decisions.ts:26`). Any actor calling `await_decision` can name itself whatever it likes — there's no transport-level verification of the value.
2. **`gatedAction()`** — `src/tools/gated-action.ts:191-203`. `sourceAgent` is taken from `opts.sourceAgent ?? 'cc'` (`gated-action.ts:74`). All current callers (`github-writes`, `trust/tools`) pass through their own tool-input `source_agent`, so the same trust-the-caller pattern applies.

In both cases, `source_agent` lands on the `decision_request` *event* (table: `events`, payload column).

### 4.b Where `source_agent` is stored

- Decision **event** (`decision_request` kind): payload includes `source_agent` via the event row's column (`events.source_agent`, `persistence.ts:149`).
- Decision **row** (`decisions` table, `persistence.ts:533`): does **not** store `source_agent`. Columns: `correlation_id, question, options_json, status, expires_at, default_option_id, responded_at, responded_by, chosen_option_id, response_reason`.

So the originating-agent identity is in the audit event log, not in the decision record itself.

### 4.c Where `respond_to_decision` validates

`src/tools/decisions.ts:125-184`:

```ts
server.registerTool('respond_to_decision', {
  inputSchema: { correlation_id, chosen_option_id, reason?, responder },
}, async (args) => {
  const existing = broker.store.getDecision(args.correlation_id);
  if (!existing) return toolJson({ ok: false, error: 'not_found' });
  const result = broker.store.respondToDecision(...args..., args.responder);
  ...
});
```

`broker.store.respondToDecision` (`persistence.ts:983-1013`) takes `responder: string` and writes it to `responded_by`. **No equality check.** The persistence layer's only validations are: decision exists, not already responded, not expired, chosen option is in the offered list.

### 4.d Where the responder ≠ requester check belongs

Two natural placement options:

1. **Tool-layer check** (`src/tools/decisions.ts`, inside `respond_to_decision` handler, between line 142 and 144). Read the original `decision_request` event by `correlation_id` from the events table (or read the new column — see below), pull its `source_agent`, reject the response with `toolJson({ ok: false, error: 'responder_is_requester' })` and emit a `decision_self_approval_rejected` audit event.
2. **Persistence-layer defense-in-depth** in `respondToDecision()` (`persistence.ts:983`). The store needs the requester identity available; today it isn't stored.

**Schema decision needed** (flagged per the BOM's Don't-touch carve-out — *"except one additive column/table if the decision-responder validation provably needs one"*): either

- **Option A — add `source_agent` column** to `decisions` (additive, single ALTER TABLE migration with `DEFAULT NULL` for existing rows). Lets persistence-layer check work without a cross-table join.
- **Option B — query the originating `decision_request` event** in the tool-layer handler by `correlation_id`. No schema change; one extra read per response. Defensive: an event row could be missing if retention swept it (currently events have retention windows per ADR-030); the validator would need a fallback.

**Recommendation for Phase 4:** Option A. The decisions table is small and rarely written; an additive column is cheap; the defense-in-depth in persistence is meaningful (the same check landing in both the tool handler and `respondToDecision()` closes a "what if a future tool also responds" gap). Flag this in the Phase 4 PR description.

### 4.e EXPLICIT-tier responder

Per the BOM: *"EXPLICIT / Tier-3 decisions: `responder` must be the operator via an authenticated human channel (dashboard-user / WebAuthn), not any agent."* The dashboard's decision-respond write path already exists (read-only mention in `transports.ts` dashboard mount); Phase 4 needs to add a gate that says: if the original decision was opened by a Tier-3 EXPLICIT action, the only allowed responder values are dashboard-session or `requireRecentTier3Assertion`-validated callers. The tier of the originating action would need to be carried on the decision record (additional schema concern, OR derivable from the event payload). Worth surfacing in the Phase 4 design discussion.

---

## 5. The bind path

### 5.a Today's defaults (local-only)

`src/transports.ts:210-219`:

```ts
const bindHost = opts.bindHost ?? '127.0.0.1';
const isLoopback = bindHost === '127.0.0.1' || bindHost === '::1' || bindHost === 'localhost';
const requireAuth = opts.requireAuthWhenNonLocal !== false;
if (!isLoopback && requireAuth && !opts.authConfigured) {
  throw new Error(
    'stavr daemon refusing to bind non-local without auth configured. ' +
    'Run `stavr pair --bootstrap` first or set `network.require_auth_when_non_local: false` ' +
    "if you know what you're doing.",
  );
}
```

Defaults: `bindHost = 127.0.0.1`, `requireAuthWhenNonLocal = true`. Daemon computes `authConfigured` from `store.countActiveDevices() > 0` (`src/daemon.ts:262`). So Phase 5 effectively only needs to: have the operator (1) pair at least one device, then (2) set `--bind-host <LAN-IP>` on daemon launch. Both already work.

CLI surface — `src/daemon.ts:709-710` already passes `--bind-host` + `--allow-non-local-without-auth` down to the daemon child process when the parent has those options.

### 5.b Bearer auth middleware

`src/transports.ts:411-437`. Active iff `authConfigured && !isLoopback`. Public-paths allowlist: `/healthz`, `/pair/initiate`, `/pair/complete`. Loopback always exempt. Pure-decision shim `checkBearerAuth` (`transports.ts:1137`) is independently unit-testable; tests in `tests/auth-middleware.test.ts`.

Token storage: `devices` table, SHA-256 of token (`pairing.ts:37`). Raw token returned exactly once to the new device — `transports.ts:407`. Comparison is timing-safe via `findActiveDeviceByTokenHash` + plain hash lookup.

### 5.c Pairing flow

| Side | Command | What happens |
|---|---|---|
| Daemon host | `stavr pair bootstrap` (`cli.ts:510`) | POST `/pair/initiate` (loopback-only). Daemon opens 6-digit code, 5-min TTL, prints to stdout. |
| New device | `stavr pair remote-host -u <daemon-url> -c <code> -n <name>` (`cli.ts:548`) | POST `/pair/complete`. Daemon issues UUID-shaped 24-byte token, stores SHA-256 in `devices`. Token returned once, written to local `devices-storage.ts` file on the new device. |

End-to-end testing: `tests/federation/pairing.test.ts`. Two-machine smoke is the Phase 6 verification deliverable.

### 5.d What v0.7 left incomplete (Phase 5 scope check)

Phase 5's stated goal is "non-loopback bind + cross-machine pairing." Against the code as it stands today:

- ✅ Bind: `--bind-host` flag wired, `requireAuthWhenNonLocal` guard wired.
- ✅ Pairing CLI both sides.
- ✅ Pairing HTTP endpoints.
- ✅ Bearer auth middleware on non-loopback.
- ✅ Healthz / pair endpoints public.
- ⚠ The default daemon entry point still binds 127.0.0.1 unless the operator passes the flag — there is no env-var or config-file path that flips it. Phase 5 should add `STAVR_BIND_HOST` env (mirror of `STAVR_PORT`) and a `[network] bind_host` field in the stavR config so the operator doesn't have to pass a CLI flag every restart. Trivial; mention in PR.
- ⚠ `STAVR_PEER_ID` defaults to `'stavr-self'` (`federation/index.ts:53`). Two daemons on the same LAN both advertise `'stavr-self'` and the mDNS publisher collides. The BOM scopes the mDNS service-name redesign to **family-mode Phase 3**, not this BOM. Phase 5 here should at minimum recommend operators set `STAVR_PEER_ID` to a per-host value before going non-loopback, or even hard-fail at bind time if it's still the default and bindHost is non-loopback (defensive). Surface as a Phase 5 design question.
- ⚠ Federation event mirroring (peer A's MCP gateway calling out to peer B's daemon) is NOT built. Phase 3 of family-mode covers that; Phase 5 here only needs to prove that a second machine *can pair* and *reach* the LAN-exposed daemon via its own MCP/HTTP client, which the gateway+pair+auth path already supports.

**Phase 5's hard prerequisite stands:** Phases 2–4 must merge before this phase's bind-enable lands, per the BOM's "THE HARD RULE." Code-wise, Phase 5 is a small change set; the gating concern is enforcement readiness, not transport readiness.

---

## 6. mDNS Phase 1 fix — concrete scope

**File:** `src/federation/mdns.ts`, function `start()` (`mdns.ts:79-122`).

**Root cause:** bonjour-service's "Service name is already in use" error arrives asynchronously via a UDP probe response (RFC 6762 §8.2), *after* `driver.publish()` has already returned the `Service` object. The current `try/catch` around `publish()` (lines 87-102) only catches synchronous errors during the publish call — not the async probe response. Without a listener on `this.advertised`, that emits as `'error'` on the EventEmitter and goes uncaught, crashing the daemon (uncaughtException → PM2 restart loop in family-mode where multiple daemons collide on the same `stavr-self` peer id).

**Fix:** attach `'error'` listeners on both `this.advertised` (the published `Service`) and `this.browser` (the `find()` result), forwarding the error into the coordinator's own `'error'` event (which is already routed to `log.warn` in `src/federation/index.ts:89` — no change needed in the consumer).

Concretely (illustrative, not the implementation):

```ts
this.advertised = this.driver.publish({ … });
(this.advertised as unknown as EventEmitter).on('error', (err) =>
  this.emit('error', toError(err)),
);

this.browser = this.driver.find({ … });
(this.browser as unknown as EventEmitter).on('error', (err) =>
  this.emit('error', toError(err)),
);
```

Estimated diff: ~6 lines + a regression test in `tests/federation/mdns.test.ts`. The test should stub a driver whose `publish()` returns a `Service` that later emits `'error'`, then assert that the coordinator surfaces it via its own `'error'` event without an uncaught exception.

The mDNS service-name redesign (so `stavr-self` collisions don't *happen* in the first place) is explicitly out of scope here — that is family-mode Phase 3 per the BOM's Don't-touch.

---

## 7. Open design questions to resolve before Phase 2 starts

Phase 0 is research-only, but these calls have to be made *before* Phase 2 writes code:

1. **Actor identity threading at the chokepoint.** Recommend: introduce an `actor_id` field in the existing `logContext` AsyncLocalStorage (set in the HTTP middleware from `req.device` for remote callers, defaulted to `loopback:<session>` for local MCP sessions). The `RuntimeToolGate.check()` reads it via `logContext.getStore()`. Alternative: change the gate signature to `check(toolId, args, ctx)`. Decision needed at start of Phase 2.
2. **Decisions table schema change.** Recommend Option A (additive `source_agent` column). Confirm Phase 4 may add it.
3. **Stamping convention for MCP-callers.** Cowork, CC, Steward — how do they self-identify? Today the convention is to pass `source_agent` as a tool arg. For tier resolution that's adequate (trust the caller naming itself), but for the self-approval check the responder identity must be **verified**, not declared. For loopback the verification has to be a per-session attestation negotiated at MCP `initialize`. Out of scope for this BOM, but Phase 4's "EXPLICIT decisions must be operator-via-WebAuthn" handwaves it: dashboard sessions are operator (validated by the dashboard auth, currently loopback-only); WebAuthn-assertion callers are operator. Any non-operator responder is treated as an agent. Phase 4 doc must state this clearly.
4. **Layer 0 already enforced at chokepoint — confirm Phase 2's expansion does not regress the existing test.** `tests/tools/registry-gate.test.ts` asserts on the current shape. Phase 2's wider gate will need new negative-path cases per layer; the existing test should keep passing (Layer 0 deny still wins early). Per CLAUDE.md §1 (tests-are-derivative), if the wider gate changes the *deny reason* string, the existing test's expected string changes in the same commit — that is a load-bearing assertion on behavior, not on incidental text, and is the right kind of test to update.

---

## End of Phase 0 recon

Next step: **operator review**. No Phase 1 code change has been made. Phase 1 (the mDNS fix) will begin only after the operator approves this document and signals to proceed.
