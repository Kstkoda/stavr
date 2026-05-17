# ADR-039 — Polyglot core: Rust extraction for security-critical paths

**Status:** Proposed
**Date:** 2026-05-17
**Related:** ADR-033 (Tauri tray = Rust), ADR-036 (audit integrity), ADR-038 (supply chain), memory `project_stavr_team_repositioning_decision.md`

## Context

stavR's daemon is entirely TypeScript-on-Node. That's been the right choice for productive iteration: MCP SDK is TypeScript-first, the team is fluent in it, cross-platform behavior is uniform, and the codebase has accumulated significant value (3k+ lines of well-tested orchestration logic, 788 tests passing).

But three security-critical paths now have load-bearing roles where Node's properties become a liability:

**1. Event store hash chain (ADR-036).** The `prev_hash` computation + Ed25519 signing happens on every event insert. Node's crypto is fine (Web Crypto + libsodium bindings), but the entire transactional sequence (read prior hash → compute → sign → insert) runs in JS with all its GC pauses and prototype-poisoning attack surface. If a compromised npm dep replaces `Buffer.from` with a logging variant, every signed event leaks to the attacker.

**2. host_exec allowlist enforcement.** Today the allowlist matcher + arg validators are TypeScript. The matcher walks operator-supplied args, evaluates regex patterns, and decides "allow / deny." Any prototype-pollution bug in a dep could in principle bypass the matcher (no specific CVE today; the surface is there).

**3. Trust scope cap accounting.** Each host_exec call decrements a counter under a transaction. Same risks as above.

The 2026 zeitgeist (and supply-chain incidents discussed in ADR-038) favors **isolating security-critical primitives into a smaller, simpler, memory-safe language with a tiny dependency tree** — typically Rust or Go. Tauri 2 governor (ADR-033) already uses Rust; the ecosystem fit is established.

The team-direction repositioning (memory `project_stavr_team_repositioning_decision.md`) raises the bar for "what can stavR credibly claim about security." A polyglot core where the smallest possible attack surface holds the most sensitive operations is the modern answer.

## Decision

Extract three security-critical subsystems into a **single Rust binary** (`stavr-core`) called from the Node daemon via stdin/stdout JSON-RPC over a long-lived subprocess. Keep everything else in Node.

**Scope of `stavr-core` (initial):**

1. **Event signing + hash chain insertion** — single API: `core.insert_event(event_json) → {row_id, prev_hash, event_hash, signature}`. Reads private key from disk on init (path passed at boot). All hashing + signing in Rust. Inserts into SQLite via `rusqlite` crate.

2. **host_exec allowlist match** — API: `core.check_command(command, args, scope_id) → {allowed: bool, reason?: string, scope_remaining?: {actions, ttl_ms}}`. Loads compiled allowlist at boot from a Node-generated manifest. Performs pattern matching + scope cap decrement atomically.

3. **Trust scope cap accounting** — API: `core.decrement_scope(scope_id) → {ok: bool, remaining: number}`. Sole writer to `trust_scopes.actions_remaining`. Other consumers read via Node.

**Non-scope of `stavr-core` (stays in Node):**

- HTTP/SSE/StreamableHTTP transport layer
- MCP protocol handling
- Dashboard rendering
- Steward subprocess + worker dispatch
- BOM parsing + decision UI
- Event subscriptions / notifications fabric
- GitHub adapter
- Workflow orchestration

The Node daemon owns the data plane and the orchestration plane. `stavr-core` owns the security-decision plane.

**IPC mechanism:**

