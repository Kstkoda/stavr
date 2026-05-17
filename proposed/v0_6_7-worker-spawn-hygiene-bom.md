# stavR · v0.6.7 — Worker spawn hygiene (script files, AV-aware, sleep-correct)

> Medium PR. Replaces the inline-shell-command worker pattern with written-script-file invocation, adds AV/EDR-block detection that surfaces meaningfully to the operator, fixes the Windows `timeout` headless-mode bug, and adds optional Ed25519 script signing for operator-controlled AV whitelisting. Discovered during 2026-05-17 E2E test when Windows Defender correctly identified an inline PowerShell command as exfil-shaped malware and killed it — stavR reported `spawn EPERM` with no AV context, leaving the operator to find out only because Defender popped a separate toast.

**Estimated wall-clock**: 6–8 hours CC sequential. 2 PRs.

**Sensitivity**: `high` per CLAUDE.md section 9 — touches worker spawn security primitives, AV integration, script signing. Operator approval gate between PRs. Status check before every git op (CLAUDE.md §8).

**Stop conditions**: end of any phase if `npm test` regresses, build fails, or any negative test demonstrates that (a) operator-signed script can be bypassed, (b) AV-block detection has false-positive rate >5% in normal operation, (c) script file written to disk contains operator secrets in plaintext.

**Do NOT pause for approval** between phases within a PR. Open PR at end of each phase-group.

---

## Why this matters

The 2026-05-17 E2E test surfaced three real problems with how stavR spawns shell workers:

**1. Inline complex PowerShell commands trip antivirus / EDR.** A command like `$dir="$env:USERPROFILE\.stavr\test-results"; $msg = (Get-ChildItem $dir | Get-Content); curl.exe -d $msg "https://ntfy.sh/$env:STAVR_NOTIFY_NTFY_TOPIC"` matches the data-exfiltration pattern: read env → read local files → curl to external URL with secret in URL. Windows Defender pattern-matched and killed it. The operator's AV is correct to be suspicious. The stavR worker pattern is the wrong shape.

**2. stavR masks AV blocks as generic `spawn EPERM`.** When AV killed the process, the spawner saw EPERM and reported `worker_failed`. The operator only learned via the AV's own OS-level toast notification — by happenstance. No audit event in stavR's own log distinguishes "AV blocked" from "OS denied process creation for unrelated reason." This breaks the "I shall not act unseen" promise from Lex Insculpta.

**3. Windows `timeout /t N /nobreak` doesn't sleep in headless workers.** Without a console attached, `timeout` exits immediately. The 8-worker stress test showed all stress workers reporting `completed in 0.6s` while their commands intended 5-60 second waits. This means many existing worker patterns (any using `timeout` for pacing) are silently broken.

For team mode (per ADR-040), this is even worse: different operators run different AV/EDR — same worker command works for one and gets killed for another. Trust scope grants become meaningless because what actually executes depends on local OS security.

---

## Reference reading

1. `CLAUDE.md` — invariants
2. `adr/036-audit-integrity-baseline.md` — Ed25519 signing primitives (reuse here for script signing)
3. `adr/038-supply-chain-integrity.md` — Sigstore + provenance philosophy
4. `adr/040-three-process-architecture.md` — three-party architecture; Spawner lives in Engine
5. `src/workers/spawner.ts` (or equivalent) — current spawn path
6. `src/security/host-exec-runner.ts` — reference for safe spawn patterns (shell:false, no shell metachar expansion)
7. `~/.stavr/captures/bug.jsonl` — the 2026-05-17 E2E test bug record

---

## Don't touch

- `src/security/host-exec-*` — separate concern (operator manual exec via MCP)
- Existing 4-tier approval model — no changes to AUTO/CONFIRM/EXPLICIT/NO-GO
- Lex Insculpta + trust scopes — unchanged
- Worker types `cc` and `unity` — out of scope (this BOM is shell-worker-specific; cc/unity already use file-based command patterns)
- Operator keypair location (`~/.stavr/keys/operator.ed25519`) — reuse, don't relocate
- `src/dashboard/*` — display side handled in v0.6.6 (which lands before this BOM)

---

## Hard rules

1. **Tests are derivative** — if any existing test asserts spawn semantics that change (e.g., "spawn takes inline command directly"), update assertion in same commit
2. **Never lose files** — `stat -c %s` + `tail -5` for any file >15KB
3. **Status-check before every git op** (CLAUDE.md §8)
4. **No regression to inline-command spawning** — once script-file mode lands, the inline-command path should be REMOVED, not deprecated alongside. Old path is the security problem.
5. **Script files MUST NOT contain plaintext secrets** — operator's env vars referenced via `$env:VAR` syntax (PowerShell) / `%VAR%` (CMD) / `$VAR` (bash), NOT interpolated into script body. AV scanners shouldn't see secret values in the file on disk.
6. **AV-block detection MUST be conservative** — false positive rate < 5% in normal operation. Better to report "spawn failed (reason unknown — check AV logs)" than to misattribute a real OS error to AV.
7. **Script file paths MUST be operator-readable** — for audit, operator should be able to inspect every script that was spawned. Default location: `~/.stavr/worker-scripts/<worker-id>.<ext>` with 7-day retention (operator-overridable).
8. **DCO -s, per-phase commits, push at end of each phase. 2 PRs.**

