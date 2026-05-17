# stavR · v0.7 — Tier 3 EXPLICIT consent mechanism

> Mid-size PR. Adds a fourth approval tier ("EXPLICIT") between today's CONFIRM (one click) and NO-GO (operator-only). Tier 3 actions are reversible-but-high-blast-radius and need extra friction — type-to-confirm, named-resource verification, or two-step approval — so the operator feels the weight before clicking. Companion to the 4-tier model adopted 2026-05-17.

**Estimated wall-clock**: 8–12 hours CC sequential across 2 PRs.

**Stop conditions**: end of any phase if `npm test` regresses, `npm run build` fails, or any negative-path test demonstrates that a Tier 3 action can be approved without the friction step (e.g., a CONFIRM-tier click accidentally approves a Tier 3 action).

**Do NOT pause for approval** between phases within a PR. Open PR at end of each phase-group (2 PRs total).

---

## Why this matters

Today every CONFIRM-tier action is the same single-click weight in the dashboard. Merging a typo-fix PR and granting a scope to nuke a production index look identical in the operator's queue. The operator has no UI signal that one is reversible-with-a-button and the other is irreversible-with-data-loss.

The 4-tier model says reversibility is binary: reversible = Tier 2 (one click), irreversible = Tier 3 (extra friction). This BOM builds the Tier 3 mechanism.

Concrete cases this catches:

1. **Force-push beyond reflog window** — today this would be SCOPE-required + CONFIRM. Tier 3 promotes it to "type the branch name + the date the reflog will purge to confirm."
2. **Secret rotation** — today CONFIRM. Tier 3 requires typing the secret label ("rotate STAVR_NOTIFY_SECRET? Type stavr-notify-secret to confirm.")
3. **DB column drop with data loss** — today either NO-GO or CONFIRM depending on the path. Tier 3 makes the friction explicit: type the table.column name to confirm.
4. **Sending a notification to an unverified channel** — today CONFIRM. Tier 3 requires confirming the destination address (operator types the email/chat-id substring).
5. **Granting a long-duration trust scope** (e.g., >24h, or with high action-count cap) — today CONFIRM. Tier 3 requires re-confirmation 5 minutes after grant (catches "operator was distracted, approved by reflex").

**Lex Insculpta posture**: Tier 3 is part of "harm without consent" prevention. The friction step IS the consent — a click that took deliberate effort is meaningfully different from a click that didn't.

---

## Reference reading

1. `CLAUDE.md` — invariants (tests-are-derivative + never-lose-files + NO-GO handoff)
2. `storm-pass-2/lex-insculpta.md` (OneDrive personal) — the governance law
3. `src/security/trust-scopes.ts` — current scope model
4. `src/steward/decisions.ts` — current `await_decision` + `respond_to_decision` flow
5. `src/dashboard/pages/settings.ts` — F2 pending-scopes panel pattern; Tier 3 UI lives next to it
6. `proposed/host-exec-tool-bom.md` — the host_exec allowlist semantics (which is where Tier 3 categorization gets applied)
7. `proposed/v0_6-notifications-bom.md` — notifications, since one of the Tier 3 categories is "send to unverified channel"
8. Memory: `project_stavr_four_tier_approval_model.md` — the 4-tier model definition

---

## Don't touch

- `src/security/host-exec-runner.ts` — spawn semantics unchanged
- `src/persistence.ts` schema except for additive `tier_3_confirmations` table in P1
- `src/worker/`, `src/mcp/` except the decision-handler wiring in P2
- `src/dashboard/pages/*` except `settings.ts` (Tier 3 confirmation modal) and `decide.ts` (different visual treatment for Tier 3 items)
- `ecosystem.config.cjs`, `package.json` deps (no new deps for this; pure UX/logic addition)
- The Tier 1/2/4 paths — this PR only ADDS Tier 3, doesn't change existing tiers' behavior

---

## Hard rules