- Long-lived subprocess started at daemon boot, exits when daemon exits
- JSON-RPC 2.0 over stdin/stdout (proven by language servers, debug adapters, MCP itself)
- Request/response with explicit IDs for matching
- 5 ms p50 latency target for the call (small JSON, in-process pipe — already well under MCP's own internal targets)
- Health-check via `core.ping` every 30s; if no response in 2s, daemon refuses new host_exec calls until restarted
- Rust panic = daemon panic (process exits) — supervised restart by PM2 (or Tauri governor)

**Build + distribution:**

- Rust binary cross-compiled for x86_64-pc-windows-msvc, x86_64-apple-darwin, aarch64-apple-darwin, x86_64-unknown-linux-gnu, aarch64-unknown-linux-gnu
- Bundled with the Node daemon's `dist/` directory (Node calls a known relative path)
- Sigstore-signed alongside Node bundle (ADR-038)
- Single crate, minimal deps: `serde`, `serde_json`, `rusqlite`, `ed25519-dalek`, `sha2`, `regex` — that's it. No async runtime, no HTTP, no network.

**Migration cost / sequencing:**

- Build `stavr-core` v0.1 with just event signing (ADR-036 implementation) — 2 weeks
- Migrate hash-chain insertion to call `stavr-core` — 1 week
- Add allowlist matching to `stavr-core` v0.2 — 1 week
- Migrate host_exec runner to call `stavr-core.check_command` — 1 week
- Add scope cap accounting to `stavr-core` v0.3 — 1 week
- Migrate trust-scope decrement — 1 week

Total: 7 weeks one-shot, OR can be staged across releases. Each subsystem migration is independent — adopt incrementally.

## Consequences

**Positive:**
- Memory-safe (Rust ownership model) for security-critical paths
- ~5 transitive deps in `stavr-core` vs ~300 in Node daemon — supply-chain attack surface reduced by ~60x for the surface that matters most
- Single-purpose binary easier to formally verify or audit (third-party audit per Phase 3 of the 14-week plan)
- Hot path (event signing, allowlist check) gets ~5x faster — Rust crypto is faster than Node's, and the JSON-RPC overhead is negligible vs the actual work
- Trust scope decrement becomes truly atomic (single-writer Rust process, no Node prototype-pollution risk)
- Establishes the pattern for future security-critical work (e.g., a Rust connector verifier, a Rust BOM signer, a Rust pairing protocol implementer)
- Tauri governor + Rust core = consistent toolchain; same Rust devs maintain both

**Negative we accept:**
- Build complexity increases: CI now needs to cross-compile Rust to 5 targets per release (covered by GitHub Actions matrix builds; well-trodden)
- Operator hardware diversity matters more: ARM64 Mac vs x86 Mac vs Windows requires distinct binaries (already needed for Tauri governor anyway)
- Adds Rust as a contributor language — contributors fluent in only TypeScript can no longer touch the security-critical paths. Intentional (smaller circle of changes = smaller attack surface for compromised contributor accounts)
- IPC roundtrip adds latency: ~1-3ms per host_exec call vs ~0.1ms in pure Node. Acceptable for the security gain.
- Failure modes split: a `stavr-core` crash takes down host_exec but not the rest of the daemon — needs clear operator-facing error
- Initial development is 7 weeks of focused work — significant cycle. Tradeoff against the 10/10 bullet-proof + loosely-coupled gains in the 14-week plan.

## Alternatives considered

- **Rewrite the daemon in Rust** — 6+ month rewrite, abandons the productive iteration of the Node codebase, gives only marginal security gain over the polyglot approach. Reject.
- **Use Go instead of Rust** — Go is fine. Rust chosen because (a) Tauri governor already in Rust, (b) better cryptographic library ecosystem (ed25519-dalek is gold-standard), (c) memory safety guarantees stronger than Go (no nil-pointer panics), (d) smaller binaries when statically linked.
- **WebAssembly module loaded into Node** — promising for isolation but the WASM-JS bridge is itself a complex security surface and WASM crypto perf is currently slower than native Rust. Revisit when WASM Component Model matures (~2027).
- **Use a separate Postgres-style server process for the audit DB** — solves the "single writer to events table" problem but doesn't address allowlist matching or scope accounting; would need a custom protocol anyway. Polyglot core is more general.
- **Sandboxing Node itself via Node's `--permission` flag** (stable since v23.5)** — promising direction (stavR could declare a permissions manifest), but only mitigates fs/network access, not in-process JS exploits. Worth adopting in parallel (separate ADR), but doesn't replace the polyglot core for the security primitives.
- **Trust the Node ecosystem and harden via stricter `npm audit` only** — fundamentally bounded by the npm threat model. ADR-038's SBOM + Sigstore + Renovate makes Node safer, but doesn't make it as safe as a 5-dep Rust binary.
- **Use Deno instead of Node** — Deno has stronger permissions model out of the box, but the MCP SDK is Node-first and migrating would lose the existing investment. The polyglot approach lets us keep Node where productive, replace where security demands it.

## Implementation notes (not part of decision)

- Rust crate name: `stavr-core` (single crate, single binary)
- Repository structure: `core/` directory at repo root (sibling to `src/`, `dist/`, `tests/`)
- Build via `cargo build --release --target ...` per platform; CI matrix handles cross-compilation
- Binary embedded in Node `dist/` directory or downloaded by post-install script (deferred decision; depends on Tauri governor's bundling pattern)
- JSON-RPC framing: line-delimited JSON (each request/response on a single line, terminated by `\n`) — simpler than length-prefixed, MCP precedent
- Rust testing: built-in `cargo test` + property-based testing via `proptest` crate for the allowlist matcher (regex coverage)
- Cross-language testing: integration tests in `tests/core/` invoke the actual `stavr-core` binary from Node, verify end-to-end behavior
- For team mode: each operator's keypair lives on their local disk; Rust binary loads only the local operator's key (no team-key complexity in Rust)
- Versioning: `stavr-core` follows daemon version (1:1 release coupling). API is internal; no semver guarantee.

## Acceptance for moving Status to Accepted

This ADR moves to "Accepted" when:
1. `stavr-core` v0.1 exists and is published as a signed binary per ADR-038
2. At least one of the three target subsystems (event signing, allowlist, scope accounting) is fully migrated to call `stavr-core`
3. Cross-language integration tests cover the migrated subsystem
4. Operator docs explain the polyglot architecture so future contributors understand the two-language split
5. Migration plan for the remaining subsystems is documented (timing + dependencies)
