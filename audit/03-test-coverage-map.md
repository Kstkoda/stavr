# Audit 03 — Test Coverage Map

> Generated 2026-05-20. Source: `npm test` run on branch `feat/v0.6.12-phases-8-11` (head 66d5bd8).

## Headline numbers

| Metric | Value |
|---|---|
| Test files (vitest)         | **165** (164 passed, 1 skipped) |
| Tests                       | **1402** (1401 passed, 1 skipped) |
| Duration                    | 25.9s wall / 115.3s in-test |
| Build status                | green |
| Skipped suite               | `tests/soak/leak-soak.test.ts` — guarded by `SHOULD_RUN` env var (intentional; opt-in soak) |
| Source `.ts` files          | **198** in `src/`, plus 23 root-level entry files |
| Source LOC                  | ~52,300 |

The suite is healthy: zero failures, only one intentionally-gated skip. The coverage *shape*, however, is uneven. Reading test counts against source counts surfaces the gaps.

## Coverage shape — files-per-module

| Module / area               | src files | test files | ratio | notes |
|---|---|---|---|---|
| `src/dashboard`             | 52        | 40         | 0.77  | dense surface area; **80% of tests are shape tests on rendered HTML**, not behaviour tests |
| `src/notify`                | 13        | 13         | 1.00  | strong — one suite per file |
| `src/observability`         | 12        | 15         | 1.25  | over-tested (retention, perf, RSS watchdog each have multiple test files) |
| `src/security`              | 13        | 13         | 1.00  | each gate has at least one test; **enforcement-call-site coverage is the gap, not unit coverage** |
| `src/trust`                 | 6         | 10         | 1.67  | matcher and no-go list have multiple variants tested |
| `src/workers`               | 15        | 12         | 0.80  | core spawner/orchestrator tested; av-detector, shell, unity untested |
| `src/federation`            | 7         | 9          | 1.29  | peer-client + mdns get integration tests |
| `src/steward`               | 16        | 6          | **0.38** | weakest of the substrate modules — see Gap #2 |
| `src/steward-agent`         | 17        | 9          | 0.53  | runtimes (anthropic/openai/ollama) have tests but autonomy has limited coverage — see Gap #3 |
| `src/tools`                 | 7         | 5          | 0.71  | usable |
| `src/connectors`            | 3         | 1          | 0.33  | only `tests/connectors/*` — one file; gh-cli writer covered out-of-tree by `tests/github-writes.test.ts` |
| `src/credentials`           | 5         | 1          | 0.20  | vault is THE secret store — see Gap #1 |
| `src/bricks`                | 3         | 1          | 0.33  | minimal |
| `src/adapters`              | 2         | 0          | 0     | **no dedicated suite** — used by federation tests indirectly |
| `src/policy`                | 1         | 0 (root)  | 0     | covered by trust tests indirectly |
| `src/types`                 | 2         | 0          | n/a   | type-only; vitest cannot exercise |
| `src/util`                  | 1         | 0          | 0     | tiny helper |
| `src/<root>` (broker, daemon, server, persistence, shim, pairing, watchdog, config, log, transports, paths, devices-storage, usage, tail, event-types, connect-test, steward-ask-*, steward-bug-fix*, watchdog-install) — 23 files | — | mixed: tests live in `tests/*.test.ts` at root (auth-middleware, chaos, dashboard-plans, decision-flow, event-flow, github-adapter, github-writes, multi-client, pairing, shim, tool-catalogue, usage, config) | partial — see Gap #4 |

## Critical untested paths (ranked by risk)

### Gap #1 — credential vault has 1 test file for 5 src files (HIGH)
- `src/credentials/vault.ts` (the actual secret-at-rest store)
- `src/credentials/store.ts` (read/write surface)
- `src/credentials/tools.ts` (MCP tool wrappers that hand secrets to AI tools)
- `tests/credentials/` contains a single suite.
- **Risk:** a regression that returns the wrong secret, leaks a secret into logs, or writes a secret in the clear is not caught.
- **Recommendation:** write a `vault.behaviour.test.ts` covering: wrong-key fails closed, mutation of unrelated record doesn't touch this one, rotation preserves history, deletion is irrecoverable, every read emits an audit event.