1. **Tests are derivative** — if existing decision-flow tests assert "decisions have status: pending|approved|denied", extend to "pending|pending-confirmation|approved|denied" in the same commit
2. **Never lose files** — `stat -c %s` + `tail -5` verify before commit for any file >15KB
3. **Tier 3 friction MUST be unforgeable** — the operator types a string, that string is compared on the server (not client) to a stored expected value. No "trust the form's hidden field" patterns
4. **Tier 3 cannot be auto-confirmed** — even if the operator has an active high-trust scope, Tier 3 actions still require the friction step. No bypass.
5. **Tier 3 confirmations are one-shot and audit-logged** — every Tier 3 approval emits `tier_3_confirmed { action_id, operator_input, expected_input, matched, timestamp }`. Failed match emits `tier_3_confirmation_failed` (also logged, useful for detecting fat-fingers vs. typo-attacks)
6. **Tier 3 confirmation has a hard time-out** — operator has 60 seconds from the friction prompt appearing to submit the correct string. After that the action expires and must be re-requested. Prevents "approved 2 hours ago, action sits in queue, executes when operator isn't watching."
7. **The friction string must be specific to the action** — generic "yes" or "confirm" defeats the point. The string is derived from the action's target (table name, branch name, secret label, destination address) so muscle memory doesn't bypass deliberation
8. **DCO -s, per-phase commits, push at end of each phase. One PR per phase-group (2 PRs)**

---

## Phase-group structure (2 PRs)

| PR | Phases | Scope | Wall-clock |
|---|---|---|---|
| #1 — Mechanism | P0, P1, P2 | Tier 3 decision flow + friction string generator + UI modal | 5–7h |
| #2 — Promotion | P3, P4 | Promote N existing actions from CONFIRM to EXPLICIT + docs | 3–5h |

PR #1 ships the mechanism with one example Tier 3 action wired (force-push). PR #2 systematically promotes the rest.

---

## P0 · Pre-flight (Kenneth, before CC kicks off)

~5 min. Operator confirms:

