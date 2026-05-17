# stavR · host_exec allowlist expansion — `curl` + `gh`

> Small targeted PR. Adds two binaries to the `host_exec` allowlist so Cowork-Claude (and Steward, eventually) can hit loopback HTTP endpoints and read GitHub state without driving a browser for every check. Designed Lex Insculpta-compliant: the addition itself is a code change with explicit operator consent (this BOM is that consent).

**Estimated wall-clock**: 2–3 hours sequential. Single CC worker, single PR.

**Stop conditions**: end of any phase if `npm test` regresses (must stay ≥660 passing per current baseline), `npm run build` fails, or any negative-path test demonstrates that the allowlist constraint is bypassable.

**Do NOT pause for approval** between phases. Commit + push at end of each. Open PR at end of P4.

---

## Why this expansion

Cowork-Claude currently has to drive a Chromium browser via the Claude-in-Chrome MCP to inspect anything — every `/metrics` reading, every PR status check, every workflow-run inspection requires multiple browser tool calls + DOM parsing. Two missing binaries on the allowlist would collapse 5-10 browser calls into one direct host_exec call:

- **`curl` / `curl.exe`** — direct HTTP reads against loopback (`/healthz`, `/metrics`, `/api/*`). No browser needed for daemon introspection.
- **`gh`** — read GitHub PR state, checks, run logs without driving the browser to `github.com`.

Neither binary opens new attack surface beyond what the operator already trusts:
- `curl` is loopback-only (constraint enforced at the URL position)
- `gh` is read-mostly (one write: `pr comment` and `issue create`, both operator-attributable via audit log; `pr merge` deliberately excluded because the MCP `github_merge_pr` tool already exists with its own await_decision flow)

**Lex Insculpta posture**: this PR is the operator's deliberate, code-committed amendment to the allowlist. After it merges, the daemon must restart to pick up the new entries. Future host_exec calls using `curl`/`gh` will be subject to the same scope/audit/banned-arg-pattern checks as the existing 6 binaries.

---

## Reference reading

1. `CLAUDE.md` — invariants (tests-are-derivative + never-lose-files)
2. `src/security/host-exec-allowlist.ts` — current allowlist, the file we're modifying
3. `src/security/host-exec-config.ts` — config loader semantics ("restrict via config, never expand")
4. `src/security/host-exec-runner.ts` — runner that calls `spawn` with `shell:false`
5. `tests/security/host-exec-allowlist.test.ts` — existing test patterns
6. `tests/security/host-exec-regression.test.ts` — `LOCK <name>` regression discipline
7. `proposed/host-exec-tool-bom.md` — the original host_exec BOM, for context on the security model
8. `storm-pass-2/lex-insculpta.md` (OneDrive personal) — the governance law this expansion respects

---

## Don't touch

