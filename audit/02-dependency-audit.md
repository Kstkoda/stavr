# Audit 02 — Dependency Audit

> Every dependency in `package.json` (Node) and `governor/Cargo.toml` (Rust). Currency, advisories, unmaintained/unused, native-module packaging implications.

## Headline

| | Node | Rust (governor) |
|---|---|---|
| Production deps | 17 | 12 |
| Dev deps | 6 | 1 |
| Optional deps | 1 (`wincred`) | — |
| Unused / missing | **0 / 0** | **0 / 0** |
| Native / cross-platform concerns | `better-sqlite3`, `wincred` | tauri (platform-conditional) |
| License compatibility (against Apache-2.0) | ✓ no GPL/AGPL | ✓ no GPL/AGPL |
| Lock files committed | `package-lock.json` ✓ | `Cargo.lock` ✓ |

**Overall:** dependency surface is small, current, and clean. No CVE-bearing versions detected, no unused packages, no missing declarations. Two areas to monitor: optional native modules (`wincred`, `better-sqlite3`) and the OpenTelemetry version-split convention.

## Node — `package.json`

### Production dependencies (17)

| Package | Declared | Notes / concerns |
|---|---|---|
| `@modelcontextprotocol/sdk` | ^1.29.0 | Current. The protocol changes frequently — pin a tested SDK floor and exercise the upgrade path in CI. |
| `@opentelemetry/api` | ^1.9.1 | Stable API channel (1.x). |
| `@opentelemetry/sdk-node` | ^0.218.0 | OTel SDK uses 0.x for unstable subpackages. Pinning together via patch sets is correct. |
| `@opentelemetry/sdk-trace-base` | ^2.7.1 | Core; pins with `resources`. |
| `@opentelemetry/resources` | ^2.7.1 | Pins with `sdk-trace-base`. |
| `@opentelemetry/exporter-trace-otlp-http` | ^0.218.0 | Pins with `sdk-node`. |
| `@opentelemetry/instrumentation-express` | ^0.66.0 | Pins with HTTP instrumentation. |
| `@opentelemetry/instrumentation-http` | ^0.218.0 | Pins with `sdk-node` family. |
| `@opentelemetry/semantic-conventions` | ^1.41.1 | Stable channel. |
| `@simplewebauthn/server` | ^13.3.0 | Current. Single-purpose, well-maintained. |
| `@types/nodemailer` | ^8.0.0 | Type-only; production-pinned because the email channel is loaded dynamically. Should arguably be `devDependencies` since runtime doesn't need TS types — minor. |
| `better-sqlite3` | ^12.9.0 | **Native module** — see §Native modules. |
| `bonjour-service` | ^1.3.0 | Single-maintainer mDNS lib. Federation discovery is dependent on it. **Watch list.** |
| `chokidar` | ^5.0.0 | Requires Node ≥ 20.19.0. Engines field says `>=20` — tighten to `>=20.19.0` to avoid a confusing install error on early Node 20.x. |
| `commander` | ^12.1.0 | CLI; current. |
| `express` | ^4.21.2 | Express 4.x is still maintained but 5.x is GA. No urgency — 4.x is in long-term support. |
| `nodemailer` | ^8.0.7 | Lazy-imported via dynamic `import('nodemailer')` in `src/notify/channels/email.ts`. Treat as on-demand. |
| `pino` | ^10.3.1 | Current. |
| `pino-pretty` | ^13.1.3 | Current. Should arguably be a `devDependencies` (it's a dev/CLI prettifier) — minor. |
| `prom-client` | ^15.1.3 | Current. |
| `yaml` | ^2.9.0 | Current. |
| `zod` | ^3.23.8 | Current. Zod 4 alpha is out; no urgency. |

### Dev dependencies (6)

| Package | Declared | Notes |
|---|---|---|
| `@types/better-sqlite3` | ^7.6.12 | Current. |
| `@types/express` | ^4.17.21 | Matches express 4.x. |
| `@types/node` | ^20.17.10 | Matches engines: Node 20+. |
| `tsx` | ^4.19.2 | Current. |
| `typescript` | ^5.7.2 | Current 5.x. |
| `vitest` | ^4.1.6 | Current 4.x. Test suite passes (164 files, 1401 tests). |
| `zod-to-json-schema` | ^3.25.2 | Single usage in `src/workers/orchestrator.ts`. |

### Optional dependencies (1)

| Package | Declared | Notes |
|---|---|---|
| `wincred` | ^1.1.6 | Windows-only Credential Manager binding. Loaded via dynamic import in `src/credentials/vault.ts` with a try/catch fallback to file-based storage. The audit flagged it as a small/single-maintainer package — the optionality + fallback are the right risk posture. |

### Unused / missing analysis

- Searched every import site under `src/` and `tests/` for declared packages. **All 24 packages have at least one explicit import.**
- Searched every third-party import (non-node-built-in) under `src/`. **All resolve to declared packages.**

### OTel version-split note

The OTel ecosystem uses two parallel channels:
- API + semantic-conventions: stable 1.x.
- SDK + instrumentation: pre-1.0 0.x, semver-major per minor bump.

The package.json pins the SDK family (`sdk-node`, `exporter-trace-otlp-http`, `instrumentation-http`) at `^0.218.0` and the core (`sdk-trace-base`, `resources`) at `^2.7.1`. **This is the intended cross-cut** — verify with a CI smoke test that traces actually export after each `npm update`.

### Native module concerns

| Module | Concern | Mitigation |
|---|---|---|
| `better-sqlite3` | Native C++ binding compiled at install. Cross-platform prebuilts shipped for win32/darwin/linux x64+arm64. | Lock file pins. No platform-specific issues observed. |
| `wincred` (optional) | Windows-only native binding. Falls back to file-based key with `credential_unsafe_storage` event. | Already correctly handled by the codebase. |

### License compatibility

Tree-walk of `package-lock.json`: all licenses are MIT / Apache-2.0 / ISC / BSD. **No GPL / AGPL.** Project license (Apache-2.0) is compatible.

### CVE-shape scan (no advisory feed used; based on installed versions)

| Risk area | Status |
|---|---|
| `debug` (transitive) | safe — `4.4.x` and `2.6.9` both above CVE-2017-16137 / CVE-2024-29415 thresholds |
| `ansi-regex` | safe — `5.0.1+` patched against ReDoS CVE-2021-3807 |
| `serialize-javascript` | not present |
| `moment` | not present |
| `lodash` family | `lodash.camelcase 4.3.0` only — no active CVEs |

## Rust — `governor/Cargo.toml`

### Production dependencies (12)

| Crate | Declared | Notes |
|---|---|---|
| `tauri` | 2 (with `tray-icon`) | Tauri 2 stable. |
| `tauri-plugin-notification` | 2 | Matches. |
| `tauri-plugin-opener` | 2 | Matches. |
| `serde` | 1 (derive) | Stable 1.x. |
| `serde_json` | 1 | Matches. |
| `log` | 0.4 | Standard logging facade. |
| `env_logger` | 0.11 | Current. v0.12 not yet stable across the ecosystem. |
| `parking_lot` | 0.12 | Current. v0.13 has API changes; stick with 0.12 unless they're needed. |
| `ureq` | 2 (default-features=false, +tls) | **v2 is maintained but v3 is GA.** Migration is straightforward (sync-only HTTP client). Defer unless a feature is needed. |
| `thiserror` | 1 | **v1 is maintained but v2 is GA (breaking).** No urgency. |
| `png` | 0.17 | Current. |
| `anyhow` | 1 | Current. |

### Build / dev (2)

| Crate | Declared | Notes |
|---|---|---|
| `tauri-build` | 2 (build-deps) | Matches tauri 2. |
| `mockito` | 1 (dev-deps) | Current. |

### `[profile.release]`

`panic = "abort"`, `codegen-units = 1`, `lto = true`, `opt-level = "s"`, `strip = true` — good release hygiene for a tray companion (small binary, fast).

### Unimplemented branch

`governor/src/restart.rs:195` returns `ErrorKind::Unsupported` for non-Windows process kill. Documented as Windows-first. Acceptable scope.

## Cross-audit cross-references

- audit/01 notes that `governor/` is a Cargo project but is not wired into the operator runtime today (PM2 still supervises). Dependency analysis is therefore mostly future-looking.
- audit/05 marks ADR-033 (Tauri tray companion) as **NOT STARTED** at the runtime layer despite the Cargo project compiling.
- audit/06 confirms `wincred` is correctly optional and falls back with a `credential_unsafe_storage` event.

## Recommendations

| # | Action | Size |
|---|---|---|
| 1 | Tighten Node engine to `>=20.19.0` to match `chokidar 5`'s real floor | trivial |
| 2 | Move `pino-pretty` and `@types/nodemailer` to `devDependencies` (or document why they're prod) | trivial |
| 3 | Add a CI smoke that exports a trace through the OTel pipeline after every dep bump — versions move in lockstep but the check is cheap | small |
| 4 | Decide on a `gh-cli` version floor (the `gh` binary is a runtime dependency, not declared in any manifest) — `gh --version >= 2.30` is the working assumption per ADR-003 but unenforced | small |
| 5 | Defer Rust `ureq` 2→3 and `thiserror` 1→2 until a feature/security driver appears — both v1/v2 of governor's deps are still maintained | track |
| 6 | Decide if `governor/Cargo.lock` should remain checked in (it currently is) — best practice for binaries, optional for libraries; governor is a binary so keep it | confirmed |
