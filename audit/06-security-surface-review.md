# Audit 06 — Security Surface Review

> 5-layer permission model, no-go list, host-exec allowlist, trust scopes, WebAuthn, vault. Where the design and the enforcement diverge.

## Headline

| Concern | Severity | Status |
|---|---|---|
| Layer 1 per-actor tier never checked at tool invocation | **HIGH** | designed in `src/security/actor-permissions.ts`; not called by `src/server.ts:294-301` |
| Tier 3 friction string never wired | **HIGH** | UI labels it; `requireRecentTier3Assertion()` exists at `src/security/tier3-gate.ts:55-102` but no production call site |
| No-go list only enforced via `gatedAction()` wrapper | **HIGH** | universal enforcement missing — connector writes, steward dispatches, worker spawns can bypass |
| Trust scopes have no per-session granularity | **MEDIUM** | a scope granted globally; one Steward session can use a scope granted to another |
| Credential reads not scope-gated | **MEDIUM** | `steward_session_id` stored on grants but never checked at read |
| Append-only event log is not tamper-evident | **MEDIUM** | no hash chain, no signatures — see ADR-036 (proposed, not built) |
| Notification dispatch has no per-channel timeout | **LOW** | promises can be retained indefinitely if a channel hangs |
| Host-exec config can be exploited only by misuse | **LOW** | unknown overrides are correctly ignored — `WARN: host-exec config: override for unknown command 'wget' ignored` observed in test run; fail-closed is correct |

## 1. Five-layer permission model — designed vs enforced

The system claims five layers. Mapping each to its enforcement state:

| Layer | File(s) | Designed gate | Enforcement |
|---|---|---|---|
| **L0 — capability override** | `src/security/capability-overrides.ts` | operator master enable/disable per tool | ✅ enforced at `src/server.ts:294-301` via `RuntimeToolGate.check()` — wraps every tool handler |
| **L1 — per-actor tier** | `src/security/actor-permissions.ts` | tier (AUTO/CONFIRM/EXPLICIT/NO_GO) per (actor, tool) | ❌ **not enforced** — matrix lives in DB, dashboard renders it, but no code path calls `resolve(actorId, toolId)` before invoking the handler |
| **L2 — credential encryption at rest** | `src/credentials/vault.ts` | AES-256-GCM on every secret | ✅ enforced — `encrypt()` called by `src/credentials/store.ts:53,55` |
| **L3 — no-go floor** | `src/trust/no-go-list.ts` | deny-override, scope-proof | ⚠️ partial — `checkNoGo()` called at `src/tools/gated-action.ts:78` only; tools invoked outside `gatedAction()` bypass |
| **L4 — trust scope** | `src/trust/store.ts` | auto-approve scoped action | ✅ enforced — `findActiveScopeFor()` called at `src/security/host-exec-tool.ts:121-148` and `src/tools/gated-action.ts:83-136` |
| **L5 — Tier 3 friction (passkey + typed string)** | `src/security/tier3-gate.ts`, `webauthn.ts`, `webauthn-routes.ts` | passkey present + friction string typed within freshness window | ⚠️ partial — passkey path is wired (registration + assertion endpoints + `tier3_assertions` table); `requireRecentTier3Assertion()` is **never called at tool invocation**; typed friction string is **not implemented at all** |

## 2. No-go list — entries and call sites

`src/trust/no-go-list.ts:31-154` defines 11 entries:

| ID | Severity | Domain |
|---|---|---|
| `fs.rm_recursive_root` | CRITICAL | `rm -rf` outside worktree |
| `git.force_push_default_branch` | CRITICAL | force-push to main/master |
| `github.delete_repo` | CRITICAL | repo deletion |
| `github.merge_to_default_under_seconds_old_pr` | HIGH | merge a PR <60s old (runtime check) |
| `sql.drop_table_or_database` | CRITICAL | DROP TABLE/DATABASE |
| `net.curl_pipe_shell` | CRITICAL | `curl … | sh` |
| `creds.read_ssh_or_aws` | CRITICAL | `.ssh/` or `.aws/credentials` |
| `creds.read_env_outside_project` | HIGH | `.env` files outside project |
| `self.modify_no_go_list` | CRITICAL | edit `no-go-list.ts` |
| `self.modify_trust_store` | CRITICAL | edit trust scopes DB directly |
| `comm.external_send` | CRITICAL | external email / Slack / Twitter |

**Call site (single):** `src/tools/gated-action.ts:78` — `checkNoGo(toolName, toolArgs)`.