- `src/security/host-exec-runner.ts` — the spawn primitive is untouched (it doesn't care which binary it runs; the allowlist is the gate)
- `src/security/host-exec-tool.ts` — the tool handler is unchanged
- The `host_exec` MCP tool registration in `src/server.ts` — no surface change
- Existing 6 allowlist entries (git/npm/pm2/taskkill/kill/netstat) — pure addition
- `src/mcp/handlers/host-exec.ts` if it exists — unchanged
- Any file under `src/dashboard/`, `src/steward/`, `src/worker/`, `src/mcp/` beyond what the security module needs
- `package.json` deps — neither binary is a Node dependency

---

## Hard rules

1. **Tests are derivative** — if any existing test asserts "the allowlist has exactly 6 entries" (it may), update the assertion to 8 in the same commit
2. **Never lose files** — bash `stat -c %s` + `tail -5` verify before commit for files >15KB
3. **Negative-path tests are MANDATORY** — every banned arg pattern gets a regression LOCK test
4. **Loopback-only enforcement for curl is non-negotiable** — the URL position check must use both string-prefix match (`http://localhost:` or `http://127.0.0.1:`) AND a regex anchor to prevent argument-position smuggling (e.g., `curl http://evil.com --resolve localhost:80:1.2.3.4` style attacks)
5. **`shell: false` invariant preserved** — confirm in tests that adding new binaries doesn't accidentally enable shell expansion on POSIX or Windows
6. **DCO -s, per-phase commits, push at end of each phase**

---

## P0 · Pre-flight (Kenneth, before CC kicks off)

~3 min. Operator confirms:

1. `git status` clean on `main`
2. Current main HEAD includes both PR #26 (host_exec) and PR #28 (operator-trust pass) — `git log --oneline -5` shows them
3. `npm test --run` baseline = 660+ passing
4. `curl --version` and `gh --version` work in operator's shell (sanity check that these binaries exist on the host — otherwise the integration tests can be `it.skip()`)
5. Dispatch CC with this brief

---

## P1 · Add `curl` to the allowlist (45 min)

**Files**: `src/security/host-exec-allowlist.ts`, `tests/security/host-exec-allowlist.test.ts`

### Sub-tasks

1. Detect platform binary: `process.platform === 'win32' ? 'curl.exe' : 'curl'`
2. Add allowlist entry:
   ```ts
   {
     command: /* curl or curl.exe per platform */,
     description: 'Read-only HTTP against loopback (localhost) for daemon introspection. /metrics, /healthz, /api/* without browser. Loopback-only constraint enforced at URL position.',
     timeout_default_ms: 30_000,
     validateArgs: (args) => {
       // URL must be present and start with loopback prefix
       // Banned args (write-class): --upload-file, -T, -d, --data*, --form*, -F, --user, -u, --cert, --key, --post, -X POST/PUT/PATCH/DELETE
       // ...
     }
   }
   ```
3. Validator implementation:
   - Reject if no arg matches `^https?://(localhost|127\\.0\\.0\\.1)[:/]`
   - Reject if any arg matches `^(-T|--upload-file|-d|--data.*|-F|--form.*|--user|-u|--cert|--key)$`
   - Reject if any arg is `-X` followed by a non-read verb (`POST`, `PUT`, `PATCH`, `DELETE`)
   - Reject if any arg matches `--resolve` (DNS-rewriting smuggling vector)
4. Positive test cases:
   - `curl http://localhost:7777/metrics` → allowed
   - `curl -s http://127.0.0.1:7777/healthz` → allowed
   - `curl --max-time 5 http://localhost:7777/api/pending-actions` → allowed
5. Negative test cases (regression LOCKs):
   - `LOCK curl-non-loopback` — `curl http://google.com` → ALLOWLIST_DENIED
   - `LOCK curl-upload-file` — `curl -T file.txt http://localhost/upload` → ALLOWLIST_DENIED
   - `LOCK curl-data-post` — `curl -d 'x=1' http://localhost/api` → ALLOWLIST_DENIED
   - `LOCK curl-resolve-smuggle` — `curl --resolve localhost:80:1.2.3.4 http://localhost/` → ALLOWLIST_DENIED
   - `LOCK curl-post-verb` — `curl -X POST http://localhost/api` → ALLOWLIST_DENIED
   - `LOCK curl-no-url` — `curl --version` → allowed (read-only, no URL needed)
   - Actually — `curl --version` exits without network I/O, that's fine. But `curl --help` similarly. Allow them via "if no URL present AND no banned args, it's a metadata call → allow."

### Acceptance

- `npm test -- tests/security/host-exec-allowlist.test.ts` passes
- 6+ new positive/negative cases added
- `npm run build` clean

### Commit

`feat(security): host-exec allowlist + curl (loopback-only, read-only HTTP)`

---

## P2 · Add `gh` to the allowlist (60 min)

**Files**: `src/security/host-exec-allowlist.ts`, `tests/security/host-exec-allowlist.test.ts`

### Sub-tasks

1. Add allowlist entry:
   ```ts
   {
     command: 'gh',
     description: 'GitHub CLI: read PR state, checks, run logs, list issues. Some operator-attributable writes (pr comment, issue create). Excludes merge (use MCP github_merge_pr instead) and credential ops.',
     timeout_default_ms: 30_000,
     validateArgs: (args) => {
       // First arg = subcommand category (pr, issue, repo, run, workflow, auth, secret, release, gist)
       // Second arg = subcommand action (view, list, comment, create, merge, etc.)
       // Per (category, action) pair: ALLOWED or DENIED
     }
   }
   ```
2. Allowed subcommand pairs:
   - `pr view`, `pr checks`, `pr list`, `pr comment`, `pr diff`, `pr status`
   - `issue view`, `issue list`, `issue create`, `issue comment`, `issue status`
   - `repo view`, `repo list`
   - `run list`, `run view`, `run watch`
   - `workflow list`, `workflow view`
   - `auth status` (read-only credential check, no token mutation)
   - `gist list`, `gist view`
3. Banned subcommand pairs (categorical refuse):
   - `pr merge`, `pr close`, `pr reopen`, `pr edit`, `pr ready`
   - `issue close`, `issue reopen`, `issue edit`, `issue delete`
   - `repo create`, `repo delete`, `repo edit`, `repo fork`, `repo clone`
   - `auth login`, `auth logout`, `auth refresh`, `auth setup-git`
   - `secret set`, `secret remove`, `secret list`
   - `release create`, `release delete`, `release edit`, `release upload`
   - `gist create`, `gist delete`, `gist edit`
   - `gpg-key`, `ssh-key` — all subcommands (key management)
   - `api` — direct API calls bypass our intent
   - `extension install/remove/upgrade` — supply chain
4. Banned args anywhere (universal):
   - Anything containing `--token` (credential leak vector)
   - Anything containing `--with-token` (alias)
5. Positive test cases:
   - `gh pr view 28` → allowed
   - `gh pr checks 28 --json conclusion` → allowed
   - `gh pr comment 28 --body "..."` → allowed (write, but operator-attributable)
   - `gh issue create --title "..." --body "..."` → allowed
   - `gh auth status` → allowed
6. Negative test cases (regression LOCKs):
   - `LOCK gh-pr-merge-denied` — `gh pr merge 28 --squash` → ALLOWLIST_DENIED
   - `LOCK gh-auth-login-denied` — `gh auth login` → ALLOWLIST_DENIED
   - `LOCK gh-secret-set-denied` — `gh secret set FOO --body bar` → ALLOWLIST_DENIED
   - `LOCK gh-release-create-denied` — `gh release create v1.0` → ALLOWLIST_DENIED
   - `LOCK gh-repo-delete-denied` — `gh repo delete Kstkoda/stavr` → ALLOWLIST_DENIED
   - `LOCK gh-token-arg-denied` — `gh pr view 28 --token sekret` → ALLOWLIST_DENIED (anywhere in args)
   - `LOCK gh-api-denied` — `gh api repos/Kstkoda/stavr/issues` → ALLOWLIST_DENIED (direct API bypasses our intent)
   - `LOCK gh-extension-install-denied` — `gh extension install evil/repo` → ALLOWLIST_DENIED

### Acceptance

- `npm test -- tests/security/host-exec-allowlist.test.ts` passes
- 10+ new positive/negative cases added
- `npm run build` clean

### Commit

`feat(security): host-exec allowlist + gh (read-mostly, operator-attributable writes)`

---

## P3 · Regression corpus (30 min)

**Files**: `tests/security/host-exec-regression.test.ts`

### Sub-tasks

1. Add the regression LOCKs from P1 and P2 to the central regression corpus (some operator-facing behavior tests live there, not in the allowlist unit tests)
2. Add a meta-test: assert the allowlist has exactly 8 entries (was 6) and that `curl` + `gh` are present with the expected description
3. Add a negative test for the "config can RESTRICT, never EXPAND" guarantee: load a config that ATTEMPTS to add `bash` → must be silently dropped (or refused at load), allowlist stays at 8 entries

### Acceptance

- All regression LOCKs from P1 + P2 mirrored in the central corpus
- Config-cannot-expand test passes

### Commit

`test(security): regression LOCKs for curl + gh + config-cannot-expand`

---

## P4 · Smoke + PR (30 min)

### Sub-tasks

1. `npm test` full suite passes (target: 660 + ~20 new = ~680 passing)
2. `npm run build` clean
3. Manual smoke from operator (requires `host_exec` scope grant):
   - Grant a scope covering host_exec
   - `host_exec curl http://localhost:7777/healthz` → 200 with health JSON
   - `host_exec gh pr view 28 --json state,mergeable` → returns PR state
   - `host_exec curl http://google.com` → ALLOWLIST_DENIED (proves loopback enforcement)
   - `host_exec gh pr merge 28` → ALLOWLIST_DENIED (proves write-gate enforcement)
4. Open PR:
   - Title: `feat(security): host-exec allowlist — add curl (loopback) + gh (read-mostly)`
   - PR body must include:
     - Link to this BOM
     - Full list of allowed + banned subcommands for both binaries
     - "Why this is Lex Insculpta-compliant" note: this PR is the operator-consented amendment to the law's allowlist
     - All regression LOCK names
5. **Do NOT auto-merge.** Operator reviews and merges.

### Acceptance

- PR open, CI green, regression LOCKs visible
- Manual smoke proves both positive and negative cases work end-to-end

### Commit

(Smoke commit only if bug surfaces during P4; otherwise nothing.)

---

## Budget

- **Time**: 2–3h CC sequential
- **API cost**: ~$1–2 (mostly file edits + test writes, small surface)
- **LOC change**: ~120–180 net in `src/security/` + `tests/security/`
- **Token cap**: 400k (small task)
- **Dependency change**: none (`curl` and `gh` are operator-installed system binaries)

---

## Footgun appendix

1. **`gh` subcommand parsing**: `gh` accepts subcommands as positional args before any flags. The validator must handle `gh pr view 28 --json X` (subcommand first) but also `gh --repo X pr view 28` (global flag first). Use a parser that finds the subcommand pair regardless of flag interleaving.
2. **`curl` argument position**: URL can appear anywhere in the args, not just last. Validator must find ANY arg matching the loopback URL regex, not just `args[args.length - 1]`.
3. **`curl --resolve`** is the classic loopback-smuggling vector. Banning it is a hard requirement.
4. **`gh auth token`** subcommand might exist for printing the current token — confirm it's banned even though it's a "read." Token-print is a credential exfil path.
5. **Cross-platform binary names**: `curl` vs `curl.exe`, `gh` vs `gh.exe`. The runner already handles `.cmd`/`.exe` per CVE-2024-27980 logic; just need allowlist entries to match against the OS-normalized name.
6. **Output cap with curl**: a single `curl http://localhost:7777/dashboard/topology` could return 50KB+ of HTML. The 1MB output cap already in `host-exec-runner.ts` covers this.
7. **`gh` subcommand allowlist is fragile to gh CLI versioning**: GitHub adds subcommands over time. New ones default to DENIED (per the explicit-allowlist principle), so the failure mode is "the AI can't use new gh features without an allowlist update" — acceptable.

---

## Open questions (FLAGGED — do not pre-answer)

### §1 — Should `curl` allow non-loopback in any case?

Some legitimate use cases: hitting public APIs the operator has explicitly authorized (e.g., a CDN to check release artifact existence). But each "exception" expands the surface non-trivially.

**Default**: NO. Loopback-only. If the operator later wants a specific public endpoint (e.g., `api.github.com`), they amend the allowlist via another small PR. Friction by design.

### §2 — Should `gh auth status` be allowed (it touches credentials)?

It only READS — returns "you're logged in as X" or "not logged in." Doesn't expose the token.

**Default**: allow. Useful for diagnostics. Test confirms it doesn't leak token value.

### §3 — Should we add `--max-time` mandatory to curl?

curl can hang indefinitely on a slow endpoint. The runner already has a timeout (passed via `timeout_ms`), so the host_exec layer handles it.

**Default**: not mandatory. Runner timeout is sufficient. Operator can pass `--max-time` if they want client-side timeout granularity.

### §4 — Should `gh pr comment` require explicit per-call consent (RED tier)?

A PR comment is operator-attributable, audit-logged, but it IS a public write.

**Default**: no per-call consent in this PR. PR comments are part of normal workflow. If patterns of misuse appear (AI spamming comments), promote to RED in a follow-up.

### §5 — Should the curl/gh additions go into v0.6 governance UI's "Permissions" view immediately?

The governance UI doesn't exist yet. Once it does, `curl` and `gh` would naturally show as new allowlist entries.

**Default**: no UI work in this PR. v0.6 governance will read the allowlist at startup and display whatever's there. This PR just extends the underlying data.

---

## Run prompt for CC (paste at start)

```
Read CLAUDE.md first. Then read proposed/host-exec-curl-gh-expansion-bom.md and execute Phases 1 through 4 sequentially.

This expansion is Lex Insculpta-compliant: the law requires allowlist changes to come via source-code PR with operator consent. This BOM IS that consent — your job is the code change + tests + PR. Operator merges.

Rules:
- One commit per phase, DCO sign-off (-s)
- Don't pause for approval between phases. Commit + push at end of each
- For any file >15KB after edit, run `stat -c %s file` + `tail -5 file` BEFORE git add
- `npm test` must pass after every commit. If a phase regresses, fix in the same phase commit before moving on
- After P4 opens PR, output a final delta report and STOP. Don't auto-merge.

The brief is self-contained. Open questions §1-§5 are flagged — pick the lower-risk path during implementation and note in PR body, don't block.

Go.
```

---

## End of brief
