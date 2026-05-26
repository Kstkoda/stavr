# stavR fs.atomic_write — corrupt-file fix via brokered writes BOM

**Goal.** Expose an `fs.atomic_write` MCP tool through stavR that bypasses the Cowork virtualized filesystem (which silently drops Write tool output on files >~30KB) and surfaces residual corruption via mandatory hash verification. Any AI client routed through stavR — Cowork-Claude, Claude Code, the son's CC — gets a write path that is loud-on-failure instead of silently corrupt.

**Why this fits stavR.** The corruption happens between the AI client and the OS write syscall, inside the AI client's virtualized fs (Cowork's, or CC's sandbox). stavR runs on the host OS, calling normal Win32/Node `fs.writeFile`. A write brokered through stavR bypasses the virtualization layer entirely. The hash-verify-after-write contract makes any residual corruption (or the well-documented bash-mount stale-cache issue) immediately observable instead of silently propagated.

**Sensitivity:** careful. File writes on the operator's machine, scoped by path allow-list. Reversible (delete file, `git revert`). Per-phase verification + operator approval gate.

## What this BOM proves

1. The MCP tool `fs.atomic_write(path, content, expected_sha256)` writes content to disk via the daemon's host process, with mandatory hash verification, and surfaces any byte-level mismatch as an explicit error.
2. Writes use the atomic-write pattern (`write to <path>.tmp.<rand>` → `fsync` → `rename`) so a crashed write never leaves a half-corrupt file.
3. The tool refuses paths outside an operator-configured allow-list (default: the cowire worktree roots).
4. The tool refuses symlinks, path traversal segments (`..`), Windows alt-streams (`:`), and dotfile-outside-project patterns.
5. The chokepoint applies the standard tier model: AUTO for safe paths (`tests/`, `docs/`, `proposed/`), CONFIRM for `src/`, NO_GO for `migrations/` and anything outside the allow-list.
6. The companion read tool `fs.read_with_checksum` solves the symmetric "bash mount reads go stale" problem.

## What this BOM does NOT cover

- Replacing Write/Edit in CC or Cowork (those are AI-client primitives; this is an MCP-exposed alternative).
- Distributed file sync (local only).
- File diffs/patch ops — write whole files; AI reads + modifies + writes.
- Permission/ACL/ownership changes.

## Hard invariants