**Gap:** anything that doesn't route through `gatedAction()` is invisible to the no-go list. From a code search the path is taken by GitHub-writes and `trust_scope_grant`. Worker spawn, connector writes, credential reads, steward dispatch all sidestep it. **Recommend a universal middleware** that wraps every `server.registerTool()` call so the no-go check is structural, not opt-in.

## 3. Host-exec allowlist

`src/security/host-exec-allowlist.ts:47-266` — 9 commands:

| Command | On-by-default | Banned patterns |
|---|---|---|
| `git` | ✅ | rebase -i, config --global, filter-repo/branch |
| `npm` | ✅ | publish, config set *authToken |
| `pm2` | ✅ | set (global config) |
| `taskkill` (win32) | ✅ | /im (image name); requires /pid |
| `kill` (POSIX) | ✅ | -1, 0 (all processes); requires positive PID |
| `netstat` | ✅ | (read-only, any args) |
| `curl` | ✅ | bans -T/-d/-u/--resolve (loopback bypass); no POST/PUT/PATCH/DELETE; loopback-only |
| `gh` | ✅ | no --token leak; bans api/extension/gpg-key/ssh-key/secret/release; allows read + comment/create |
| `node` | ❌ disabled by default | "arbitrary JS execution defeats allowlist" |

**Enforcement chain (correct):**

1. `src/security/host-exec-allowlist.ts:282-320 validateAllowlistCall()` — command + args + platform.
2. `src/security/host-exec-config.ts:69-102` — operator can **restrict** (disable, shorten timeout) but **not expand**. Test run confirmed: `WARN: host-exec config: override for unknown command 'wget' ignored (not in compiled allowlist)`.
3. `src/security/host-exec-runner.ts:23-115` — `shell: false`, cwd containment, env scrub, 1 MB output cap.
4. `src/security/host-exec-tool.ts:150-176` — validates allowlist **after** scope check (line 121).

**Gap:** scope is checked first, allowlist second. A stale (but technically still-active) scope plus a freshly-banned command would be approved. Race-window is very small but the inversion is a code-smell — recommend allowlist-first.

## 4. Trust scopes

`src/trust/types.ts:1-58` (types) + `src/trust/store.ts` (persistence).

- **ActionMatcher:** tool + optional `param_constraints` + reason.
- **Reporting:** cadence (every-action / every-5 / every-15min / on-completion-only) + channels.
- **Lifecycle:** proposed → active → expired/revoked/completed.

**Granularity gap:**
- No per-session restriction — a scope is global once granted.
- No per-connector restriction — scopes are tool-wide.

A scope granted because "Steward session X needs this" is usable by Steward session Y, indefinitely until expiry. This is the gap ADR-022 tolerates for v0.x but should be tightened.

## 5. WebAuthn / Tier 3

Files: `src/security/webauthn.ts`, `webauthn-routes.ts`, `tier3-gate.ts`.

**Endpoints:** `/api/auth/register/options|verify`, `/api/auth/assert/options|verify`, `/api/auth/credentials`, `/api/auth/credentials/:id/revoke`, `/api/auth/tier3/recent`.

**Wired:**
- ✅ Passkey registration + assertion ceremonies.
- ✅ `tier3_assertion_recorded` event emitted at `src/security/webauthn-routes.ts:137-150`.

**Not wired:**
- ❌ `requireRecentTier3Assertion()` exists at `src/security/tier3-gate.ts:55-102` but is **only referenced from `src/dashboard/pages/family-mode.ts:161`** (a UI hint), not at any tool invocation site. Comments in the file mention `v0.7.1` for host_exec EXPLICIT paths and worker_spawn gate wiring.
- ❌ Typed friction string is **not implemented anywhere**, despite UI claims:
  - `src/dashboard/components/tooltips.ts:46` — "operator types a confirmation string"
  - `src/tools/categories.ts:44` — "operator must type a friction string"
  - `src/dashboard/pages/tools.ts:50` — "Operator types a friction string before each call"

These UI strings are dishonest until the gate ships. Either label them as "v0.7" placeholders (per the existing convention) or wire `requireRecentTier3Assertion()` into every `defaultTierFor(toolId) === 'explicit'` call site.

## 6. Credential vault

`src/credentials/vault.ts` (encryption) + `src/credentials/store.ts` (persistence).

- **Master key:** prefer Windows Credential Manager (`wincred`, optionalDependency). Fallback `~/.stavr/master.key` (0600) emits `credential_unsafe_storage` event.
- **Algorithm:** AES-256-GCM (IV + ciphertext + authTag → base64 BLOB).
- **API:** `add()` encrypts before INSERT. `get()` retrieves encrypted blob. Decryption on demand in `rowToRecord()`.

