# Writing a spec with a trust scope

This is the playbook for batched, plan-driven work in Cowire after spec 46.
Use it whenever an agent (Co, CC, another future agent) is about to do
something repetitive enough that approving each call separately stops making
sense — bug-migrations, multi-PR roll-outs, label sweeps, dependency bumps
across N repos.

The end state is: one human decision ("lets go"), then a stream of progress
events, then a final completion summary. Every action is auditable back to
the scope that authorized it.

---

## 1. Decide whether you need a scope

Use a trust scope when **all** of the following are true:

- The work is a sequence of CONFIRM-tier calls (e.g. `github.create_issue`,
  `github.add_labels`, `worker_spawn`).
- The set of tool calls is *predictable* — you can describe in advance which
  tools and which params.
- You can put a tight bound on time and action count (default: 1 hour, 20
  actions; lower is better).

Use the old per-action `await_decision` when:

- The work is one-off (one PR merge, one issue close).
- The repo/params change mid-stream in ways you can't predict.
- The action touches NEVER-tier flags (force-push, branch delete, repo
  settings) — these never go through a scope (ADR-018).

---

## 2. Draft the spec

Write the spec the way you'd write any other Cowire spec, plus one section:
**Scope shape**. Be concrete. Example, for migrating `BUGS.md` to GitHub
issues:

```
Scope: "Migrate BUGS.md to GitHub Issues"
Allowed:
  github.create_issue { repo: "Kstkoda/privacy-tracker" }
  github.add_labels   { repo: "Kstkoda/privacy-tracker" }
Forbidden: (none)
Expires: granted_at + 30 min, max 20 actions
Reporting: every-5-actions to chat, event-log
```

A few rules of thumb:

- **One scope per spec.** If the spec needs two unrelated scope shapes, it's
  two specs.
- **Tightest matchers first.** Prefer `{ repo: "Kstkoda/privacy-tracker" }`
  over `{ repo: "^Kstkoda/.*" }`. Regex is the relief valve; exact is the
  default.
- **Cap conservatively.** 20 actions is enough for a 10-issue migration with
  retries to spare. 50 is rarely right unless the spec explicitly justifies it.
- **30 minutes is plenty.** A scope that needs 2 hours probably wants to be
  split into two scopes with a checkpoint between.

---

## 3. Propose the scope

The agent doing the work calls `trust_scope_propose` with the matchers from
the spec. This logs `trust_scope_proposed` and visibly notifies any agent
subscribed to that event kind. No human decision yet.

```json
{
  "title": "Migrate BUGS.md to GitHub Issues",
  "description": "Create issues B-001..B-010 in Kstkoda/privacy-tracker, label as 'migrated-from-bugs-md'.",
  "allowed_actions": [
    { "tool": "github.create_issue", "param_constraints": { "repo": "Kstkoda/privacy-tracker" } },
    { "tool": "github.add_labels",   "param_constraints": { "repo": "Kstkoda/privacy-tracker" } }
  ],
  "expires_after_actions": 20,
  "expires_at": "2026-05-12T17:00:00.000Z",
  "reporting": { "cadence": "every-5-actions", "channels": ["chat", "event-log"] },
  "spec_url": "specs/46_trust_scopes_for_autonomous_execution.md"
}
```

The tool returns `{ scope_id }`. The scope is in status `proposed`.

---

## 4. Get the grant

Kenneth (or whoever has authority) reads the proposal and says "lets go" in
chat. The agent relays that as a `trust_scope_grant` call:

```json
{ "id": "ts-...", "granted_by": "user-direct" }
```

`trust_scope_grant` opens an `await_decision` ("Grant scope: <title>?"). The
person at the console approves (or rejects) once. On approve, the scope flips
to `active` and `trust_scope_granted` is emitted.

**This is the only approval moment in the lifecycle.** Everything after is
autonomous within the scope.

---

## 5. Execute

The agent does its work. Every covered call runs immediately:

```
github.create_issue({ repo: 'Kstkoda/privacy-tracker', title: 'B-001 …', body: '…' })
→ runs, returns issue_url
→ trust_scope_action_authorized event (scope_id=ts-…, tool=github.create_issue, args=…)
→ progress event (after the 5th, 10th, … action depending on cadence)
```

If the agent tries something **outside** the scope — say `github.merge_pr` —
the gated-action helper sees no covering matcher and opens a normal
`await_decision`. That's the exception flow: it does not break the rest of
the in-scope work, and Kenneth can decide that one call on its own.

---

## 6. Watch progress, revoke if needed

Subscribe to `trust_scope_progress` and `trust_scope_completed` to follow
along. At any point you can call `trust_scope_revoke({ id })` — that's the
escape hatch. After revoke, the next in-scope call will gate normally.

If 30 minutes turns out to be too short, call `trust_scope_extend` and
approve the (second) decision. This is the only other approval you'd see in
a healthy scope lifecycle.

---

## 7. Audit afterwards

```
get_events --kind=trust_scope_action_authorized --since=…
trust_scope_status --id=ts-…
```

`trust_scope_status` returns the full scope row plus every action recorded
against it from `scope_actions`. That's the answer to "what did Co do, under
what authority?"

---

## Worked example end-to-end

Read [`specs/46_trust_scopes_for_autonomous_execution.md`](../../privacy%20tracker/specs/46_trust_scopes_for_autonomous_execution.md)
for the design context, [`adr/022-trust-scopes-supersede-per-action-confirm.md`](../adr/022-trust-scopes-supersede-per-action-confirm.md)
for why this exists, and [`adr/023-param-constraint-matching-syntax.md`](../adr/023-param-constraint-matching-syntax.md)
for the matcher syntax. The BUGS-migration example in this doc is the
first scope-driven workflow we'll run post-merge.
