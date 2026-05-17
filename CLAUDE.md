# stavR — project instructions for Claude Code

This file loads at the start of every Claude Code session in this repo. Read it once, follow the invariants throughout.

> **stavR** is a personal MCP gateway daemon — a local-first authority + audit layer that brokers MCP traffic between AI assistants (Claude Code, Cowork, the Codex agent) and tools (GitHub, Slack, Ollama, etc.). The brand mark is `stav` + `ᚱ` (U+16B1, Raido rune). It is NOT an enterprise MCP gateway, NOT multi-tenant, and has no SSO/SCIM. The closest market reference is "1Password for AI tool access" — a personal trust layer.

---

## Hard invariants (read before any code change)

### 1. Tests are derivative, not authoritative

When a brief, mockup, ADR, or my direct instruction conflicts with an existing test assertion:

- **The brief/mockup/ADR/instruction wins. Always.**
- You are **explicitly authorized** to DELETE or REWRITE test assertions to match the new spec.
- Preserving a test assertion that contradicts the spec is a **regression, not safety**.
- If unsure whether an assertion is load-bearing logic vs legacy contract: load-bearing if it asserts on data shape or runtime behavior; legacy if it asserts on specific HTML strings, CSS classes, or visible text. **Legacy goes.**
- Update the test file in the **same commit** as the code change. Never two commits, never deferred.

**Why:** v0.4.1 polish run drifted because `tests/dashboard/topology.test.ts` asserted on `topo-bus` / `topo-mode-chips` / `enterprise bus`, and the v2 mockup explicitly removed those. CC chose to preserve tests and keep the legacy scaffolding as a "faint structural axis." That is the failure mode this rule exists to prevent.

### 2. Never lose files — write, verify, commit immediately

The Cowork/Claude virtualized filesystem can silently drop Write tool output or truncate Edit-tool round-trips on files > ~30KB. After every Write or Edit:

- Verify on disk with `stat -c %s <file>` AND `tail -5 <file>`.
- If the tail isn't what you expect (missing closing tags, mid-line truncation), the file is corrupt. Recover via `head -n LASTGOOD file > /tmp/x && cat >> /tmp/x << EOF ... EOF && cp /tmp/x file`.
- For files > 30KB that don't exist yet, prefer `cat > file << 'EOF' ... EOF` (heredoc through bash) over multiple Write/Edit calls.
- Commit every file in the **same turn** it's written. Never batch across phases. A file that's not committed is a file that doesn't exist tomorrow.

Banned phrases without verification: "saved", "written", "persisted", "ready to commit."

### 3. Don't-touch default (visuals/polish/docs work)

When the brief says "visuals only" or "polish" or "docs only," the following are **off-limits unless the brief explicitly opens them**:

- `src/persistence.ts`, `src/types/`, `src/worker/`, `src/steward/`, `src/mcp/`, `src/cli/`
- Any file under `tests/persistence/`, `tests/worker/`, `tests/steward/`, `tests/mcp/`
- `src/dashboard/data/*` (data fetchers) and `src/dashboard/adapters/*` (data shape) — these are the contract between business logic and the dashboard. Don't reshape them in a polish run.
- `ecosystem.config.cjs`, `package.json` dependencies (except adding viz libs explicitly allowed in the brief, e.g., d3-force)
- `migrations/`, `db/schema*`

Touching any of those during scoped work = stop, revert, leave a note in the PR description.

### 4. Per-phase commits, DCO sign-off

- One commit per phase. Never batch.
- Every commit `git commit -s` (DCO sign-off). No exceptions.
- Each phase commit must independently pass `npm test` and `npm run build`. If a phase regresses, revert just that commit; don't cascade.
- Push at end of each phase. Don't accumulate unpushed commits.

### 5. Visual conventions (the iron palette)

- **Wordmark**: `stav` + `ᚱ` (real Raido rune, U+16B1). Not "stavR" as plain text. Not "STAVR".
- **Status = halo ring** (ok/warn/crit). **Type = node color** (8 type colors: rust core / blue mcp-remote / green mcp-local / amber webhook / purple db / teal model / pink worker / cyan peer). **Never use color to signal status on a node** — use the halo.
- **`.glass` on every panel** (`background: rgba(20,22,31,.55); border: 1px solid var(--line); border-radius: 12px; backdrop-filter: blur(14px);`). Flat surfaces are wrong.
- **No red bus**. The v0.3 horizontal red enterprise bus is deprecated. If a page still has it, replace with a link to `/topology`.
- **Watchdog pip → WATCH OK chip** with tooltip listing what's being watched (PM2 status, last heartbeat, OOM headroom).
- Canonical mockups live in `design-mockups/` — see Canonical references below.

### 6. Mockup as source of truth

