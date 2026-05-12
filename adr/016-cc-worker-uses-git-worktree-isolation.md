# ADR 016 — Every CC worker spawns into a dedicated `git worktree`

**Status**: Accepted
**Date**: 2026-05-12

## Context

A single Cowire daemon will commonly run two or more Claude Code workers in the *same* repository — one fixing B-001 on `feat/b001`, another addressing review comments on `feat/b002`, a third spiking on `experiment/x`. The naive design (each CC worker sets `cwd` to the shared repo root and uses `git checkout <branch>`) corrupts immediately:

- Workers fight over `HEAD`. One worker's `git checkout` silently drags another worker's open files onto the wrong branch.
- Uncommitted changes from worker A appear in worker B's diff because they share a single working tree.
- Concurrent `git index` writes collide. SQLite-style WAL doesn't apply.

State-of-the-art 2026 agent orchestrators all solved this the same way:

- **Conductor** — one git worktree per agent.
- **Vibe Kanban** — one git worktree per task.
- **Claude Squad** — one git worktree per Claude session.

The pattern is settled: each Claude session gets its own checkout. The shared repo is the source of branches and remotes; each worker's working tree is its own directory.

## Decision

Every `cc`-type worker spawns into a dedicated `git worktree`. The default path is `<repo_path>/.cowire-worktrees/<worker-name>`; the `worktree_base` spawn parameter can override (e.g. `~/.cowire/worktrees/<repo-hash>/<worker-name>` for users who want them outside the repo).

The spawn sequence is:

1. Validate that `repo_path` is a real Git repo (`git -C <repo_path> rev-parse --git-dir`).
2. `git -C <repo_path> fetch origin <base>` (best-effort; tolerates offline).
3. `git -C <repo_path> worktree add <worktree-path> -B <branch> origin/<base>` — creates the branch from base AND checks it out into the dedicated directory.
4. Write `<worktree-path>/.cowire-mcp.json` so the spawned CC connects to the running daemon.
5. Spawn `claude` with `cwd = <worktree-path>`, not the original repo path.

On worker termination (or crash), if `cleanup_on_terminate` is true (default), `git -C <repo_path> worktree remove --force <worktree-path>` cleans up the worktree directory. The branch itself persists in the repo — only the working-tree dir is removed. Users who want to inspect post-mortem set `cleanup_on_terminate: false`.

The worker's `metadata` exposes `worktree_path`, `repo_path`, `branch`, and `base` so the dashboard can render "open in editor" or "navigate to working tree" actions.

## Consequences

- **Parallel CC workers in the same repo are correct by construction.** Worker A's `git add . && git commit` does not touch worker B's tree, ever.
- **Branches are first-class.** Each worker's branch lives in the shared repo, can be pushed independently, can be PR'd independently. The worktree is a temporary view; the branch is the durable artifact.
- **chokidar watches the worktree's `.git`, not the repo's.** Per-worker event sources don't fan out across workers. (See [ADR-012](./012-event-driven-over-polling.md).)
- **Disk cost.** Each worktree contains a working copy of the repo; a 200 MB repo with 5 active workers uses ~1 GB. Acceptable; cleanup on terminate reclaims it. The `worktree_base` override exists for users who want worktrees on a different volume.
- **Worktree paths under `.cowire-worktrees/` should be `.gitignore`-ed in the host repo.** We do not automatically modify the user's `.gitignore`; the contributing guide documents the recommendation. Future improvement: write `.gitignore` inside `.cowire-worktrees/` so the host repo never sees them as untracked anyway.

## Alternatives considered

- **`git checkout` per worker on a shared tree.** Documented above — corrupts on the first concurrent operation.
- **Clone the repo per worker.** Heavier than worktree (full `.git` copy). Worktrees share the object store, so disk and network costs are far lower.
- **Run each worker on a `git stash` slice of the shared tree.** Cute, but the moment a worker commits, the model breaks.
- **Skip isolation, document the limitation, only run one CC worker per repo at a time.** Defeats the "multiple parallel workers" use case spec 42 was written for.

## See also

- Conductor's worktree-per-agent design (the prior art that crystallized this pattern).
- [ADR-013](./013-single-workers-table-with-type-discriminator.md) — `worktree_path` lives in `metadata_json`, not a typed column.
- `src/workers/cc.ts` — the implementation.