---

## Phase-group structure (2 PRs)

| PR | Phases | Scope | Wall-clock |
|---|---|---|---|
| #1 — Spawn refactor | P0, P1, P2, P3 | Script-file pattern + sleep-correct pacing + AV-block detection | 4–5h |
| #2 — Signing + whitelisting | P4, P5 | Optional Ed25519 script signing + operator docs for AV whitelist | 2–3h |

PR #1 alone is the major operator-visible safety improvement. PR #2 is additive (operator chooses whether to sign).

---

## P0 · Pre-flight (Kenneth, before CC kicks off)

~5 min:
1. `git status` clean on `main`; v0.6.6 (worker fidelity) merged
2. `npm test --run` baseline = current passing count + v0.6.6 additions
3. Verify operator keypair exists at `~/.stavr/keys/operator.ed25519` per ADR-036 (if not yet, create with `openssl genpkey -algorithm Ed25519`)
4. Dispatch CC

---

## P1 · Script-file write + invoke pattern (1.5h)

**Files**:
- `src/workers/spawner.ts` — change shell-worker spawn path
- `src/workers/script-writer.ts` (new) — writes command to `~/.stavr/worker-scripts/<worker-id>.<ext>`
- `tests/workers/script-writer.test.ts`
- `tests/workers/spawner-script-mode.test.ts`

### Sub-tasks

1. New function `writeWorkerScript(workerId, shell, command) → scriptPath`:
   - Extension per shell: `.ps1` for powershell, `.cmd` for cmd, `.sh` for bash
   - Add header comment with worker_id + spawn timestamp + operator identity (from key fingerprint)
   - Write command body verbatim (no inlining of operator env values; references like `$env:VAR` stay as references)
   - chmod 0700 / Windows ACL operator-only

2. Spawner now invokes:
   - PowerShell: `powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File <path>` (NOT `-Command "..."`)
   - CMD: `cmd.exe /c "<path>"` (the script file is a `.cmd`)
   - Bash: `bash <path>`

3. Script retention: 7-day default (configurable via env `STAVR_WORKER_SCRIPT_RETENTION_DAYS`); nightly cleanup job (integrate with ADR-037 backup job)

### Acceptance

- Spawning a worker writes a file to `~/.stavr/worker-scripts/`
- File contains the command body + the operator-readable header
- File is operator-only readable (0700 / Windows ACL)
- Spawn invokes `powershell -File <path>` not `powershell -Command "..."`
- Spawned worker can still read `$env:VAR` from the script
- 6+ new tests passing

### Commit
`feat(workers): script-file spawn pattern replaces inline -Command invocation`

---

## P2 · Sleep-correct pacing helpers (1h)

**Files**:
- `src/workers/script-writer.ts` — extend with shell-specific sleep helpers
- `tests/workers/script-writer-sleep.test.ts`

### Problem

The operator (or auto-generated worker commands) may use `timeout /t N /nobreak` on Windows expecting it to sleep — but it doesn't work in headless mode (stress test 2026-05-17 confirmed: all 8 cmd workers using `timeout` reported done in <1s instead of intended 5-60s).

### Fix

Worker spawn API accepts optional `sleepBefore` and `sleepAfter` parameters. Script writer translates to the correct primitive per shell:
- PowerShell: `Start-Sleep -Seconds N` (works in headless — proven)
- CMD: `ping 127.0.0.1 -n N >nul` (works without console; sleeps N-1 seconds; quirky but reliable)
- Bash: `sleep N`

Or expose a higher-level "pause N seconds" macro that the script writer expands.

### Acceptance

- Spawning a worker with `sleepBefore: 30` results in the worker actually waiting 30s before its command runs (cross-check via measured `ended_at - started_at`)
- All three shells (powershell/cmd/bash) tested
- Documentation in `docs/worker-spawn.md` warns against using `timeout` directly on Windows
- 4+ new tests passing

### Commit
`feat(workers): sleep-correct pacing across powershell/cmd/bash`

---

## P3 · AV-block detection + dedicated event kind (1.5h)

