# ADR 003 — `gh` CLI in the GitHub adapter

**Status**: Accepted
**Date**: 2026-05-12

## Context

The GitHub adapter exposes 14 read-only tools (PRs, issues, commits, files, workflow runs, etc.). It needs to authenticate as the user, handle GitHub's rate limits, and stay current with new endpoints over time. There are two obvious implementation paths: shell out to the official `gh` CLI, or call the REST API directly with a library like Octokit.

## Decision

The adapter shells out to `gh` via `child_process.execFile`, wrapped in `ghExec` in `src/adapters/github.ts`. It does not import any GitHub SDK. Switch never sees a personal access token; auth is inherited from whoever ran `gh auth login` on the host.

## Consequences

- **No PAT plumbing.** Switch has no token to store, leak, scope, or rotate. The user's existing `gh auth login` is the single source of truth.
- **Auth model = host user.** Tools run with the privileges of whoever is logged in to `gh`. This is the right default for a local broker — agents act *as* the user, not above them.
- **Coverage tracks `gh`.** Every endpoint `gh` exposes is available; new GitHub features show up as soon as the user updates `gh`.
- **Process overhead.** Each call forks a `gh` process — typically 0.5–3s. Acceptable for human-paced agent workflows; would be wrong for high-throughput automation.
- **Operational dependency.** `gh` must be on PATH and authenticated. Failures surface as a structured `gh_failed` error with `stderr` for diagnostics (see `GhExecError`).

## Alternatives considered

- **Octokit / @octokit/rest.** Faster per-call (no subprocess) but requires the user to provision a token, gives Switch privileges to leak, and we'd have to track GitHub API drift in our dependency tree.
- **Direct `fetch` against api.github.com.** Same auth problem as Octokit without the SDK ergonomics. No win.
- **A pluggable backend** (gh CLI today, Octokit tomorrow). YAGNI — adds an interface layer for a switch we may never make.