### Gap #2 — steward subsystem 0.38 test-to-src ratio (HIGH)
Untested or thinly tested:
- `src/steward/executor.ts` — runs the plan; failure modes (provider 500, partial step, retry exhaustion) not exercised end-to-end.
- `src/steward/planner.ts` — has unit tests for plan shape; but no negative-path test where the planner returns invalid JSON 3× (see test-run warnings: model runtime hitting attempt 3/3 max).
- `src/steward/parity.ts` — parity check between providers; no test.
- `src/steward/spawner.ts` — subprocess lifecycle, OOM handling, kill on parent exit; no test.
- `src/steward/v02-wiring.ts` — wiring shim; no test.
- `src/steward/providers/anthropic.ts`, `claude-code.ts`, `ollama.ts` — request-shape tests only; no streaming or partial-response tests.
- **Risk:** the steward is the process most likely to drift, OOM, or stall. Without spawner + executor failure tests, a regression will only surface in production.

### Gap #3 — steward-agent autonomy (MEDIUM)
- `src/steward-agent/autonomy/{proactive,probation,reactive,scheduled}.ts` — these gate what the autonomous loop is allowed to do.
- `tests/steward-agent/autonomy/` has limited coverage of the probation gate and almost no behaviour test of the scheduled path.
- **Risk:** an autonomy regression promotes a probation-tier action to auto. This is the closest thing to a "wrong-branch git push" class bug, so it deserves a property-style test that asserts no action gated higher than the current autonomy tier ever fires.

### Gap #4 — root-file substrate paths (HIGH for two specific files)
- `src/broker.ts` — the MCP request router. There is no `tests/broker.test.ts`. Coverage comes indirectly through `tests/multi-client.test.ts` and `tests/event-flow.test.ts`. The broker is the single chokepoint for every tool call; deserves a dedicated suite that exercises: unknown tool, missing connector, connector-throws, slow connector, malformed response, two-clients-one-tool race.
- `src/persistence.ts` — covered by `tests/persistence/` (1 file) and used implicitly across many others. The retention paths (`pruneEvents`) produced a warning during the suite — `WARN: pruneEvents: uncategorized event kinds preserved` — which means an uncategorized event kind exists in the test corpus, the prune is leaving rows behind, and no assertion fails. This is exactly the failure shape ADR-030 was meant to prevent.

### Gap #5 — federation peer-trust and mDNS (MEDIUM)
- `src/federation/mdns.ts` produced `WARN: federation: mDNS error {"error":"ServiceConfig requires `port` property to be set"}` **on virtually every test setup**. Forty+ occurrences in the test log. Either tests are leaking real mDNS instantiations (process noise), or the mDNS coordinator is being constructed with an incomplete config and the warn-and-continue path is masking a real bug in production setup too. This is silent in CI because the test suite passes around the warning.
- `src/federation/peer-registry.ts` and `src/federation/peer-client.ts` have peer-discovery suites but no test of the OAuth 2.1 handshake path described in ADR-035.

### Gap #6 — no-go list and host-exec enforcement (HIGH)
- `tests/trust/` covers the no-go matcher and store.
- `tests/security/` covers `host-exec-allowlist` and `host-exec-runner`.
- What's **missing**: a call-site coverage test that asserts every code path that invokes a host command goes through the allowlist. This is the test that catches "we added a new code path and forgot the gate" — exactly the regression class CLAUDE.md rule §7 (NO-GO handoff) is designed to protect.
- The test-run log shows `WARN: host-exec config: override for unknown command 'wget' ignored (not in compiled allowlist)` and same for `chmod` — confirms the allowlist is exercised, but the failure mode (a new untested call site that bypasses it entirely) has no test guard.

### Gap #7 — webauthn / tier-3 friction (HIGH)
- `src/security/webauthn.ts`, `webauthn-routes.ts`, `tier3-gate.ts` each have a test file.
- **But:** `requireRecentTier3Assertion` is reportedly not yet wired. There's no test that asserts every Tier-3-classified action calls it. Same call-site shape as Gap #6.