**Files**:
- `src/workers/spawner.ts` — detect AV-block scenario
- `src/workers/av-detector.ts` (new) — Windows Event Log query for Defender + common third-party AVs
- `src/types/events.ts` — add `worker_blocked_by_av` event kind
- `src/notify/wiring.ts` — notifier subscribes to the new kind
- `tests/workers/av-detector.test.ts`

### Detection logic

When `spawn` returns `EPERM` (or similar denial code):
1. Wait 500ms (give AV time to write its event)
2. Query Windows Event Log: `Microsoft-Windows-Windows Defender/Operational` (ID 1116, 1117, 5007) for events in last 5 seconds matching the spawned executable path
3. Also check for known third-party AV event sources: `Symantec`, `CrowdStrike Falcon`, `SentinelOne`, `Sophos` (configurable list in env)
4. If match: emit `worker_blocked_by_av` event with: worker_id, av_product_name, av_event_id, av_event_message (truncated), spawned_command_signature
5. If no match: emit `worker_failed` event with `reason: "spawn_denied"` (current behavior, but with clearer reason)

### Notification routing

`worker_blocked_by_av` events trigger operator notification (per v0.6.5 wire-up: notifier subscribes via `notification_requested` pattern):
- Title: "stavR worker blocked by AV"
- Body: `Worker '<name>' was killed by <av_product>. Script: ~/.stavr/worker-scripts/<id>.<ext>. AV reason: <truncated message>. Inspect or whitelist via your AV console.`
- Priority: warn

### Acceptance

- Synthetic AV-block test: spawn a worker with a "test signature" filename Defender's testpattern matches → confirm `worker_blocked_by_av` emitted, notification routes
- Operator can view the AV-block event in event log + dashboard (per v0.6.6 lifecycle_state `killed-by-system` distinguishes this)
- False-positive test: regular spawn failure (e.g., bad shell name) → emits `worker_failed`, NOT `worker_blocked_by_av`
- 5+ new tests passing (including mock Windows Event Log query)

### Commit
`feat(workers): AV-block detection + worker_blocked_by_av event kind + notifier wire`

### Open PR #1

`feat(workers): script-file pattern + sleep-correct pacing + AV-block detection (closes v0.6.7 PR #1)`

---

## P4 · Optional Ed25519 script signing (PR #2, 1–1.5h)

**Files**:
- `src/workers/script-writer.ts` — extend with optional signing
- `src/security/script-signing.ts` (new) — reuse Ed25519 primitives from ADR-036
- `tests/security/script-signing.test.ts`

### How it works

Operator can enable per-shell-worker script signing via env `STAVR_SIGN_WORKER_SCRIPTS=1`. When enabled:
1. Script writer signs the script body with operator's Ed25519 private key (from `~/.stavr/keys/operator.ed25519`)
2. Signature appended to script as a comment: `# stavR-script-signature: <base64-ed25519-sig>`
3. Operator can add a custom AV whitelisting rule that trusts files containing this comment with operator-verifiable signatures

### Whitelisting (operator-side docs, no code)

Operator's AV / EDR can add a rule: "trust files in `~/.stavr/worker-scripts/` whose `stavR-script-signature` matches operator's public key fingerprint." Specific instructions for Defender, CrowdStrike, SentinelOne provided in P5 docs.

### Acceptance

- Script signing produces valid Ed25519 signature verifiable against the public key
- Signed script execution succeeds normally
- Verification script (`stavr-cli verify-script <path>`) checks signature
- 4+ new tests passing

### Commit
`feat(workers): optional Ed25519 script signing for AV whitelisting`

---

## P5 · Operator docs (PR #2, 1h)

**Files**:
- `docs/worker-spawn.md` (new) — operator guide for shell workers
- `docs/av-whitelist.md` (new) — per-AV whitelisting instructions
- `CHANGELOG.md` — v0.6.7 entry

### Operator guide content