1. `git status` clean on `main`, current HEAD includes PR #29 (host_exec curl+gh), PR #30 (revert), PR #31 (v0.5 portability)
2. `npm test --run` baseline = 787+ passing (post-v0.5)
3. Decide on initial promotion list (operator's call — recommended set documented in P3 below; can be edited at P3 start without rewriting earlier phases)
4. Dispatch CC with PR #1 brief

---

## P1 · Tier 3 decision model + persistence (PR #1, 2–3h)

**Files**:
- `src/security/tiers.ts` (new or extend existing) — `Tier` enum: `auto | confirm | explicit | no_go`
- `src/security/explicit-friction.ts` (new) — friction string generators (per Tier 3 action type)
- `src/steward/decisions.ts` — extend `Decision` model with `tier`, `friction_expected`, `friction_submitted`, `confirmed_at`
- `migrations/00X_tier_3_confirmations.sql` — additive table for Tier 3 audit trail
- `tests/security/tiers.test.ts`
- `tests/security/explicit-friction.test.ts`
- `tests/steward/decisions-tier-3.test.ts`

### Schema (additive only)

```sql
ALTER TABLE decisions ADD COLUMN tier TEXT NOT NULL DEFAULT 'confirm';
ALTER TABLE decisions ADD COLUMN friction_expected TEXT;
ALTER TABLE decisions ADD COLUMN friction_submitted TEXT;
ALTER TABLE decisions ADD COLUMN confirmed_at INTEGER;
ALTER TABLE decisions ADD COLUMN friction_expires_at INTEGER;

CREATE TABLE tier_3_confirmations (
  id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL,
  operator_input TEXT NOT NULL,        -- what they typed
  expected_input TEXT NOT NULL,        -- what they should have typed
  matched INTEGER NOT NULL,            -- 0 or 1
  attempted_at INTEGER NOT NULL,
  ip TEXT,                              -- source IP if HTTP
  source TEXT NOT NULL,                -- 'dashboard' | 'webhook' | 'cli'
  FOREIGN KEY (decision_id) REFERENCES decisions(id)
);

CREATE INDEX idx_tier_3_confirmations_decision ON tier_3_confirmations(decision_id);
```

Note: SQLite can't `ALTER … DROP CONSTRAINT` — use idempotent ALTERs guarded by `pragma_table_info` checks (pattern already in `src/persistence.ts`).

### Friction string generators

Each Tier 3 action type has a generator. Examples:

```ts
// Force-push beyond reflog window
function frictionForForcePush(branch: string, reflogPurgeDate: string): string {
  return `${branch}-${reflogPurgeDate}`;  // e.g., "main-2026-08-17"
}

// Secret rotation
function frictionForSecretRotation(secretLabel: string): string {
  return secretLabel.toLowerCase().replace(/_/g, '-');  // e.g., "stavr-notify-secret"
}

// DB column drop
function frictionForColumnDrop(table: string, column: string): string {
  return `${table}.${column}`;  // e.g., "notifications.consumed_by"
}

// Send notification to unverified channel
function frictionForUnverifiedChannel(channelType: string, addressSuffix: string): string {
  return `${channelType}:${addressSuffix}`;  // e.g., "email:@new-domain.com"
}

// Long-duration trust scope (re-confirm after 5min delay)
function frictionForLongScope(scopeName: string, durationHours: number): string {
  return `${scopeName}-${durationHours}h`;  // e.g., "deploy-prod-72h"
}
```

### Acceptance

- `Decision` model accepts and persists `tier`, `friction_expected`, etc.
- All 5 friction generators have unit tests covering normal + edge cases
- Tier enum + helper `isReversible(tier)` works
- 6+ new tests passing

### Commit
`feat(security): tier 3 EXPLICIT decision model + friction string generators`

---

## P2 · Dashboard UI + decision flow (PR #1, 3–4h)

**Files**:
- `src/dashboard/pages/decide.ts` — Tier 3 items render differently (red border, warning icon, "EXPLICIT consent required")
- `src/dashboard/components/explicit-modal.ts` (new) — friction-input modal with the typed-string field
- `src/dashboard/data/decisions.ts` — extend fetcher to return tier + friction_expected
- `src/steward/decisions.ts` — `respond_to_decision` handler validates friction string for Tier 3
- `tests/dashboard/decide-tier-3.test.ts`
- `tests/dashboard/explicit-modal.test.ts`
- One example action wired as Tier 3: `host_exec git push --force-with-lease` to a protected branch (most narrowly-scoped real example)

### UI design

`.glass` modal that opens when operator clicks "Approve" on a Tier 3 decision:

```
┌─ EXPLICIT CONFIRMATION REQUIRED ─────────────────┐
│ ⚠ This action is irreversible.                    │
│                                                   │
│ Action: Force-push to refs/heads/main             │
│ Risk: rewrites commit history beyond reflog       │
│                                                   │
│ To confirm, type: main-2026-08-17                 │
│ [____________________________]                    │
│                                                   │
│ Time remaining: 0:58                              │
│                                                   │
│ [Cancel]                       [Confirm Action]   │
└───────────────────────────────────────────────────┘
```

- Friction string is NEVER pre-filled — operator must type it from the visible label
- Submit button disabled until input matches expected (UX hint only; server still validates)
- Time remaining counts down from 60s; modal closes on expiry, decision returns to pending
- ESC key dismisses modal but does NOT consume the decision (operator can re-open from list)

### Acceptance

- Tier 3 decision in queue shows red-border + warning treatment in `/dashboard/decide`
- Clicking approve opens the friction modal
- Correct string + click confirms → action executes, audit log written
- Wrong string + click → modal stays open with error, attempt logged as `tier_3_confirmation_failed`
- 60s timeout returns decision to pending state, friction must re-render
- 5+ new tests passing

### Commit
`feat(dashboard): tier 3 EXPLICIT friction modal + decide page treatment`

### Open PR #1

`feat(security+dashboard): tier 3 EXPLICIT consent mechanism (force-push example wired)`

---

## P3 · Promote existing actions to Tier 3 (PR #2, 2–3h)

**Files**:
- `src/security/host-exec-allowlist.ts` — annotate eligible entries with `tier: 'explicit'`
- `src/steward/decisions.ts` — apply Tier 3 to relevant MCP tool categories
- `tests/security/host-exec-tiers.test.ts` — assert Tier 3 promotion is correct

### Recommended initial promotion set

Operator decides at P3 start; this is a starting list:

| Action | Today's tier | Promote to | Friction |
|---|---|---|---|
| `gh pr merge` (after allowlist) | NO-GO (excluded) | EXPLICIT | type PR number + branch name |
| `git push --force-with-lease` to `main` | SCOPE+CONFIRM | EXPLICIT | branch + reflog-purge-date |
| `trust_scope_grant` with duration > 24h | CONFIRM | EXPLICIT | scope-name + duration-hours |
| `trust_scope_grant` with expires_after_actions > 50 | CONFIRM | EXPLICIT | scope-name + action-cap |
| Notification to unverified channel destination | CONFIRM | EXPLICIT | channel-type + address-suffix |
| Allowlist expansion PR merge (changes to `host-exec-allowlist.ts`) | CONFIRM | EXPLICIT | "allowlist-expand-" + binary-name |
| Daemon shutdown (if exposed via MCP) | NO-GO | stays NO-GO | n/a |
| Delete arbitrary file outside git working tree | NO-GO | stays NO-GO | n/a |

### Acceptance

- Tier 3 actions identified, marked, and tested
- Negative-path tests: simulate operator submitting CONFIRM-tier input on a Tier 3 decision → rejected
- 6+ new tests passing

### Commit
`feat(security): promote merge/force-push/long-scope/allowlist-changes to tier 3`

---

## P4 · Docs + telemetry (PR #2, 1–2h)

**Files**:
- `docs/approval-tiers.md` (new) — operator-facing explanation of the 4 tiers + reversibility rule + when each is used
- `CLAUDE.md` — extend section 8 (was 7 before NO-GO handoff insertion) with 4-tier mention if not already present
- `CHANGELOG.md` — v0.7 entry
- Optional: `/dashboard/diagnostics` chart for "tier 3 friction success rate" (catches if operator is fat-fingering often, suggesting friction string is too cryptic)

### Acceptance

- New operator can read `docs/approval-tiers.md` and understand when to expect each tier
- v0.7 CHANGELOG entry lists every promoted action

### Commit
`docs: 4-tier approval model + v0.7 tier 3 EXPLICIT changelog`

### Open PR #2

`feat: promote N actions to tier 3 EXPLICIT + operator docs`

---

## Budget

- **Time**: 8–12h CC sequential across 2 PRs
- **API cost**: ~$8–15
- **LOC change**: ~800–1,100 net across `src/security/`, `src/dashboard/`, `migrations/`, `tests/`, `docs/`
- **Token cap**: 1M (split across 2 worker runs)
- **New deps**: none — pure additive logic + UI
- **Schema change**: 5 additive ALTER COLUMNs on `decisions` + 1 additive table

---

## Footgun appendix

1. **Friction strings derived from sensitive data** — never use API keys, tokens, or full file paths as the friction string. Use labels or suffixes that identify the action but leak no secrets. Generator unit tests should fuzz with secret-looking inputs to catch this.
2. **Browser autofill** — disable autofill on the friction input (`autocomplete="off"` + `name` not matching common patterns). Operator typing "main-2026-08-17" 50 times means browsers will offer to fill it next time.
3. **Clipboard paste** — DO allow paste (operator might want to paste from the modal label for accuracy). The friction is "deliberate typing or copying," not "no clipboard."
4. **Friction string visible to AI** — the AI proposing the action knows the friction string (it generated it). This is fine — the friction protects against operator fat-fingering / inattention, NOT against malicious AI. Lex Insculpta covers the malicious-AI threat at a different layer.
5. **60s timeout vs slow operator** — 60s is enough for a focused operator but tight if they're mid-conversation. If timeout-on-pending becomes a UX complaint, raise to 120s. Don't go higher — long-pending Tier 3 decisions are the threat model.
6. **Decision queue UI ordering** — Tier 3 items should sort to top of `/dashboard/decide` regardless of age. Operator should see scary items first, not buried.
7. **Re-confirmation timer for long scopes** — Hard rule §6 mentions "re-confirmation 5 min after grant" for long-duration scopes. This is a SECOND friction step, not the same as the initial one. Implementation: schedule a `tier_3_reconfirm_due` event 5 min post-grant; if not re-confirmed within 15 min, auto-revoke the scope. Operator can pre-confirm by hitting "Confirm now" in the modal.
8. **Tier 3 from CLI** — if `stavr-cli` exposes any action that promotes to Tier 3, the CLI must prompt for the friction string interactively (not via flag — flags get logged in shell history). For unattended scripts, Tier 3 is just not callable; that's correct.
9. **Notification reply ≠ Tier 3 approval** — the v0.6 notifications BOM lets operators approve decisions via Telegram/email reply. Tier 3 decisions MUST NOT be replyable via notification — they require dashboard friction. Notification for Tier 3 = "go to dashboard" link only, no inline approve button.
10. **Migration timing** — the ALTER COLUMNs on `decisions` MUST be idempotent (use `pragma_table_info` check) since `start.sh` re-runs init-db.ts on every boot. Pattern already in repo.

---

## Open questions (FLAGGED — do not pre-answer)

### §1 — Should the friction string be operator-customizable?

E.g., operator hates typing "main-2026-08-17" and prefers "yes-really". 

**Default**: NO. Custom friction defeats the point — the action-specific string forces re-reading the action context. If operator wants softer friction, the right answer is to demote the action to Tier 2 (back to one-click) via a code change.

### §2 — Should Tier 3 require typing OR a second device (e.g., phone)?

E.g., operator must scan a QR code on their phone for the action to proceed.

**Default**: typing is enough for v0.7. Second-device is a future Tier 3.5 candidate for "actions that are not just irreversible but also have legal/financial blast radius" — out of scope here.

### §3 — Should the friction string include a hash of the action payload?

E.g., "approve scope grant for `deploy-prod` (sha256 prefix abc123)" — operator types `deploy-prod-abc123`. This prevents an attacker from modifying the action between the operator reading it and clicking approve.

**Default**: not in v0.7. The action payload is server-rendered and the friction string is generated server-side at the same moment. Tampering would require server-side compromise, which is a higher-order problem. Add if a specific threat model emerges.

### §4 — What happens if the operator submits the friction string from a different device than the one showing the modal?

E.g., dashboard open on laptop, friction modal pops up, operator accidentally types on phone (Telegram bot or webhook).

**Default**: only the dashboard modal accepts friction input. Notification replies for Tier 3 actions show "go to dashboard" link, period. Hard rule §9 enforces this.

### §5 — Should there be a "global Tier 3 freeze" toggle for high-risk windows (e.g., during a production incident)?

E.g., operator hits a button that disables all Tier 3 approvals for the next N minutes until they explicitly un-freeze.

**Default**: not in v0.7. The Tier 3 friction itself is the safety; a global freeze would also block legitimate-but-urgent Tier 3 actions during incidents (which is when they're most needed). Revisit if operator finds themselves blocking actions they shouldn't.

---

## Run prompt for CC (PR #1, paste at start)

```
Read CLAUDE.md first. Then read proposed/v0_7-tier-3-explicit-consent-bom.md and execute P0 (operator pre-flight) acceptance check followed by P1 and P2 sequentially.

This is Lex Insculpta-compliant scope expansion: Tier 3 EXPLICIT is the "harm without consent" prevention layer for irreversible actions. The friction string IS the consent — a click that took deliberate effort is meaningfully different from a click that didn't.

Rules:
- One commit per phase, DCO sign-off (-s)
- Don't pause for approval between phases inside this PR. Commit + push at end of each phase
- For any file >15KB after edit, run `stat -c %s file` + `tail -5 file` BEFORE git add
- `npm test` must pass after every commit. If a phase regresses, fix in the same phase commit
- After P2 opens PR, output a final delta report and STOP. Don't auto-merge. Don't proceed to PR #2 (P3-P4)

The brief is self-contained. Open questions §1-§5 are flagged — pick the conservative default during implementation and note in PR body, don't block.

Go.
```

## Run prompt for CC (PR #2, paste at start)

```
Read CLAUDE.md first. Then read proposed/v0_7-tier-3-explicit-consent-bom.md.

PR #1 (P1-P2) is merged. Your scope: P3 (promote actions to Tier 3) and P4 (docs). Open PR at end of P4.

Same rules as PR #1. The promotion list in P3 is a recommendation — operator will confirm the final list at P0 of this run. Go.
```

---

## End of brief