### Gap #8 — UI behaviour vs UI shape (MEDIUM)
- `tests/dashboard/` is 40 files but most assert on rendered HTML strings, not behaviour. Per CLAUDE.md rule §1, those assertions become brittle when the spec changes (the rule literally exists because of `tests/dashboard/topology.test.ts` asserting on `topo-bus` / `topo-mode-chips` after the v2 mockup removed them). Many of these tests would pass against a placeholder UI that's not wired to substrate — corroborated by audit-09's finding that 28+ interactive elements are placeholders.
- Recommendation: classify the existing dashboard tests into "shape" vs "behaviour" and grow the behaviour set proportionally as features wire to substrate.

### Gap #9 — chaos / failure-injection (LOW)
- `tests/chaos.test.ts` exists but is a single file. No fault injection on the persistence layer, connector layer, or steward IPC.

### Gap #10 — release suite (LOW)
- `tests/release/` (4 files) verifies build artefacts, version pins, ADR presence. Good — keep.

## Warnings emitted during the run worth investigating

These passed (no assertion failed) but indicate degraded states the suite tolerates:

| Warning | Source | Frequency in run | Worth fixing because |
|---|---|---|---|
| `federation: mDNS error {"error":"ServiceConfig requires \`port\` property to be set"}` | `src/federation/mdns.ts` | ~40+ | Either tests leak real mDNS bindings (slow + flaky on CI) or the prod path also constructs an invalid config and the warn-and-continue masks it. |
| `pruneEvents: uncategorized event kinds preserved (extend observability/retention.ts)` | `src/observability/retention.ts` | 1 | Retention is silently incomplete; rows accumulate. ADR-030 violation. |
| `notifier: background dispatch threw {"error":"The database connection is not open"}` | `src/notify/notifier.ts` | 1 | Race between teardown and async dispatch — leak shape. |
| `reply-router: respondToDecision failed {"decision_id":"...","chosen":"yes","error":"already_responded"}` | `src/notify/reply-router.ts` | 2 | Either a test asserts the idempotency path (good) or duplicate dispatch is happening unexpectedly. |
| `model runtime output failed validation` (attempt 1/2/3/3) | `src/steward-agent/runtimes/*.ts` | ~12 | Tests deliberately exercise the retry path — fine — but no assertion on attempt-count, so the "exactly 3 attempts" invariant is implicit. |
| `host-exec config: override for unknown command 'wget' ignored (not in compiled allowlist)` | `src/security/host-exec-config.ts` | 2 | The fail-closed behaviour is exercised — good — but no test asserts the WARN is logged. |
| `heap snapshot written {"size_bytes":37056103}`, `cpu profile written` | `src/observability/debug-endpoints.ts` | 3 | Test suite *writes 37–43 MB heap snapshots* into `tmp/heap-snapshots/` during a normal run. These are committed by `.gitignore` exclusion but balloon dev workspaces. Worth gating behind an env var. |
| `DEP0190` Node deprecation: "args to a child process with shell option true" | unknown caller | 1 | Pre-existing Node deprecation; track down the call site (likely `src/workers/shell.ts` or similar) before Node 22 makes it an error. |

## Recommendations (sized)

| # | Action | Size |
|---|---|---|
| 1 | Dedicated `tests/broker.test.ts` covering 6 routing edge cases | small |
| 2 | Behaviour suite for `src/credentials/vault.ts` (rotate, fail-closed, audit-on-read) | small |
| 3 | Property test: no action above current autonomy tier ever fires | medium |
| 4 | Call-site enforcement test for host-exec + no-go + tier-3 (uses ts-morph to find call graphs) | medium / BOM-worthy |
| 5 | Fix the `pruneEvents: uncategorized event kinds` warn → assertion | trivial |
| 6 | Fix the mDNS test-time warning (either don't construct mDNS in unit tests, or set a port) | trivial |
| 7 | Gate heap-snapshot writes during tests behind `STAVR_TEST_ALLOW_SNAPSHOTS` | trivial |
| 8 | Stream-test for steward providers (anthropic/openai/ollama) covering partial responses | small |
| 9 | Reclassify `tests/dashboard/*` into "shape" vs "behaviour" and grow behaviour set as elements move from placeholder → works (cross-ref audit/09) | medium |
| 10 | Fix the DEP0190 child-process deprecation site | small |