- Why stavR uses script files (security context)
- How to inspect what scripts ran (path + retention)
- How to use `sleepBefore` / `sleepAfter` correctly (don't use `timeout` directly)
- How to enable script signing
- Per-AV whitelisting recipes (Defender, CrowdStrike, SentinelOne, Sophos)
- What `worker_blocked_by_av` events look like in the dashboard
- Troubleshooting: when AV detection didn't fire but worker still failed

### Acceptance

- First-time operator on Windows + Defender can:
  - Spawn a worker successfully
  - See the script file written
  - Configure Defender to whitelist signed scripts (with copy-paste-able PowerShell snippet)
- CHANGELOG v0.6.7 entry covers all 3 changes

### Commit
`docs(workers): spawn guide + AV whitelist instructions`

### Open PR #2

`feat(workers): script signing + operator docs (closes v0.6.7)`

---

## Budget

- **Time**: 6–8h CC across 2 PRs
- **API cost**: ~$8–14
- **LOC change**: ~1,000–1,500 net
- **Token cap**: 1M (split across 2 worker runs)
- **New deps**: none (Ed25519 already in via Node stdlib `crypto`)
- **Schema change**: none (events use existing event-log table; ADR-040 universal-trace not required for this BOM but compatible)

---

## Footgun appendix

1. **Script file as forensic artifact** — operator should treat `~/.stavr/worker-scripts/` as sensitive. 0700 perms + 7-day retention by default. AV may scan this directory; that's fine (the files are intended for inspection).
2. **Cleanup vs forensics** — if a worker fails dramatically, its script should be KEPT longer (not auto-deleted at 7d). Add `keep_on_failure: true` default — only auto-delete scripts whose worker exited cleanly.
3. **Windows Event Log query latency** — `Get-WinEvent` can be slow on machines with large logs. Cache the AV-event-source list at boot.
4. **Multiple AV-product detection** — if operator runs Defender AND CrowdStrike AND a third tool, all three may fire on the same block. Dedupe events by (worker_id, av_event_id) within 30s.
5. **CMD `.cmd` script invocation** — `cmd.exe /c script.cmd` may still hit different AV pattern matching than `cmd.exe -Command "..."`. Test against Defender to confirm script-file pattern actually reduces false-positive rate.
6. **PowerShell `-ExecutionPolicy Bypass`** is needed to run unsigned local scripts on default Windows. This is a known per-process opt-in (not a system change). Document it.
7. **Bash workers on Windows** — assumes WSL or Git Bash present. Detect at spawn time; error clearly if missing.
8. **Ed25519 signing performance** — signing a script takes <1ms; verification similar. Negligible overhead.
9. **CMD `timeout` replacement** — `ping 127.0.0.1 -n N >nul` is a known idiom but introduces a 1s-shorter-than-requested delay (pings are at ~1s intervals; N pings = N-1 second waits). Document; consider alternative `choice /t N` if it works in headless.
10. **The 7-day script retention** ties into ADR-037 (operator-data lifecycle). The nightly backup job should also prune old worker scripts.

---

## Open questions (FLAGGED — do not pre-answer)

### §1 — Should script signing be ENABLED by default, or opt-in?

Default: OPT-IN in v0.6.7. Default-on creates friction for first-time operators who haven't configured AV whitelisting yet. Revisit when operator-AV-whitelist integrations mature (v0.7+ candidate).

### §2 — Should we auto-detect and warn when the operator's worker command uses known-broken patterns (like `timeout`)?

Default: warn at spawn time. Add a lint pass in script writer: if command contains `timeout /t` (Windows) or `sleep` outside bash, emit a `worker_spawn_warning` event with a "did you mean to use sleepBefore?" hint.

### §3 — Should `worker_blocked_by_av` notifications be silenceable per-AV-product?

Some operators get noisy alerts when their EDR scans dev tools. Default: no silencing in v0.6.7 (all blocks notify); add muting per-product in v0.7+ if it's actually annoying.

### §4 — Should script signing use the same operator keypair as event signing (ADR-036), or a separate key?

Default: SAME key. Simpler key management. Operator's single sovereign identity. If key compromise is a concern, rotate the one key and re-sign everything in a maintenance window.

### §5 — What about NON-shell workers (cc, unity)? Do they need similar treatment?

Default: out of scope for v0.6.7. `cc` workers spawn Claude Code which writes its own files; `unity` workers attach to a running editor. Different threat model; revisit if AV starts blocking those too.

---

## Run prompt for CC (PR #1, paste at start)

```
Read CLAUDE.md first. Then read proposed/v0_6_7-worker-spawn-hygiene-bom.md and execute P0-P3 sequentially.

Sensitivity: HIGH. Operator approval gate between PR #1 (this) and PR #2. Status-check before every mutating git op.

Work on a NEW branch: `git checkout -b feat/v0.6.7-worker-spawn-hygiene` from latest main (which should include v0.6.6 merged). Never commit to main.

Rules:
- One commit per phase, DCO -s
- Don't pause for approval between phases inside this PR
- For any file >15KB after edit, `stat -c %s file` + `tail -5 file` BEFORE git add
- `npm test` must pass after every commit
- After P3 opens PR, output final delta report and STOP. Don't auto-merge. Don't proceed to PR #2.

Open questions §1-§5 are flagged — pick conservative default during implementation. The 2026-05-17 E2E test session in ~/.stavr/captures/bug.jsonl is the bug-list reference.

Go.
```

## Run prompt for CC (PR #2)

```
Read CLAUDE.md first. Then read proposed/v0_6_7-worker-spawn-hygiene-bom.md.

PR #1 (P1-P3) is merged. Your scope: P4 (signing) + P5 (docs). Open PR at end of P5.

Same rules as PR #1. Sensitivity: HIGH (script signing primitives). Go.
```

---

## End of brief
