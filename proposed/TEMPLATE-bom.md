# BOM TEMPLATE — fill in the placeholders, delete this header line

**Owner:** CC (autonomous) | operator-driven | mixed
**Sensitivity:** routine | careful | high | critical
**Verification window:** smoke | targeted | full | overnight | custom
**Branch:** `fix/<scope>-<short-name>` or `feat/v<version>-<scope>` or `chore/<scope>`
**Base:** `main` (verify current state via `github_list_prs` before assuming prerequisites)
**Estimated scope:** N phases, ~X hour autonomous run

---

## Verification window — pick one (per memory: feedback_verification_window_proportional)

| Value | Duration | When to use |
|---|---|---|
| `smoke` | ~5 min | Pure UI/CSS polish, doc-only, comment updates |
| `targeted` | ~15-30 min | New feature on existing infra; narrow bug fix; security primitive |
| `full` | 60-90 min | Touches broker / event store / session state / daemon perf paths |
| `overnight` | ~8 hours | Quarterly substrate releases; pre-tag for minor versions |
| `custom` | as specified | Migrations, rollback drills, security pen-tests |

**Mandatory `full` triggers** — any commit touching these files defaults to `full` regardless of diff size:
- `src/broker.ts`, `src/transports.ts`, `src/persistence.ts`
- `src/observability/*`
- `src/steward/*`
- Schema files / migrations

---

## Context — operator-led signal collection complete (YYYY-MM-DD)

### Symptoms / motivation

(Why this BOM exists. Link to operator memory files. Concrete observed behavior.)

### Ground truth from prior work — DO NOT REDISCOVER

- (List facts already established. Reference memory files. Save CC from re-investigating.)

### Already ruled OUT

- (Hypotheses CC should NOT spend time on.)

### Top suspects (investigate in this order)

1. (Most likely root cause, with where to look)
2. (Second candidate)
3. ...

### Companion bugs to bundle in same PR

- (Small adjacent fixes that make sense to ship together.)

---

## Phases

### Phase 0 — Recon (read-only, ≤30 min)

- (What CC reads / profiles BEFORE writing fix code.)
- Output: findings doc → `proposed/<bom-name>-findings.md`. Commit + push BEFORE Phase 1.

### Phase 1 — (Smoking-gun fix or first deliverable)

- (What lands. Include a regression test.)
- DCO commit. Push.

### Phase 2 — (Next deliverable)

...

### Phase N — Verification (DO NOT skip)

- Run the appropriate verification protocol per `verification_window` above
- Assertions to verify (be specific):
  - Memory stays under X MB for Y minutes
  - p95 latency under Z ms
  - No 5xx in logs
  - No new heap snapshots written
  - All existing tests still pass
- Attach time-series + screenshots to PR description

---

## Constraints (per CLAUDE.md hard invariants)

- Per-phase commits, `git commit -s` (DCO)
- `git status --short` + `git symbolic-ref HEAD` before every git op (rule #8)
- Don't-touch list applies — see CLAUDE.md §3 for the current list
- Tests are derivative — delete legacy assertions that conflict with the fix
- Verify file writes >30 KB with `stat -c %s` + `tail -5` (rule #2)
- NO-GO handoff if blocked — name the action + give operator exact command

---

## Definition of done

1. PR opened against `main`, all CI green
2. Phase N verification attached to PR description (time-series + screenshots for `targeted` or higher)
3. No regression in existing tests
4. Operator notified via ntfy when PR is ready (uses ntfy-fix from PR #47)

---

**Notes for the BOM author:**

- Length should be proportional to the work. A 3-phase polish BOM doesn't need 200 lines.
- Be CONCRETE about file paths, function names, behaviors. CC reads literally — vagueness = wasted Phase 0.
- If you have audit findings or test cases as separate files, reference them here so CC pulls them in at Phase 0.
- If `verification_window: smoke`, Phase N can be 1 paragraph ("run npm test, eyeball the change, push").
- If `verification_window: full`, Phase N needs the actual load harness + assertion criteria + success thresholds.
