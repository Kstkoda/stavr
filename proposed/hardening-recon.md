# stavR Hardening — Test & Resilience Coverage Recon

**Scope:** read-only. Inventory and assess existing test / chaos / soak / perf
coverage so the operator's 10-3-1 on a hardening rig can be grounded in what
already ships.
**Branch:** `chore/hardening-recon` (this commit only).
**BOM:** `proposed/hardening-recon-bom.md`.

---

## TL;DR

- **198 test files, ~1614 test cases.** The "~1665 tests" headline is in the
  right ballpark — but the **classification split is the story**: ~71 % of
  test files are pure mocked-unit or in-process-collaborator tests using
  `:memory:` SQLite; only **4 test files boot a real CLI subprocess** (all
  federation/CLI smoke) and **0 test files exercise two daemons over a real
  network**. The autonomous two-instance federation surrogate exists in
  `tmp/perf/peer-smoke.mjs` — it is **not wired into CI**.
- **4 GitHub Actions workflows total.** `ci.yml` runs vitest + tsc on
  Windows + Linux on every push/PR. `soak.yml` runs the in-process leak soak
  weekly. `governor-build.yml` and `governor-release.yml` cover the Rust
  governor's build/sign/release pipeline. **There is no `daemon-sea.yml`**
  (the BOM mentions it; it doesn't exist in this repo — see Task 2).
  **No workflow runs `tmp/perf/peer-smoke.mjs` or any cross-process daemon
  smoke.**
- **`tmp/perf/*` is a half-harness**: `load-runner.mjs` and `freeze-probe.mjs`
  are reusable scaffolding with a real CSV/JSON output contract;
  `peer-smoke.mjs` + `spin-peer.ps1` are operator-supervised one-shots that
  were used to verify v0.7 federation Phase 10a. None of them assert (they
  log + summarize). None run from CI. None are deterministic (no seeded RNG).
- **The escaped-bug pattern is consistent**: every defect in the BOM's list
  (Telegram poller never wired, `wincred ^1.1.6` phantom dep, MCP transport
  built with no `eventStore`, federation never working cross-machine, stale
  `/status`, v0.6.x leak, family-mode-phase-1 self-approval) lived in a
  **wiring seam** or in a **production-only code path** that the existing
  suite's `mountTransports({port: 0})` + `:memory:` SQLite construction does
  not exercise. Most have *some* unit test for the component; none had the
  full installed-and-running-cross-machine reality covered.
- **Invariant coverage is shallow.** ADR-036's hash-chained event log is
  **proposed-only** (no `prev_hash`/`event_hash` columns in code, no
  verification command, no test). There is no permanent
  "rebuild-projection-from-event-log" test — `proposed/family-mode-phase-2-bom.md`
  mentions a Phase 2 "event log smoke" but it lives in operator notes,
  not in `tests/`. Continuous invariants (chain intact, projection ≡ log
  replay, no orphaned scopes, no leaked sessions after burst) are
  unenforced.
- **Reproducibility: none.** No test uses seeded randomness. No
  property-based or fuzz framework is on the dependency list. Chaos tests
  (`tests/chaos.test.ts`) use real wall-clock and `mkdtempSync` — repeatable
  shape but not seed-deterministic.

**Recommended shortlist (full version in §9):** **L** topology virtualization
(rebuild on top of `peer-smoke.mjs`), **M** chaos layer (process kill +
netem + projection corruption oracles), **S** adversarial fuzz over
JSON-RPC + decision-respond + scope-gated tool calls, **promote** the
existing soak workflow rather than rebuild, and **build the oracle layer
first** because nothing else lands repeatable failure without it.

---

## §1 Test asset inventory

**Totals:** 198 `*.test.ts` files, ~1614 test cases, plus 5 non-`.test.ts`
helpers (`tests/setup.ts`, `tests/trust/harness.ts`,
`tests/observability/otel-harness.ts`, `tests/manual/github-smoke.ts`,
`tests/observability/fixtures/dcgm-sample.txt`).

### Files by category

| Category | Files | What it actually exercises |
|---|---:|---|
| `dashboard/` (incl. nested) | 49 | Page rendering against in-process daemon + adapter-shape tests + a few subprocess-spawn diagnostics tests. Mostly **in-process integration** (mountTransports on port 0). |
| `observability/` | 24 | Metrics emission, OTel pipeline, RSS watchdog, cardinality. Mostly **mocked-unit** with a fake scheduler / fake `process.memoryUsage`; a few hit a real HTTP server. |
| `security/` | 15 | Allowlists, host-exec gating, identity store, WebAuthn, Tier-3 gate, self-approval refusal, policies-yaml round trip. **Component-level integration**: real EventStore + real policy engine + mocked OS surfaces (host-exec runner mocks `child_process`). |
| `workers/` | 14 | Spawner protocol, admission control, lifecycle, watchdog, AV detector, MCP-worker config. Mostly **integration** — real `spawn()` of worker processes in some, mocks in others. |
| `notify/` | 12 | Notifier, channels (email/ntfy/telegram), Telegram poller + directives, rate-limiter, reply-router, server-wiring. Real components, **mocked `fetch` / mocked SMTP transport / mocked Telegram HTTP** (`TgTransport` injection). |
| `trust/` | 10 | Scope matcher, grant/revoke/expiration, no-go, outside-scope, github-writes scope-match, reporter. Pure **integration** on the trust subsystem — real EventStore, real scope graph. |
| `federation/` | 10 | mDNS reflector (mocked `bonjour-service`), peer-registry, peer-client, peers, bind hardening, pairing E2E, phase5 bind+fence, steward-bug-fix. **Mix**: 6 in-process; 3 **boot real CLI subprocesses via tsx** (`bind.test.ts`, `pairing.test.ts`, `steward-bug-fix.test.ts`); 1 mocked-unit (mdns). |
| `transports/` | 4 | One-shot MCP leak guard, operator-trust, settings-scopes, steward-routes. **In-process integration** (mountTransports on port 0). |
| `tools/` | 5 | Tool registry, registry-gate, propose-plan, categories, capture. Real tool registry + mocked OS. |
| `steward/` | 5 + 1 sub | Planner-routing, executor, claim, loop, parity, ollama provider. **Mocked-unit** for the executor + LLM provider; integration for claim/loop. |
| `steward-agent/` | 7 | Autonomy, DB init, runtimes (anthropic/ollama/openai/selector), spawner. **Mocked LLM + mocked spawn**. |
| `release/` | 4 | Install-from-release shape tests (string-match against PowerShell + bash scripts), SBOM format, signing smoke, dev-sign helpers. **Static shape** — no real cosign invocation, no real install. |
| `governor/` | 2 | Load-shedder + OS-cap. Tests of the TypeScript shim that talks to the Rust governor. **Mocked OS / mocked subprocess.** |
| `daemon/` | 2 | Stale PID detection, test-bypass guard. **Filesystem-level**. |
| `cli/` | 2 | Start unification, tail. **One spawns the real CLI**; the other is in-process. |
| `bricks/` | 1 | Installer round-trip. **Filesystem-level** + dynamic import. |
| `credentials/` | 1 | Vault encrypt/decrypt. **Pure unit** — no OS keychain. |
| `connectors/` | 1 | Webhook connector. **Integration**, real HTTP echo server in-process. |
| `persistence/` | 1 | Workers lifecycle migration. **Real SQLite file**. |
| `types/` | 1 | Host-ceiling types. Pure unit. |
| `integration/` | 2 | v0.2 smoke (full v0.2 substrate end-to-end in-process), host-resource-ceiling. |
| `soak/` | 1 | Skipped unless `STAVR_RUN_SOAK=1`. See §2 + §5d. |
| Top-level | 18 | `auth-middleware`, `chaos`, `config`, `dashboard`, `dashboard-plans`, `decision-flow`, `event-flow`, `github-adapter`, `github-writes`, `multi-client`, `pairing`, `shim`, `steward-ask-tool`, `steward-bug-fix`, `tool-catalogue`, `usage`, plus `setup.ts`. Mix of in-process integration + a few that spawn the shim or hit real `gh`. |

### Classification split (mocked-unit / integration / e2e)

The mocking discipline in this codebase is *opposite* to most TS projects:
**`vi.mock` is used by only 9 files**. The bulk of "unit" tests are
constructed-component tests — real `new EventStore(); store.init(':memory:'); new Broker(store)`
with collaborators stubbed via dependency injection (e.g.,
`mockTransport` for Telegram, `fakeScheduler` for the RSS watchdog,
in-memory fixture brick for installer tests). That's *integration in
miniature*, not unit-testing in the strict mock-everything sense.

**Concrete counts:**

| Class | Heuristic | File count | Notes |
|---|---|---:|---|
| **e2e** (real daemon subprocess over a real socket) | `spawn(process.execPath, [tsxCli, cliEntry, ...])` | **4** | `cli/start-unification`, `federation/bind`, `federation/pairing`, `federation/steward-bug-fix`. All single-machine; pairing.test spins two daemons but on loopback. |
| **integration** (real daemon stack in-process — `mountTransports` or `mountDashboard`) | call to mount + HTTP fetch | 28 | Boot a daemon on `port: 0` in the same Node process. Real Express, real EventStore on `:memory:`, real MCP transport. |
| **subprocess-but-not-daemon** (spawns a worker / shim / `gh` / signing tool) | `spawn` / `child_process` outside the bucket above | ~44 | Worker spawner tests, `gh` adapter tests, signing-smoke, host-exec runner. |
| **constructed-component** (real components, DI-mocked externals; uses `:memory:` SQLite) | `:memory:` and no mount | ~43 | The Telegram poller / Notifier / Vault / RSS-watchdog / Steward Executor pattern. |
| **vi.mock-heavy** | uses `vi.mock`, `vi.spyOn`, `vi.fn` | 9 | `dashboard/data/history/commits`, `federation/mdns`, `observability/host-headroom-poller`, `observability/ollama-metrics`, `observability/rss-watchdog`, `security/webauthn`, `steward/executor`, `steward/providers/ollama`, `workers/shell`. |
| **pure unit** (no mock, no construction, no FS, no SQLite) | residual | ~70 | Type shape, string formatters, scope-matcher, hash helpers, etc. |

**Key implications:**

1. The "1614 tests are green" reads as much better than it is for *deployed*
   defects. The integration depth is **single-process, loopback,
   ephemeral-port, in-memory SQLite**. That is the exact slice that doesn't
   catch dependency-resolution bugs (wincred), service-install bugs (the
   "double-click installer" path from Phase 2 BOM is untested), or
   true cross-machine federation faults.
2. The 4 real-subprocess tests are valuable but narrow: bind hardening,
   pair handshake, and a steward bug-fix regression. The corpus has
   **no real-subprocess test for** the dashboard, MCP transport leak,
   Tier-3 gate end-to-end, or notifier-actually-delivering.
3. `vi.mock` discipline is deliberately rare and that's a **strength**, not
   a gap — but it means the suite is bottlenecked on what the in-process
   harness can exercise.

---

## §2 CI / automation inventory

There are **4** workflows in `.github/workflows/`. The BOM's "Note
`daemon-sea.yml`" — **that file does not exist in this repo**. Either it
hasn't been written yet or it was removed; in any case, no SEA-bundled
daemon CI is present today. Flag as a discrepancy for operator review.

| Workflow | Trigger | What it runs | Wall-time guard | Catches |
|---|---|---|---|---|
| `ci.yml` | push to `main` + every PR | `npm ci` → `tsc --noEmit` → `npx vitest run` → `npm run build` → verifies `dist/cli.js`, `dist/server.js`, `dist/shim.js`, `dist/daemon.js` exist. Matrix: `ubuntu-latest` × `windows-latest`. | `timeout-minutes: 15` | Type errors, the 1614 vitest cases, and **that the build emits four expected entrypoints**. Does NOT run the smoke scripts under `scripts/smoke/` or `tmp/perf/peer-smoke.mjs`. Does NOT install the built artifact and run it. |
| `soak.yml` | weekly cron (`0 4 * * 0`) + manual dispatch | `npm ci` → `npm run build` → `npx vitest run tests/soak --reporter=verbose` with `STAVR_RUN_SOAK=long`, `STAVR_SOAK_RSS_CEILING_MB=600`. Ubuntu only. Uploads heap snapshots on failure (14-day retention). | `timeout-minutes: 45` | The single `tests/soak/leak-soak.test.ts` case (long mode = 100k events + 1000 dashboard fetches). **Asserts** `rss_max < 600 MB` and `eventCount ≤ 7500` after retention. **Does** assert on memory growth — but only ceiling, not growth-shape (no slope check, no leaked-session count, no SSE-tap leak). |
| `governor-build.yml` | push/PR touching `governor/**` or this file | Rust matrix: `win-x86_64`, `win-aarch64`, `macos-aarch64`, `linux-x86_64`. `cargo test` on native targets + `cargo build --release`. Uploads binaries (14-day retention). | per-job default | Rust compile errors + Rust unit tests + cross-target build. |
| `governor-release.yml` | tag push `v0.6.5*` + manual dispatch | Full matrix incl. macos-x86_64. `cargo build --release --locked`, CycloneDX SBOM, cosign keyless sign of binary + SBOM, SHA256SUMS, upload to GitHub Release + 90-day workflow artifact. | per-job default | Release-artifact shape; cosign + SBOM signing. **Does not verify the installer actually installs.** |

**Cross-machine / multi-node job:** **none**. No matrix job has two daemons
talking to each other; no job exercises the `peer-smoke.mjs` flow even
in autonomous form; no job installs a built artifact on a clean target and
boots it (the Phase 2 BOM's "install smoke" is operator-supervised manual
work). Anything federation-shaped that isn't a `mountTransports({port:0})`
in-process test goes uncovered in CI.

**Soak-workflow growth-assertion detail:** `leak-soak.test.ts` checks
`maxRss < 600 MB` and `finalCount ≤ 7500` after retention. **It does not
check**: (a) heap delta start→end, (b) whether `broker.sessionCount()`
returns to baseline (the v0.6.x leak signature), (c) whether the SSE-tap
gauge drops back to 0, (d) any per-class object growth from heap snapshots
(the snapshots are dumped on failure but no automated diff). The
`tests/transports/oneshot-mcp-leak.test.ts` *does* check baseline-return
and a heap delta bound, but it runs in the regular matrix at small scale,
not in the weekly soak.

---

## §3 Ad-hoc perf / load assets

`tmp/perf/` contents:

| Asset | LoC | Purpose | Asserts? | Salvage value |
|---|---:|---|---|---|
| `load-runner.mjs` | 240 | Multi-mode synthetic load harness (`mcp_request`, `sse_churn`, `mixed_rw`, `page_nav`). Configurable RPS per mode. Per-endpoint p50/p95/p99/max latency. Writes CSV time-series + JSON summary. Polls `/dashboard/api/diagnostics/memory` per window. | **No.** Logs + emits artifacts; operator reads. | **High.** Already has the right shape for the soak layer — composable modes, structured output, sample-window sampling, memory tap. Needs: assertion thresholds, seeded workload, integration as a job that runs against a daemon (not just left in `tmp/`). |
| `freeze-probe.mjs` | 146 | Per-page server-side render-latency probe + SSE event-rate sampler + optional nav-stress mode. Writes `tmp/perf/freeze-probe-summary.json`. | **No.** Phase 0 of v0.6.11 plans-page freeze investigation. | **Medium.** Tight, single-purpose. Useful as a building block for a "page-render SLO" oracle layer; not the soak harness itself. |
| `peer-smoke.mjs` | 324 | Two-instance federation smoke. Spawns peer-a + peer-b with isolated `STAVR_HOME` + pre-seeded `peers.yaml`, waits for `/healthz`, asserts mutual visibility on `/api/federation/peers`, asserts `/api/federation/health` shape, asserts `/dashboard/family-mode` + `/dashboard/about` render, asserts auth endpoints respond. **Real asserts, exit code carries pass/fail.** | **Yes — the only asserting peer-rig in the tree.** | **High — this is the seed of Layer (a).** It's already structured as `record(name, ok, detail)` + summary JSON. Lift it from a `tmp/` one-shot into either: (i) a CI job behind a `STAVR_RUN_PEER_SMOKE=1` gate, or (ii) the Phase 1 of the topology-virtualization rig. |
| `spin-peer.ps1` | 78 | Manual single-peer launcher with isolated HOME + minimal `peers.yaml` seed. | n/a (operator tool) | **Low.** Useful for human reproduction; superseded by anything that spawns >2 peers programmatically. |
| `PHASE_10A_README.md` | 87 | Documents the v0.7 Phase 10a verification approach + what was deferred to Phase 10b (operator-supervised 90-min sustained load + real WebAuthn + true multi-machine). | n/a | Reference. The "deferred to Phase 10b" list is essentially the gap analysis. |
| `phase7-*.json` + `phase7-timeseries.csv` + `phase7-summary.json` + `freeze-probe-summary.json` | n/a | Captured outputs from past runs. | n/a (output artifacts) | **None for the rig** — these are historical snapshots, useful as baseline reference for what "healthy" looked like in v0.6.11 Phase 7. |

Related but outside `tmp/perf/`:
- `scripts/leak-repro.ts` — pumps 50k events + 200 dashboard fetches against
  an in-process daemon, captures 3 heap snapshots, writes a JSON summary.
  Mirrors the soak test's structure but with explicit heap-snapshot points.
  **No asserts** — operator reads the summary.
- `scripts/smoke/*.{ps1,sh}` — six shell-script smokes for bind (A1),
  pairing (A2), steward bug-fix (C1) on each platform. Single-shot
  shell-level integration; not wired to CI.

**Net assessment of `tmp/perf/*`:** It's **closer to a harness than to
scratch**. The `load-runner.mjs` API + `peer-smoke.mjs` asserts are
both reusable. What's missing is a containing structure: a workflow that
runs them, oracles that decide pass/fail beyond the smoke's per-endpoint
checks, and a way to compose them (peer smoke + load runner against the
same peers).

---

## §4 Escaped-bug → coverage map

For each defect named in the BOM, what *should* have caught it, and why the
existing suite did not:

| # | Defect | What layer would have caught it | Why the current suite missed it |
|---|---|---|---|
| 1 | **Telegram approval poller never wired** in production | An **e2e startup test** that boots the daemon with `STAVR_TELEGRAM_BOT_TOKEN` set, mocks the Telegram HTTP at the LAN edge (a local fake-Telegram), and confirms a `getUpdates` call lands within N seconds. | `tests/notify/telegram-poller.test.ts` is 11 cases deep on `pollOnce()` correctness, transport injection, directive routing, self-approval refusal. But every case constructs `TelegramPoller` directly and calls `pollOnce()` — there is no test that *boots the daemon* and checks "does the poller's timer actually start?" The wiring seam is `src/notify/wiring.ts` × `src/cli.ts` (server-start), and that path is exercised only via `tests/notify/wiring.test.ts` (which mocks the poller class). The constructed-component pattern hides bootstrap omissions. |
| 2 | **`wincred ^1.1.6` declared dependency that never existed on npm** | A **release/install integration test** that runs `npm ci` (not just `npm install`) on a clean cache against the published `package-lock.json` and confirms the resolution. Alternatively, a **post-build smoke** that boots `dist/cli.js daemon start` on a clean install. | `package.json` declares `wincred ^1.1.6` under `optionalDependencies`; `package-lock.json` has it as `{ "optional": true }` with no resolved version (verified). `tests/credentials/vault.test.ts` exists but does not touch the OS keychain — it round-trips the AES-GCM math on a buffer. CI's `npm ci` succeeds because the dep is *optional*; the failure surface is "OS-keychain unavailable, falls back to master-key file, emits `credential_unsafe_storage`" — which is by design. The phantom-dep specifically would only bite a user who *expected* the keychain path to work. No test asserts on the keychain origin (`KeyOrigin === 'os-keychain'`). |
| 3 | **MCP transport built with no `eventStore`, silently losing in-flight calls** | A **resume-with-since-event-id contract test** over the *production* `StreamableHTTPServerTransport` construction — drop the SSE, reconnect with `Last-Event-Id`, assert no events lost. Verified via `src/transports.ts:782` — the production construction passes `{ sessionIdGenerator: () => randomUUID() }` only; **`eventStore` is not set**. | `tests/chaos.test.ts` covers disconnect+resume via the broker's own `since_event_id` replay, which uses the EventStore — but that's *broker-level* replay via the `subscribe_to_events` tool, not SDK-level transport-replay. The SDK's `eventStore` mechanism is what handles in-flight RPC calls during a transport drop, and **no test exercises it because production never wires it**. The test mirrors production, so both are silently wrong together. |
| 4 | **Federation merged but never worked cross-machine** | The full **topology-virtualization layer** — two real daemons on simulated separate hosts (containers / VMs / two ephemeral IPs) with mDNS or explicit `peers.yaml`. | `tests/federation/pairing.test.ts` spawns two real daemons but **both on `127.0.0.1`**. The 10 federation test files cover unit semantics (peer registry merge, mdns reflector, scope matcher). `tmp/perf/peer-smoke.mjs` is the closest thing — two real processes, mutual visibility, real `/api/federation/health` — but it is **(a) not in CI**, **(b) same-host two-port**, **(c) skipped on the canonical hand-off as "deferred to Phase 10b operator-supervised"**. The real failure shape (mDNS doesn't cross LAN segments, peer.yaml hostname resolution differs on Windows, etc.) cannot be reproduced on a single host. |
| 5 | **`/status` reported a stale version** | A **post-build smoke** that runs `dist/cli.js status` (or hits `/status`) and parses out the version, asserting it equals `package.json#version` from the same build. | `tests/dashboard/build-versions.test.ts` covers `buildCopyString` formatting given inputs. `snapshotBuildVersions()` reads `package.json` and git SHA at runtime; the test passes by construction. The real defect was that an older artifact / older read path was being used in some surface — a build-output assertion (does the *built* `dist/cli.js status` print the expected version on a clean checkout-of-tag) was never added. |
| 6 | **v0.6.x memory leak** (McpServer + transport retained per stateless POST) | `tests/transports/oneshot-mcp-leak.test.ts` already exists (added as the regression guard) and is the right shape for *that* leak. The broader gap: any future leak that isn't this exact shape (worker spawn leak, scope-grant cache leak, etc.) needs a generic oracle layer — "broker.sessionCount returns to baseline after burst" applied across many burst patterns. | The original bug existed for months because the burst pattern (rapid stateless POSTs without `initialize`) wasn't in any test. Catching the next leak requires either (a) running every meaningful workload past a baseline-return assertion, or (b) a heap-snapshot-diff oracle that runs on every PR. Neither exists. |
| 7 | **family-mode-phase-1 self-approval hole** | An **adversarial decision-respond** test: actor X opens a decision; actor X (impersonating, or via the actor's own daemon path) attempts to approve it; expect refusal + `decision_self_approval_rejected` event. | `tests/security/respond-to-decision-validation.test.ts` covers exactly this (12 cases on self-approval refusal, identity verification, NULL `source_agent` handling, audit-event emission). **This one was caught after-the-fact** and the regression now has good coverage. The systemic gap: how do we know there aren't more "X can do thing X shouldn't" holes in *other* gates? An adversarial-fuzz layer that enumerates (actor, tool, target) tuples and asserts the gate's decision matches a declarative policy table would generalize. |

**Pattern:** 5 of 7 defects required **either a real built artifact** or
**a real cross-process / cross-machine setup** to detect. The 1614-case
suite is dense in component-level behaviour but thin on
"deployment-shape" verification. Defect #7 is the outlier — caught by an
adversarial property — and it's the model for what the broader gate
suite needs.

---

## §5 Five-layer rig assessment

### (a) Topology virtualization — multi-daemon federation on simulated LAN/WAN

**What exists:**
- `tmp/perf/peer-smoke.mjs` — 2 daemons, same host, two ports, pre-seeded
  `peers.yaml`, real asserts on mutual visibility + federation health.
- `tmp/perf/spin-peer.ps1` — manual single-peer launcher for a 2nd daemon.
- `tests/federation/pairing.test.ts` — 2 daemons via tsx spawn, loopback,
  full pair → token → revoke flow asserted.
- `tests/federation/bind.test.ts` — single daemon via tsx spawn, bind /
  auth-gate refusal asserts.
- Component-level federation tests (peer-registry, mdns reflector,
  peer-client) covering merge semantics.

**What's missing:**
- Anything `n > 2` (the relay-hub topology assumes ≥3 peers).
- Anything that crosses an actual network namespace / hostname boundary
  (Docker containers, network namespaces, two interfaces on a host).
- LAN-segmentation behaviour (mDNS doesn't cross subnets — never tested).
- Pairing over the loopback shortcut vs over a real LAN address.
- Operator-identity propagation across peers (ADR-042).
- WAN-edge behaviour: NAT, asymmetric latency, packet loss.

**Effort:** **L.** The bones are there in `peer-smoke.mjs` but lifting it
to a containerized N-peer topology (per the BOM's "relay-hub federation
on simulated LAN/WAN") is substantial work — Docker Compose or
network-namespaces driver, per-peer logs aggregation, shared assert
infrastructure. The half-step (lift `peer-smoke.mjs` into CI as a
2-peer same-host job) is **S** and would already catch the
"federation never worked cross-machine" class of defect for the
loopback-2-port slice.

### (b) Fault injection / chaos

**What exists:**
- `tests/chaos.test.ts` — 2 cases. (A) decision-survives-daemon-kill via
  in-process close-and-reopen of the EventStore + replay sweep; (B)
  multi-client SSE disconnect + `since_event_id` resume via broker.
- `tests/observability/rss-watchdog.test.ts` — fake-scheduler, fake
  `memoryUsage`, fake `writeHeapSnapshot`, fake `mkdir` — fully unit-level,
  including a `'disk full'` synthetic error injected via mock.
- `tests/daemon/test-bypass-guard.test.ts` — checks stale-PID detection.

**What's missing:**
- **Real process kills.** `chaos.test.ts` simulates SIGKILL by calling
  `store.close()` — that's the in-process equivalent but doesn't exercise
  PM2 restart, governor watchdog, port-rebind on restart, child-process
  reap.
- **`netem` / `tc qdisc` / `toxiproxy`** — zero presence. Latency, loss,
  partition, jitter are not injectable.
- **Disk-full**, **clock skew**, **filesystem permission flips** —
  unexercised. `rss-watchdog` mocks `'disk full'` as a thrown string;
  no test mounts a tmpfs with a real quota or freezes a clock.
- **Projection corruption** — no test deliberately mutates the SQLite
  projection out of band and verifies the daemon's rebuild path. The
  Phase 2 BOM mentions "the SQLite projection rebuilds correctly from
  the event log" as a verification gate, but no test enforces it.

**Effort:** **M.** Process-kill harness (spawn the real CLI, SIGKILL it,
verify recovery on restart) is **S** and can be built on top of the
existing tsx-spawn pattern from `tests/federation/bind.test.ts`. Network
chaos (`netem` on Linux, `clumsy` on Windows, or `toxiproxy`) is **M** —
needs cross-platform abstraction or Linux-only CI job. Disk/clock chaos
is **M** — Linux-only via cgroups / `libfaketime`.

### (c) Adversarial load / fuzz

**What exists:**
- `tests/security/respond-to-decision-validation.test.ts` — adversarial
  hand-crafted cases for self-approval (the model for what a fuzz layer
  would do programmatically).
- `tests/security/host-exec-*.test.ts` — allowlist denial cases.
- `tests/trust/forbidden.test.ts`, `tests/trust/outside-scope.test.ts` —
  scope-violation cases.
- `tmp/perf/load-runner.mjs` — synthetic load (not adversarial; well-formed
  RPCs at varying RPS).

**What's missing:**
- **Property-based / fuzz framework.** No `fast-check`, no `jsverify`. No
  test generates random inputs to find boundary failures. No JSON-RPC
  parser fuzz (malformed envelopes, oversized payloads, recursive
  structures, unknown methods).
- **Session-churn under attack.** `oneshot-mcp-leak.test.ts` does ~200
  malformed stateless POSTs in a tight loop. There's no test that does
  10 k forged-actor POSTs with rotating fake bearer tokens.
- **Decision-respond table coverage.** The 12 self-approval cases are
  hand-picked. An enumerated `(actor, decision_source_agent,
  scope_state) → expected_outcome` table executed as a fuzz would
  generalize.
- **Scope-gated tool-call enumeration.** Today each tool has hand-written
  scope tests. An "enumerate (tool, scope, actor) tuples and assert
  resolution matches the categories.ts default" generative test does
  not exist.

**Effort:** **S.** Adding `fast-check` and writing 2–3 properties per
critical gate (decision-respond, host-exec allowlist, tool-call scope
resolution, MCP envelope parsing) is a few days of focused work and
high-yield.

### (d) Soak / endurance

**What exists:**
- `tests/soak/leak-soak.test.ts` (the only file). Short mode:
  10 k events + 100 dashboard fetches. Long mode: 100 k + 1000.
  Asserts `maxRss < 600 MB` and `finalCount ≤ 7500` after retention.
  Captures heap snapshots at start + end.
- `soak.yml` weekly + manual dispatch. Uploads heap snapshots on failure.
- `tmp/perf/load-runner.mjs` (uncalled by CI).
- `scripts/leak-repro.ts` (uncalled by CI).

**What's missing:**
- **Growth-shape assertions.** Current soak checks ceiling only; no
  slope check, no "RSS at t=10min vs t=40min" delta, no per-class object
  growth from heap-snapshot diff.
- **Event-loop lag tracking.** `tests/observability/event-loop.test.ts`
  exists but unit-level; soak doesn't sample lag.
- **Multi-workload soak.** Today the soak pumps events + fetches dashboard
  in serial. `load-runner.mjs`'s 4-mode composable workload is what the
  soak should be running. Wiring it up: pre-existing harness, missing
  wrapper.
- **SSE-tap / broker-session leak under soak.** `oneshot-mcp-leak.test.ts`
  checks baseline-return for one burst pattern; soak should check it for
  the full mixed workload.

**Effort:** **S–M.** The soak workflow exists, the load harness exists,
the leak-repro snapshot pattern exists. Composing them — running
`load-runner.mjs` for 30/60/90 min in CI with assertions on growth
shape + baseline-return + heap-diff — is small-to-medium work.

### (e) Oracles / continuous invariant checks

**What exists:**
- The single-shot asserts in `oneshot-mcp-leak.test.ts`
  (`broker.sessionCount() ≤ baseline + 1`) and `leak-soak.test.ts`
  (`rss_max < ceiling`, `finalCount ≤ 7500`).
- Implicit invariants tested by component tests (scope-graph integrity,
  trust-scope expiration, retention sweep behaviour).

**What's missing:**
- **Hash-chain integrity oracle.** ADR-036 is *proposed* — `prev_hash`,
  `event_hash`, `signature` columns are absent from `src/persistence.ts`;
  no `stavr audit verify` command exists; no test. This is the **single
  largest invariant gap** because the audit log is the artifact stavR
  exists to produce.
- **Projection ≡ log-replay oracle.** No permanent test that wipes the
  projection, rebuilds from the event log, and asserts equality. The
  Phase 2 BOM mentions verifying this once, but it's not in `tests/`.
- **No-orphan oracles.** No test that asserts "every revoked scope leaves
  no live grant", "every closed session removes its broker entry", "every
  expired decision has a `decision_late_response` event".
- **Continuous run.** Oracles today run inside individual tests and fire
  once. The hardening rig wants oracles that run *during* the load, not
  only at end.

**Effort:** **M.** Hash-chain oracle is gated on ADR-036 implementation
(out of scope for the rig itself but the rig's deliverable). Projection-
rebuild oracle is **S** once a "rebuild from log" function exists.
No-orphan oracles are **S** but multiplicative — one per invariant.

---

## §6 Oracle / invariant audit

What invariants are asserted *anywhere* today, and what is *unenforced*:

**Asserted (somewhere):**
- Decision-respond: actor ≠ decision.source_agent when
  source_agent is non-null (`tests/security/respond-to-decision-validation.test.ts`).
- Trust-scope expiration: revoked scopes no longer match
  (`tests/trust/expiration.test.ts`, `tests/trust/revoke.test.ts`).
- Retention sweep: op-class events bounded after sweep
  (`tests/soak/leak-soak.test.ts` + `tests/observability/retention.test.ts`).
- SSE session baseline return after burst
  (`tests/transports/oneshot-mcp-leak.test.ts`).
- Bind hardening: non-loopback bind without auth hard-fails
  (`tests/federation/phase5-bind-and-fence.test.ts`).
- Federation health endpoint shape (`tmp/perf/peer-smoke.mjs` — not in CI).
- Self-approval emits `decision_self_approval_rejected` audit event.

**Unenforced / missing:**
- **Event-log hash chain intact across writes (ADR-036).** Not
  implemented. The columns don't exist; no walk; no `stavr audit verify`.
- **SQLite projection ≡ event-log replay.** No permanent test (the
  Phase 2 verification was one-off, per the BOM's framing).
- **No orphaned broker sessions after teardown.** `oneshot-mcp-leak`
  covers one burst pattern; not generalized.
- **Worker lifecycle: every spawned worker reaches a terminal state.**
  `tests/workers/watchdog.test.ts` covers the watchdog; no rig-level
  "no zombies after the chaos run" oracle.
- **Notification dispatch: every `decision_required` with a configured
  channel produces a `notification_dispatched` event.** Per-channel tests
  exist; the cross-cutting "for every decision, find the matching
  dispatch" oracle does not.
- **Trust scope grant ↔ revoke parity.** No oracle that walks the events
  table and asserts every `scope_grant` is matched by either an active
  scope row, a `scope_revoke`, or a `scope_expired`.
- **Federation peer state: every `peer_unreachable` is followed by either
  `peer_reachable` or a manual operator action within timeout.**
  Component tests exist for peer-client retry; no end-to-end oracle.
- **`/healthz` ↔ actual readiness.** No oracle that confirms a 200 from
  `/healthz` implies all subsystems (notifier, federation, steward,
  workers) are actually live.

**The "event log smoke" reference:** the BOM cites a Phase 2 one-off
"event-log smoke" — grep confirms **the only mentions are in
`proposed/family-mode-phase-2-bom.md` line 98** ("the SQLite projection
rebuilds correctly from the event log") and the recon BOM itself.
There is no committed test or script implementing it. Treat as a
historical operator verification, not as an enforced invariant.

---

## §7 Reproducibility check

**Seeded randomness:** **none.** Grep across `tests/` and `tmp/perf/` for
`seedrandom`, `seed.*random`, `prng`, `fast-check`, `jsverify`, `fuzz`
yields zero hits. No test or load asset uses a seedable PRNG. Workload
generators (`load-runner.mjs`'s round-robin endpoint pickers, the soak
test's serial event pump) are deterministic *by construction* (no
randomness used), not *by seed*. The chaos tests use
`mkdtempSync(join(tmpdir(), 'stavr-chaos-'))` for per-run isolation,
which gives fresh paths but not seed-deterministic behaviour.

**Replayability of a failure:** **low.** A soak failure dumps heap
snapshots; an operator can diff them — but the *event sequence* that
produced the failure is recoverable only via the SQLite WAL of the
soak's tmp dir, which is destroyed on test teardown. There is no
"capture event stream → replay against fresh daemon" capability.

**Implication for the rig:** every adversarial / chaos / soak job that
the rig introduces needs a seed input (env var:
`STAVR_HARDENING_SEED=<int>`) that fans out to all RNGs, plus
preserved-on-failure artifact capture (event-stream dump, last 100
heap-snapshot deltas, network-impair config, peer-state YAMLs). Otherwise
hammering produces failures the operator cannot reproduce — which is
worse than no test, because it consumes operator hours triaging noise.

---

## §8 Sensitivity & cross-cutting observations

1. **The harness gravity is "in-process loopback".** That's not wrong —
   it's fast, deterministic-ish, and gets you to 1614 cases without CI
   pain. But it is **structurally incapable** of catching defects in the
   wiring seam between `mountTransports()` and the launched daemon, in
   the install/build/package layer, or in any peer-to-peer interaction.
   The rig's job is to plug those three slots, not to add more
   in-process tests.

2. **The `tmp/perf/` assets are operationally orphaned.** They were
   built for specific verification windows (v0.6.11 memory leak,
   v0.7 federation Phase 10a), produced their output, and are
   unowned. The cheapest defensive move available is **lift
   `peer-smoke.mjs` into CI as an opt-in job (`STAVR_RUN_PEER_SMOKE=1`)**;
   that single move would have caught defect #4 (federation never
   worked cross-machine) for the loopback-2-port slice.

3. **`vi.mock` is correctly used sparingly.** Don't expand mocking
   discipline; that's not the gap. The gap is *layers above* the
   in-process integration tier.

4. **The Governor pipeline (`governor-build.yml` + `governor-release.yml`)
   is the closest model for what the daemon needs.** Matrix build,
   signed artifacts, SBOM, verification helper. The daemon side has
   `tests/release/install-from-release.test.ts` for the **scripts'**
   shape — but no equivalent "install the daemon's built artifact on a
   clean target and boot it" job. That's the install-smoke half of
   defect #2 + defect #5.

---

## §9 Recommended scope shortlist (seed for the 10-3-1)

Three sizing options, lightest-to-heaviest, each with a concrete first
slice. **The oracle layer (e) lands first in every option** — without
it, chaos and soak produce findings the operator cannot interpret.

### Option α — Minimal (≈ 1 week, ~S+S+S)

1. **Lift `tmp/perf/peer-smoke.mjs` into CI** behind
   `STAVR_RUN_PEER_SMOKE=1`, run on every PR with a 5-min ceiling.
   Catches the loopback-2-port slice of defect #4.
2. **Add an install-smoke job to `ci.yml`**: after `npm run build`, run
   `node dist/cli.js daemon start --port 0` in the background, hit
   `/status`, parse the version, assert it equals `package.json#version`,
   kill. Catches defect #5 and a chunk of defect #2.
3. **Wire `eventStore` into `StreamableHTTPServerTransport`** in
   `src/transports.ts:782` and add a chaos-test case that drops the SSE
   mid-RPC, reconnects with `Last-Event-Id`, asserts no events lost.
   Catches defect #3.

### Option β — Targeted (≈ 2–3 weeks, S+M+S)

Everything in α, plus:

4. **Adversarial fuzz layer** (`fast-check` + 6–10 properties):
   decision-respond (actor × source_agent × scope), host-exec allowlist,
   tool-call scope resolution, MCP envelope parsing. Generalizes defect
   #7 to other gates.
5. **Soak workflow upgrade**: replace serial event pump with
   `load-runner.mjs --modes mcp_request,sse_churn,mixed_rw,page_nav`,
   add growth-shape assertions (RSS slope, baseline-return for broker
   sessions + SSE taps), add seeded RNG via
   `STAVR_HARDENING_SEED`. Reuses existing harness; no new infra.
6. **Implement projection ≡ log-replay oracle** as a permanent test,
   not a one-off. Wipe projection, replay, assert equality.

### Option γ — Full rig (≈ 6–10 weeks, L+M+M)

Everything in α and β, plus:

7. **Topology virtualization rig** (the (a) layer proper): Docker
   Compose with 3–5 peers across 2 network namespaces, simulated
   latency + loss via `netem`, mDNS-blocked subnets to force
   `peers.yaml`-only discovery. Built on top of `peer-smoke.mjs`'s
   assert harness.
8. **Process-kill + restart chaos** (the (b) layer for processes):
   SIGKILL the daemon mid-load, verify the governor watchdog restarts
   it, verify decisions in flight are recovered by
   `startupDecisionSweep`, verify SSE clients reconnect cleanly.
9. **Implement ADR-036 (hash-chain + Ed25519 signing)** and add the
   chain-integrity oracle to every soak / chaos run. This is the audit
   invariant stavR's positioning depends on; the rig's
   "tamper-evident audit log" promise has no enforcement today.

**Operator decision points for the 10-3-1:**
- Is the audit log's tamper-evidence (ADR-036) a v1 promise or v2? That
  decides whether γ#9 is in scope for this rig cycle or its own cycle.
- Is true cross-machine federation testing earning its keep in CI cost,
  or is the loopback-2-port slice (α#1) enough until the federated-stavR
  market story is in front of users? That decides between α + β and γ.
- Is install-smoke (α#2) extended to *all* supported platforms
  (Windows MSI from the family-mode-phase-2 BOM) or only `dist/cli.js`?
  That governs the size of α.

---

## End of recon

Single-document, read-only deliverable per BOM. No tests, workflows, or
source files modified. The operator's review gates any rig work.
