# Steward bug-fix orchestration (stream C C1)

`stavr steward bug-fix --issue <ref>` is the first end-to-end glue that takes a
GitHub issue and turns it into a Steward dispatch. The actual code-writing
happens elsewhere — this command is the orchestration layer.

## What the command does

```
gh issue view              compose                buildScopeProposal
  ┌──────────┐              ┌────────┐              ┌────────────┐
  │  issue   │ ───────────► │ brief  │ ───────────► │  scope     │
  │  JSON    │              │  .md   │              │  proposal  │
  └──────────┘              └────────┘              └────────────┘
                                                          │
                                       ┌──────────────────┼──────────────────┐
                                       ▼                  ▼                  ▼
                              trust_scope_         trust_scope_       steward_prompt
                              proposed             granted (if        POST to spec-49
                              event                STAVR_AUTO_       /dashboard/
                                                   APPROVE_BUG_       steward/prompt
                                                   FIXES=1)
```

1. Parses `--issue` (any of `owner/repo#42`, `owner/repo/issues/42`, or the
   full github.com URL).
2. Calls `gh issue view --json …` to fetch the issue body, labels, state, URL.
3. Renders a deterministic Markdown brief with the issue header + body + an
   explicit numbered action list including "Stop after the PR opens — wait for
   review before any follow-up."
4. Builds a narrowly-scoped trust-scope proposal: `github.create_pr`,
   `github.create_pr_comment`, `github.create_issue_comment` for the issue's
   repo only. Forbids `github.merge_pr` and `github.close_issue`. 6-hour TTL,
   20-action cap by default.
5. Emits `trust_scope_proposed` to the daemon via the loopback-only
   `/internal/emit` endpoint.
6. If `STAVR_AUTO_APPROVE_BUG_FIXES=1` (or `true`) is set, also emits
   `trust_scope_granted` — Kenneth's pre-consent for autonomous overnight
   runs. Without it, the proposal sits in the dashboard awaiting an operator
   click.
7. POSTs the Markdown brief to `/dashboard/steward/prompt` (the existing
   spec-49 route) and returns a `correlation_id` the operator can use to
   follow the conversation in the dashboard chat panel.

## What it does NOT do (yet)

- Spawn a CC worker. That's the Steward subprocess's job (spec 49 in PR #22,
  which isn't on this branch's base). Until #22 merges, the `steward_prompt`
  event is consumed by the operator reading the dashboard chat panel.
- Open the PR. The worker does that once dispatched.
- Auto-close the issue or merge the PR — forbidden_actions explicitly blocks
  both. Closing the source issue is the operator's call.

When #22 lands and the Steward subprocess hooks into `steward_prompt`, the
whole flow becomes hands-off: file a bug, run `stavr steward bug-fix`, walk
away, return to a draft PR.

## CLI surface

```sh
# Synchronous: parse the ref, fetch the issue, compose the brief, propose
# the scope, dispatch. Prints correlation_id on success.
stavr steward bug-fix --issue Kstkoda/privacy-tracker#42

# Auto-approve the trust scope (for unattended runs).
STAVR_AUTO_APPROVE_BUG_FIXES=1 stavr steward bug-fix --issue Kstkoda/privacy-tracker#42

# Dry-run: prints the scope proposal + brief preview as JSON, never contacts
# the daemon. Used by smoke and CI.
stavr steward bug-fix --issue Kstkoda/privacy-tracker#42 --dry-run

# Custom daemon URL (default reads the PID file).
stavr steward bug-fix --issue ... --daemon-url http://nas.local:7777

# Tighter scope (1-hour TTL, max 5 actions).
stavr steward bug-fix --issue ... --ttl-hours 1 --action-cap 5
```

## Dry-run output shape

```json
{
  "dry_run": true,
  "issue": "Kstkoda/privacy-tracker#42",
  "brief_id": "a1b2c3d4",
  "scope": {
    "scope_id": "scope-bug-fix-privacy-tracker-42-a1b2c3d4",
    "title": "bug-fix: Kstkoda/privacy-tracker#42",
    "description": "...",
    "allowed_actions": [
      { "tool": "github.create_pr", "param_constraints": { "repo": "Kstkoda/privacy-tracker" } },
      { "tool": "github.create_pr_comment", "param_constraints": { "repo": "Kstkoda/privacy-tracker" } },
      { "tool": "github.create_issue_comment", "param_constraints": { "repo": "Kstkoda/privacy-tracker", "number": 42 } }
    ],
    "forbidden_actions": [
      { "tool": "github.merge_pr" },
      { "tool": "github.close_issue" }
    ],
    "expires_at": "2026-05-13T06:00:00Z",
    "expires_after_actions": 20,
    "reporting": { "cadence": "every-action", "channels": ["dashboard", "event-log"] }
  },
  "auto_approval": {
    "granted": false,
    "reason": "no STAVR_AUTO_APPROVE_BUG_FIXES env var set"
  },
  "brief_preview": "# Bug-fix request: Kstkoda/privacy-tracker#42 …"
}
```

## Wire format

`POST /internal/emit` (loopback only — refuses non-local with 403):

```json
{
  "kind": "trust_scope_proposed",
  "at": "2026-05-13T00:00:00.000Z",
  "source_agent": "stavr-steward-bug-fix-cli",
  "correlation_id": "scope-bug-fix-privacy-tracker-42-a1b2c3d4",
  "payload": { "scope_id": "...", "title": "...", "allowed_actions": [...] }
}
```

Returns `{ "ok": true }` on success. The event is persisted via the broker —
visible to dashboard subscribers, the `/dashboard/events` route, and the
`stavr events` CLI.

`POST /dashboard/steward/prompt` is the spec-49 route this command piggybacks
on (unchanged by C1):

```json
// request
{ "text": "<the full markdown brief>" }
// response
{ "ok": true, "correlation_id": "prompt-1745..." }
```

## Threat model interactions

- The trust scope is *narrow*: only writes to the specific repo named in the
  issue ref. A bug-fix run cannot escalate into changes elsewhere.
- The forbidden_actions list explicitly blocks `merge_pr` and `close_issue` —
  the Steward can propose changes and ask for review, but it cannot land them
  itself.
- `/internal/emit` is loopback-only. Non-local callers get a 403, so the
  audit-event channel cannot be abused from elsewhere on the network.
- `STAVR_AUTO_APPROVE_BUG_FIXES` is the *only* way to short-circuit operator
  consent for the trust scope. The env var is documented; an operator who
  doesn't want autonomous approvals simply doesn't set it.

## Test plan

- Unit (25 cases): `tests/steward-bug-fix.test.ts` — issue-ref parsing,
  brief composition, scope shape, auto-approval decision, fetchIssue
  error surfaces.
- Integration (4 cases): `tests/federation/steward-bug-fix.test.ts` —
  spawns real daemon, points `STAVR_GH_BIN` at a Node-script gh shim,
  verifies events actually persist through the broker (not just that
  the HTTP POST succeeded).
- Smoke: `scripts/smoke/c1-steward-bug-fix.sh` and `.ps1` — runs the
  --dry-run path against a stubbed gh; both verified locally.

## What's next

- **#22 merge**: the Steward subprocess starts consuming `steward_prompt`
  events. The bug-fix CLI becomes end-to-end-autonomous.
- **Real sandbox repo**: `Kstkoda/stavr-test-sandbox` referenced in the
  C-stream brief. Once it exists, the integration tests can run against
  real GitHub (gated on `GH_SANDBOX_LIVE=1`) instead of the fake shim.
- **C2 reusable workflows + C3 benchmark** build on this glue.
