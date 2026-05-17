# Footgun: Cowork bash sandbox mount shows stale `.git/` state

> When Cowork-Claude operates the repo via the bash sandbox (`/sessions/.../mnt/dev--cowire/`), reads of `.git/` files can return stale or truncated content while the underlying Windows files are intact. Symptom: bash-side `git` errors out with "your current branch appears to be broken" or "Unable to create '.git/index.lock': File exists" while PowerShell shows the repo is fine.

## TL;DR

- **Trust the PowerShell view, not the bash view** when the two disagree about `.git/` state
- Bash heredoc **writes** to working-tree files DO flow through correctly — verify with `dir filename` from PowerShell
- Bash heredoc **writes** to `.git/` files may NOT (don't try to fix HEAD from the bash side)
- When bash `git` errors out: switch to PowerShell, run the op there

## Triggering conditions (observed)

Both observed on 2026-05-17:

1. **`.git/index.lock` ghost**: bash `ls -la .git/index.lock` showed the file present (0-byte, dated earlier in the session); `rm -f` returned "Operation not permitted"; PowerShell `dir .git\index.lock` showed it didn't exist
2. **`.git/HEAD` truncation**: bash `cat .git/HEAD` returned `ref: refs/heads/feat/` (branch name cut off); PowerShell `type .git\HEAD` returned the full `ref: refs/heads/feat/v0.5-steward-portability`

The bash view appears to be a stale snapshot taken at some point earlier in the session and not invalidated when Windows-side writes happen.

## Recovery transcript (2026-05-17, real session)

After the bash sandbox claimed the repo was broken and refused to commit `proposed/v0_6-notifications-bom.md`, the operator verified from PowerShell and recovered the BOM cleanly:

```
PS C:\dev\cowire> type .git\HEAD
ref: refs/heads/feat/v0.5-steward-portability

PS C:\dev\cowire> git reflog -10
bf6138c (HEAD -> feat/v0.5-steward-portability, origin/feat/v0.5-steward-portability) HEAD@{0}: commit: feat(steward-agent): subprocess extraction + PM2 supervision (P3 of v0.5)
8a69afe HEAD@{1}: commit: feat(steward-agent): Model Runtime interface — Anthropic / OpenAI / Ollama (P2 of v0.5)
740a453 (main) HEAD@{2}: checkout: moving from main to feat/v0.5-steward-portability
740a453 (main) HEAD@{3}: commit: feat(steward-agent): three-layer state stores — memory / lessons / prefs (P1 of v0.5)
22e4f4b (origin/main, origin/HEAD) HEAD@{4}: pull --ff-only origin main: Fast-forward
4bb418b HEAD@{5}: checkout: moving from feat/host-exec-curl-gh-allowlist to main
5a85e28 (feat/host-exec-curl-gh-allowlist) HEAD@{6}: pull origin main: Merge made by the 'ort' strategy.
5ebc18a (origin/feat/host-exec-curl-gh-allowlist) HEAD@{7}: commit: test(security): host-exec allowlist invariant META tests
91907df HEAD@{8}: commit: feat(security): host-exec allowlist + gh (GitHub CLI, read-mostly)
a8ece7b HEAD@{9}: commit: feat(security): host-exec allowlist + curl (loopback-only, read-only HTTP)

PS C:\dev\cowire> dir proposed\v0_6-notifications-bom.md
    Directory: C:\dev\cowire\proposed
Mode                 LastWriteTime         Length Name
----                 -------------         ------ ----
-a----         5/17/2026   1:44 PM          28126 v0_6-notifications-bom.md

PS C:\dev\cowire> Get-Content proposed\v0_6-notifications-bom.md -Tail 5
```

---

## End of brief

```
PS C:\dev\cowire> git stash push -u proposed/v0_6-notifications-bom.md -m "v0.6 notifications BOM"
Saved working directory and index state On feat/v0.5-steward-portability: v0.6 notifications BOM

PS C:\dev\cowire> git checkout main
Switched to branch 'main'

PS C:\dev\cowire> git stash pop
Already up to date.
On branch main

PS C:\dev\cowire> git add proposed/v0_6-notifications-bom.md
PS C:\dev\cowire> git commit -s -m "docs(proposed): v0.6 notifications BOM — multi-channel + bidirectional + UI"
[main 22aae6f] docs(proposed): v0.6 notifications BOM — multi-channel + bidirectional + UI
 1 file changed, 488 insertions(+)
 create mode 100644 proposed/v0_6-notifications-bom.md

PS C:\dev\cowire> git push origin main
   351b6f9..22aae6f  main -> main

PS C:\dev\cowire> git checkout feat/v0.5-steward-portability
Switched to branch 'feat/v0.5-steward-portability'
```

Key observations from this transcript:
- The bash-side `git status` had reported 393 files staged with "No commits yet" — pure mount-cache fiction. PowerShell saw 4 untracked files (correct).
- The BOM that bash heredoc wrote landed on disk fine (28,126 bytes, content intact through `Get-Content -Tail`). Writes to working-tree files DO propagate.
- Recovery path was just "use PowerShell" — no manual `.git/` repair needed.

## Recipe when this hits again

1. **Stop the bash op immediately** — don't try recovery patterns like `rm -f .git/index.lock` from bash, they'll fail with "Operation not permitted" and waste time
2. Hand control to operator with a precise PowerShell sequence
3. Operator runs `type .git\HEAD` + `git reflog -5` to confirm the repo is actually fine
4. Operator runs the git op from PowerShell
5. Future bash ops in the same session may still see stale state — but as long as no git op is needed from bash, work continues

## Why this probably happens

The Cowork sandbox mounts Windows directories via a translation layer that caches some files (likely for performance) and doesn't invalidate aggressively when the Windows side mutates them. `.git/` files are particularly affected because:
- They mutate often (HEAD on every checkout, index on every add, locks on every concurrent op)
- They're small (most are < 100 bytes) so they fit in whatever cache the translation layer uses
- Git is unusually sensitive to byte-exact state (a truncated HEAD breaks the whole repo from git's POV)

Working-tree files (source code, BOMs, docs) seem to round-trip fine through the same layer — probably because they're written less frequently and the cache invalidates on write rather than on time.

## Not yet investigated

- Whether `pm2 restart stavr` or daemon-process churn correlates with cache-corruption events
- Whether the cache can be flushed without restarting the Cowork session
- Whether the symptom is reproducible (so far: opportunistic, hit twice on 2026-05-17)
- Whether other operators of Cowork hit the same — worth filing upstream if it persists
