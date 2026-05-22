# BOM: De-brand "brick" — rename to "MCP server" + "node"

**Owner:** CC
**Sensitivity:** `careful` — a wide rename, not a logic change, but it touches `persistence.ts`, `transports.ts`, and an on-disk contract (`~/.stavr/bricks/`). Status check before every git op; report after each phase; operator reviews the Phase 3 migration diff before merge.
**Verification window:** `full` — the rename spans ~33 files including core modules; a missed reference breaks the build, and the on-disk migration needs explicit verification.
**Branch:** `chore/debrand-bricks`
**Base:** `main` (current)
**Estimated scope:** 5 phases (0-4), 2 PRs, roughly half a day.

---

## Why this BOM exists

"Brick" is legacy terminology the operator wants dropped (decided 2026-05-21). The word is overloaded across ~33 `src/` files in **two distinct senses**, and it sits next to a third concept it must not be merged with. A blind find-replace would corrupt the codebase — this BOM does the de-brand deliberately, with the classification reviewed before any rename.

## The three concepts — CC must keep these straight

This is the core of the BOM. Every "brick" occurrence is one of three things:

- **Brick = an installable MCP-server package.** `src/bricks/` (installer, manifest, registry) — a folder of code + a `stavr-brick.json` manifest the daemon installs from a registry. **Rename → "MCP server"**: identifiers `mcpServer` / `McpServer` / `mcpServers`; user-facing copy "MCP server". The dashboard page is already `mcps.ts`, so this just makes it consistent (e.g. the empty-state becomes "No MCP servers installed").
- **Brick = the dashboard visual-node metaphor.** `src/dashboard/components/brick.ts`; "orange brick connectors" and "the brick label in the toolkit" (`src/connectors/connector.ts` comments); the brick visual on the toolkit / topology canvas. **Rename → "node"**: identifiers `node`; `components/brick.ts` → `components/node.ts`. *(Proposed term — operator to confirm; alternatives: "tile", "card".)*
- **Connector — DO NOT TOUCH the concept.** `src/connectors/` is a *separate* thing: the non-MCP-server externals (Wiser, Unifi, webhooks, scripts, vendor APIs). The `Connector` interface, `src/connectors/`, and the connector concept stay exactly as they are. Only the word "brick" *inside* connector files (comments, visual labels) changes — "orange brick" → "node". **Never rename brick → connector** — that would merge two distinct concepts.

## Don't-touch

- The `Connector` interface and the `src/connectors/` concept — only the word "brick" in their comments/labels changes.
- Any logic — this is a rename. No behavior change except the on-disk migration in Phase 3.
- The resource-gateway BOM and family-mode work — unrelated.

## Reference reading (CC, at Phase 0)

- `CLAUDE.md` — invariants (tests-are-derivative, never-lose-files, status-before-git-op, NO-GO handoff).
- The footprint: `grep -rli brick src/` — ~33 files.
- This BOM's three-concepts section — the classification is the whole point.

---

## Phase 0 — Recon (output a findings doc, then STOP)

For every "brick" occurrence in `src/`, classify it: **package-sense** (→ MCP server), **visual-sense** (→ node), or **connector-file mention** (→ node wording, but the connector concept untouched). Output the full classified list — file, line, current text, target.

Also enumerate the **on-disk contracts** that carry "brick", because those are breaking changes, not pure renames:

- The config dir `~/.stavr/bricks/` and its `manifest.yaml`.
- The per-package manifest filename `stavr-brick.json`.
- Any persistence — tables, columns, or event kinds with "brick" (check `persistence.ts`, `event-types.ts`).
- Any `src/types/stavr-bom.ts` types.

Output `proposed/debrand-bricks-recon.md`. **Operator reviews the classification before any rename** — a misclassified occurrence is the one way this BOM goes wrong.

## Phase 1 — Rename the package sense → "MCP server"

`src/bricks/` → `src/mcp-servers/` (`git mv`). Identifiers `brick` / `Brick` / `bricks` → `mcpServer` / `McpServer` / `mcpServers` in the package-sense files. Update all imports. User-facing copy → "MCP server" (including the `mcps.ts` empty-state copy the operator flagged). One commit.

## Phase 2 — Rename the visual sense → "node"

`src/dashboard/components/brick.ts` → `components/node.ts` (`git mv`). Visual identifiers, CSS classes, and comments ("orange brick", "brick label") → "node". Inside `src/connectors/*`, only the wording changes — the `Connector` interface is untouched. One commit.

## Phase 3 — On-disk migration

Per the Phase 0 recon's on-disk list — the breaking-change bit:

- `~/.stavr/bricks/` → `~/.stavr/mcp-servers/`: on daemon start, if the new path is absent and the old one exists, migrate it (or read the old path as a legacy fallback). The daemon **must still load an operator's existing installed MCP servers** — no silent loss.
- `stavr-brick.json` manifest filename: accept both the old and the new name — an MCP-server package already in the wild still ships `stavr-brick.json`.
- Any DB schema / event-kind rename per recon — additive, idempotent migration in the `init`-style code.

The test that matters: an existing `~/.stavr/bricks/manifest.yaml` is still found and loaded after the rename. One commit.

## Phase 4 — Verification

`full` window. `npm test` + `npm run build` + `tsc --noEmit` clean — a missed reference fails the build, which is the safety net for a wide rename. Grep proof: `grep -ri brick src/` returns only deliberate, documented exceptions (none expected). Daemon-load test: a daemon with a pre-existing `~/.stavr/bricks/` directory starts and shows its installed MCP servers.

---

## Sensitivity & cadence

`careful`. Status check before every git op; report after each phase. Phases 1-2 are pure rename (low risk); Phase 3 (migration) is the one with real consequences — operator reviews the Phase 3 diff before it merges.

## PR grouping

- PR 1 — Phase 0 recon doc (operator reviews + approves the classification).
- PR 2 — Phases 1-4 — one PR, because a half-renamed tree does not build.

## Definition of done

1. No "brick" terminology remains in `src/` except documented deliberate exceptions.
2. The package concept reads "MCP server" everywhere; the visual concept reads "node" everywhere.
3. The `Connector` concept is untouched — not renamed, not merged into MCP server.
4. An existing `~/.stavr/bricks/` install still loads after the rename (migration verified).
5. Full suite green; `npm run build` + `tsc --noEmit` clean.

## Run prompt for CC

```
Read CLAUDE.md, then proposed/debrand-bricks-bom.md. Execute Phase 0 (recon) ONLY — classify every "brick" occurrence (package-sense / visual-sense / connector-file mention) and enumerate the on-disk contracts. Output proposed/debrand-bricks-recon.md and STOP for operator review.

Sensitivity: careful. Status check (git status --short + git symbolic-ref HEAD) before every mutating git op. The Phase 0 classification is the whole point — a misclassified occurrence is how this goes wrong. NEVER rename brick -> connector; the Connector concept is untouched.

One PR for Phases 1-4 (a half-renamed tree does not build). DCO sign-off (-s). Branch chore/debrand-bricks off current main. Verify files >30KB with stat + tail before commit.

Go — Phase 0 only.
```

---

## End of BOM