**Gaps:**
- No scope-gating of reads. `CredentialGrantRecord` carries `steward_session_id` (`src/credentials/store.ts:29-38`) but it's stored, never checked. **Recommend:** require a session match (or an active scope match) at read time.
- No per-grant audit emission. A read should emit `credential_read` to the audit-class event stream so a misuse later is traceable.
- `uses_remaining` and `expires_at` exist on grants but enforcement at read is not visible in the audit transcript.

## 7. Designed vs enforced gaps — consolidated

| Designed | Enforcement missing at | Reason |
|---|---|---|
| L1 per-actor tier | `src/server.ts:294-301` gate wrapper | `actorId` not in `RuntimeToolGate.check()` signature; matrix table reads happen in the dashboard but not at invocation |
| Tier 3 EXPLICIT friction | host_exec tool, worker spawn, any EXPLICIT-tagged tool | `requireRecentTier3Assertion()` never called outside dashboard UI; typed string not implemented |
| Universal no-go enforcement | steward dispatch, connector writes, credential reads, worker spawn (beyond tier gate) | only checked inside `gatedAction()` |
| Connector-write gating | `src/connectors/*` write paths | no `gatedAction()` wrapper |
| Credential scope isolation | `src/credentials/store.ts` read paths | `steward_session_id` stored, not enforced |
| Per-session scope isolation | `src/trust/store.ts findActiveScopeFor()` | scopes are global |
| Per-worker tier check | `src/workers/orchestrator.ts this.gate(...)` | gate function exists but its scope check is shallow; should re-read actor + L1 tier |

## 8. Tier-3 friction string — status note

Three independent UI sites tell the operator a typed friction string will be required. No code accepts or validates one. This is the largest single "UI ahead of substrate" gap in the security layer. Either:
- Promote the UI strings to a placeholder marker (per audit/04 conventions: `// v0.7.1`), or
- Implement the gate by adding a typed-string field to the decision-response payload and validating against a per-action salt.

## 9. Append-only event log — integrity

`src/persistence.ts:144-159`:

```sql
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  correlation_id TEXT,
  source_agent TEXT NOT NULL,
  tenant_id TEXT,
  payload_json TEXT NOT NULL,
  at TEXT NOT NULL,
  persisted_at TEXT NOT NULL,
  seq INTEGER NOT NULL
);
```

**What works:**
- Append-only at the DB level (`seq` is monotonic).
- WAL mode (`journal_mode=WAL`) for durability.
- Integrity check at open (`PRAGMA integrity_check`).

**What doesn't:**
- No cryptographic signing (no HMAC, no hash chain, no Ed25519). A process with DB write access can delete or modify rows undetected.
- ADR-036 (audit integrity baseline) addresses this but is **Proposed**.

## 10. Notification dispatch — promise retention

`src/notify/notifier.ts:168-174`:
```ts
setImmediate(() => {
  this.dispatchAll(eligible, channelInput)
    .then((dispatches) => this.recordDispatch(id, dispatches))
    .catch((err) => { … });
});
```

**Concern:** no per-channel timeout. A hung HTTP client (Telegram poll dropping, email server unreachable) keeps the promise — and the closure of `eligible`/`channelInput` — alive. Test run emitted `WARN: notifier: background dispatch threw {"error":"The database connection is not open"}` once, which is the symmetric race shape.

**Recommended fix:** `Promise.race([ch.send(input), timeout(10_000)])` per channel.

## Recommendations

| # | Action | Size |
|---|---|---|
| 1 | Wire `requireRecentTier3Assertion()` into every `defaultTierFor(toolId) === 'explicit'` call site, or relabel UI strings as v0.7 placeholders | medium |
| 2 | Universalise no-go enforcement: wrap `server.registerTool()` in `src/server.ts` so `checkNoGo()` runs before every handler | medium / BOM-worthy |
| 3 | Implement L1 enforcement: add `actorId` to `RuntimeToolGate.check()` and call `ActorPermissionStore.resolve()` | medium |
| 4 | Scope-gate credential reads using the stored `steward_session_id`; emit `credential_read` audit events | small |
| 5 | Add per-channel timeout to notification dispatch | small |
| 6 | Invert host-exec ordering so allowlist runs before scope check | trivial |
| 7 | Add scope per-session field + assert at `findActiveScopeFor()` | small |
| 8 | Promote ADR-036 (hash-chain audit log) to in-progress; depends on ADR-039 if signing moves to Rust | BOM-worthy |
| 9 | Add a CI guard test that fails if any tool registered with tier `explicit` lacks a recent-assertion check upstream | medium |