When implementing a page that has a canonical mockup, **open the mockup in a browser first** and inspect computed styles. Don't infer visuals from a text-only HTML scan. If you must translate HTML/CSS into our TypeScript template literals, the visual output is what matters — not literal HTML preservation.

If the mockup and existing code disagree, **change the code**.

### 7. NO-GO handoff is a clean transfer, not a refusal

When an action hits a NO-GO boundary (allowlist deny, scope-exceeded, destructive-without-consent), the AI does NOT just refuse. The correct posture is **stop + hand over with precise manual steps**:

- Name what was attempted and why it's NO-GO
- Give the operator the exact command sequence to run themselves (PowerShell or bash as appropriate for the platform)
- Note any verification step the operator should do before/after
- Don't try to find a workaround. "I can't do X, but here's how YOU do X" is the correct response

**Why:** The operator is sovereign (Lex Insculpta). NO-GO actions are operator-only by design, not because they're impossible. A bare refusal forces the operator to figure out the recovery path; a handoff with concrete steps respects their time and authority. Friction is the point — the operator should feel the weight of the action, but not waste cycles figuring out the mechanics.

**Example (good):** "Bash can't `rm -f .git/index.lock` (mount permission). Run from PowerShell in `C:\dev\cowire`: `Remove-Item .git\index.lock -Force`."

**Example (bad):** "I can't do that." [end of message]

### 8. Process safety

- Daemon process is sacred. Anything that can leak/stall/crash lives in its own subprocess (Steward, Workers).
- Don't add long-running logic to the daemon's request path.
- `pm2 restart stavr` is fine after code change. `pm2 restart --update-env` does NOT reload `ecosystem.config.cjs` — use `pm2 start ecosystem.config.cjs --update-env` only if env changed.
- `pm2 env stavr` doesn't take a name — use numeric id `pm2 env 0`.

---

## Canonical references (visual targets)

| Page | Mockup | Render code |
|---|---|---|
| Helm | `design-mockups/dashboard-helm-v2-expanded.html` | `src/dashboard/pages/helm.ts` |
| Topology | `design-mockups/dashboard-topology-v2-graph.html` | `src/dashboard/pages/topology.ts` |
| Diagnostics | `design-mockups/dashboard-diagnostics-v2-b-proxmox.html` | `src/dashboard/pages/diagnostics.ts` |
| Streams / Decide / Toolkit / Capabilities / Settings | `design-mockups/dashboard-mockup-v8.html` (sections `#page-streams`, etc.) | matching `src/dashboard/pages/*.ts` |
| Shell + tokens | `dashboard-mockup-v8.html` topbar + iron palette `:root` | `src/dashboard/shell.ts` + `src/dashboard/tokens.ts` |

## Key ADRs

- `adr/030-event-retention-and-dashboard-caching.md` — retention model
- `adr/031-observability-architecture.md` — OTel + Prometheus + pino baseline
- `adr/032-steward-model-portable-agent.md` — Steward subprocess + 3-layer state + Model Runtime
- `adr/033-stavr-tray-companion.md` — Tauri 2 companion leveraging PM2
- `adr/034-personal-mcp-gateway-positioning.md` — market positioning + explicit non-goals
- `adr/035-federated-stavr-a2a-oauth21.md` — federated stavR via A2A + OAuth 2.1 RIs

## Windows / PowerShell gotchas

1. PowerShell `curl` is `Invoke-WebRequest`, NOT real curl. Use `curl.exe` or `Invoke-RestMethod`.
2. RUNNER~1 8.3 paths on Windows — always quote paths.
3. Git `.git/index.lock` after a crashed commit — `Remove-Item .git\index.lock -Force` from PowerShell.
4. CRLF warnings on `.gitignore` edits are harmless — git normalizes to LF on commit per `.gitattributes`.
5. **Cowork bash sandbox mount shows stale state for `.git/` files**: `.git/HEAD` may appear truncated (e.g., `ref: refs/heads/feat/` with the branch name cut off), `.git/index.lock` may appear present when it's already gone, and `git status` from the bash mount may report "your current branch appears to be broken" while PowerShell shows the repo is fine. **Trust the PowerShell view, not the bash view.** When `git` errors out from the bash side, switch to PowerShell, verify via `type .git\HEAD` + `git reflog -10` + `dir`, then perform the git op from PowerShell. Writes from bash heredoc still flow through to Windows correctly — verify with `dir filename` from PowerShell. Evidence transcript: `docs/footguns/bash-mount-stale-cache.md`.

## What to do when stuck

- **If a test asserts on legacy HTML that conflicts with a new spec**: rule #1 — delete the assertion, update for new spec, commit together.
- **If a file > 30KB seems truncated after edit**: rule #2 — verify via bash, recover via heredoc.
- **If the brief and the code disagree about scope**: ask. Don't expand scope silently.
- **If two phases of a brief contradict each other**: stop, ask Kenneth which wins, document the resolution in the PR description.

---

## End of project instructions