1. **Hash verification is mandatory.** No opt-out flag. If `expected_sha256` is provided and doesn't match the post-write read, the temp file is unlinked and the call fails. If `expected_sha256` is omitted, the response includes `observed_sha256` so the caller can verify externally.
2. **Atomic write only** — write to temp, fsync, rename. No in-place writes, no append.
3. **Path allow-list enforced.** Operator-configured at startup (stavr.yaml `fs_atomic_write.allowed_roots`). Any path outside is refused before any disk op.
4. **Symlinks refused.** `fs.lstat` the path; if it's a symlink, refuse. If any parent is a symlink, refuse.
5. **Path traversal refused.** No `..` segments, no Windows alt-streams (`:`), no UNC paths. Path must be absolute and normalized.
6. **Existing-file overwrite allowed by default** (that's the use case) but the tool returns the previous file's sha256 so the caller can detect surprise overwrites.
7. **No execution of written content** — content is bytes, never interpreted. No chmod-execute, no run.
8. **Audit-log every call** — `actor_id`, `path`, `bytes_written`, `observed_sha256`, `verify_status`. Same shape as other stavR audit events.

## Phase 0 — recon (operator-approval gate)

Identify:

1. The MCP tool-registration mechanism in stavR (`src/mcp/registry.ts` or equivalent) — how `fs.atomic_write` should be declared.
2. Chokepoint integration — confirm a new `tool_id` works the same way `github.*` tools do (no special case needed).
3. Where the operator-configured allow-list should live — `stavr.yaml`, env var, or a new dashboard endpoint.
4. Existing `fs.*` tools in stavR — is the namespace taken? Pick alternative name if needed.
5. Atomic-write helpers — is there a `writeFileAtomic` utility already? If yes reuse, if no write a small one (~20 lines).

**Deliverable:** `proposed/stavr-fs-atomic-write-recon.md` with the five answers. Halt.

## Phase 1 — tool implementation

Implement `fs.atomic_write` as a stavR-internal MCP tool (not an external brick — needs daemon-process fs access). Signature:

```ts
fs.atomic_write({
  path: string,                                       // absolute, normalized, no traversal
  content: string,                                    // utf-8 by default
  encoding?: 'utf8' | 'base64',                       // 'base64' for binary
  expected_sha256?: string,                           // optional; verify after write if provided
}): {
  ok: boolean,
  bytes_written: number,
  observed_sha256: string,
  previous_sha256?: string,                           // present if overwriting
  error?: string,
}
```

Implementation:
- Validate path (allow-list, no symlinks, no traversal, normalize).
- If existing, read + hash for `previous_sha256`.
- Generate temp path: `<path>.stavr-tmp.<8-hex-rand>`.
- Write content to temp via `fs.writeFile`.
- `fs.fsync` the temp fd.
- `fs.rename` temp → path (atomic on same fs on Windows + Linux).
- Read back, compute sha256.
- If `expected_sha256` provided and mismatched: `fs.unlink(path)`, return `{ok: false, error}`.
- Return `{ok: true, bytes_written, observed_sha256, previous_sha256?}`.

Tests:
- Plain write to allowed path → ok, hash matches.
- Mismatched `expected_sha256` → ok=false, rolled back.
- Path outside allow-list → refused.
- Symlink target → refused.
- Traversal segment → refused.
- 100KB content (above Cowork truncation threshold) → ok, hash matches.

**Deliverable:** tool + tests + small operator-config schema for the allow-list. `git commit -s`, push, halt.

## Phase 2 — chokepoint integration + tier defaults

Register `fs.atomic_write` at the chokepoint. Default tier matrix entries for the operator's own actor:

- `tests/`, `docs/`, `proposed/`, `design-mockups/` → AUTO
- `src/` → CONFIRM
- `migrations/` → NO_GO (manual operator only)
- `.github/workflows/` → CONFIRM
- Outside allow-list → NO_GO (already enforced; reinforced at chokepoint)

For `peer:*` actors → default NO_GO (Option A — explicit grant required).

**Deliverable:** chokepoint integration + per-path tier defaults in `stavr.yaml` template + tests. Halt.

## Phase 3 — Cowork-side smoke (the use case)

Empirical proof. From Cowork-Claude (or CC), use the MCP tool to write a file the standard Write tool would silently corrupt:

1. Generate a 50KB+ deterministic content blob with a known sha256.
2. Call `fs.atomic_write(path, content, expected_sha256)` via stavR.
3. Verify the file on disk matches via `Get-FileHash` (PowerShell) — operator's independent check, outside the AI's tools.
4. Repeat with a corruption-inducing pattern (specific byte sequences that have hit the Cowork bug historically — collect from prior incidents).
5. Capture verbatim tool responses.

**Deliverable:** `tests/fs-atomic-write/SMOKE-RESULTS.md` showing the brokered writes survive Cowork virtualization. Halt for review.

## Phase 4 — companion read tool

Implement `fs.read_with_checksum(path)`. Returns content + observed sha256. Solves the bash-mount stale-cache symptom — caller compares observed against expected to confirm the read isn't stale.

Same tier model — read tools generally safer than writes, but a NO_GO list still applies for paths the operator doesn't want exfiltrated.

**Deliverable:** read tool + tests + tier defaults. Halt for review.

## Done criteria

- All four phases pass smokes.
- A 50KB write via `fs.atomic_write` from Cowork-Claude lands on disk with the expected hash.
- Path-allow-list violation, symlink attempt, traversal attempt all refuse cleanly.
- Chokepoint correctly NO_GOs `peer:*` actors without a matrix row.
- Cowork-side smoke shows the tool surfaces what the standard Write tool silently dropped.

## Out of scope (follow-ups)

- File appending/patching/diff-apply — separate tools if needed.
- Permission/ACL/ownership changes.
- Cross-machine sync via stavR federation.
- `fs.delete` — destructive, needs its own design (Tier 3 default).
- Replacing Write/Edit in CC or Cowork (AI-client primitives, not stavR's to change).
