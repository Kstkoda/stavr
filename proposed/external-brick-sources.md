# External brick sources

Lets users add bricks to the Toolkit shelf from outside stavr's built-in catalog — GitHub repos, npm packages, URLs, local folders. Same shelf, same drag-to-canvas UX, just sourced from anywhere.

## Mental model

Stavr ships with a built-in catalog (Wiser, Unifi, GitHub MCP, Files, Terminal, etc.). That catalog is just the default `Source` — a list of bricks at a known location. The user can add more sources. All sources contribute bricks to the same shelf; each brick carries a provenance badge ("from `github.com/Kstkoda/wiser-brick`") so you can always tell where a piece came from.

This is the VS Code Extensions / Home Assistant HACS / Chrome Web Store pattern — uniform install surface, pluggable origin.

## Brick package format

A brick is a folder (local) or repo (remote) with a single manifest at root:

```json
// stavr-brick.json
{
  "schema_version": 1,
  "id": "wiser-schneider",
  "kind": "wiser",
  "type": "connector",
  "display_name": "Wiser Home",
  "version": "0.3.1",
  "author": "Schneider Community",
  "license": "MIT",
  "homepage": "https://github.com/.../wiser-brick",
  "logo": "assets/logo.svg",
  "entry": "dist/index.js",
  "position": "above",
  "capabilities": [
    {
      "id": "wiser_get_temp",
      "description": "Read temperature in a room",
      "capability_tag": "reading",
      "risk_class": "read-only"
    },
    {
      "id": "wiser_set_temp",
      "description": "Set target temperature in a room",
      "capability_tag": "code-execution",
      "risk_class": "write-remote"
    }
  ],
  "config_schema": [
    { "key": "home_id", "label": "Home ID", "kind": "text", "required": true },
    { "key": "access_token", "label": "OAuth", "kind": "oauth", "secret": true, "required": true }
  ],
  "permissions_requested": ["network:wiser.schneider-electric.com"]
}
```

**Type-to-color mapping** (so the manifest dictates which color brick it becomes):

- `type: "ai-external"` → 🟣 Cloud AI brain
- `type: "ai-local"` → 🟡 Local AI brain
- `type: "mcp"` → 🔵 Tool (MCP server)
- `type: "os"` → ⚫ OS access (gray)
- `type: "filter"` → 🟢 Smart filter
- `type: "connector"` → 🟠 Connector

The `kind` is a free-form sub-type that lets multiple instances of the same brick coexist (`unifi-main`, `unifi-guest` — same kind, different ids).

## Supported source types

### 1. Built-in catalog (default)

Curated list shipped with stavr. Just a static `Source` registered at boot. Bricks here are pre-blessed — no install-time consent prompt, just the standard per-brick config flow.

Location: `src/bricks/built-in/` — each subfolder is a brick package.

### 2. GitHub repo

Most common external case. User pastes a `github.com/owner/repo` URL (or just `owner/repo`). Stavr:

1. Fetches `stavr-brick.json` from the repo root (raw URL or via API).
2. Validates the manifest schema.
3. Shows a preview card: name, what it does, capabilities, permissions requested, source link.
4. On confirm: clones the repo to `~/.stavr/bricks/<id>/` and installs (`npm install` if there's a `package.json`).
5. Adds the brick to the Shelf with a small `gh` provenance badge.

Updates are explicit: a "Check for updates" button on the brick's inspector pulls the latest commit and shows a diff of what changed (manifest deltas, new capabilities, new permissions). User decides.

### 3. npm package

For bricks distributed as npm packages. Convention: any package with the keyword `stavr-brick` and a `stavr-brick.json` in its root is installable.

```sh
# Equivalent of pasting "@scope/wiser-brick" in the UI
stavr brick install @scope/wiser-brick
```

Same flow as GitHub: fetch manifest, preview, install to `~/.stavr/bricks/<id>/`.

### 4. URL (direct manifest)

Paste a URL pointing at a raw `stavr-brick.json`. Stavr downloads the manifest and the entry file(s) referenced. Useful for private hosting (S3, internal artifactory) without a full git repo.

### 5. Local folder

For developing your own brick. Point stavr at a local path; it loads from disk and live-reloads on file change. Marked with a `dev` badge — you can publish it to GitHub or npm when ready.

## Trust + sandboxing

External code runs on the user's machine — this is the security surface. Three layers:

**Layer 1: Manifest review.** Before install, the user sees: capabilities the brick provides (with risk classes), permissions requested (network hosts, file paths, env vars), declared license and author. No install happens silently.

**Layer 2: Runtime sandboxing.** External brick code runs in a separate Node `worker_thread` with:
- No filesystem access except its own brick directory and any paths in `permissions_requested`
- No network except hosts declared in `permissions_requested`
- No process spawning (no child_process)
- No access to stavr's database or event log directly — only via the `BrickContext` API the daemon passes in

Implemented via the `worker_threads` `resourceLimits` plus a wrapped require. v1 can punt on filesystem isolation if it complicates Windows support — declared permissions + audit log give us a usable v1 even without hard sandboxing.

**Layer 3: No-go list applies.** Every capability the brick declares carries a `risk_class`. The framework's no-go list still gates destructive actions before they fire — the brick can't bypass it because stavr owns the gate, not the brick.

## UX flow (Add Source → Browse → Install → Use)

1. **Shelf header** has a "+ Add source" button.
2. Clicking opens a small modal with four tabs: **GitHub** (paste URL), **npm** (paste package name), **URL** (paste manifest URL), **Local** (folder picker).
3. After successful fetch, shows the manifest preview card — name, description, capabilities, permissions, license.
4. **Two buttons**: "Add to shelf only" (manifest registered, code not yet installed — user can drag it later) or "Install + add to shelf" (code installed, brick is ready to drag onto the canvas).
5. Installed bricks appear in The Shelf grouped by source. A small dropdown filter at the top of The Shelf lets you toggle which sources are visible.
6. Each brick on the shelf shows a tiny provenance badge: 🏠 (built-in) / 🐙 (GitHub) / 📦 (npm) / 🔗 (URL) / 🛠 (local dev).
7. Hovering the badge shows the full source path.

## CLI parity

Same operations available via CLI for scripting:

```sh
stavr brick search gh:owner/repo        # preview manifest
stavr brick install gh:owner/repo       # install
stavr brick install npm:@scope/name     # install from npm
stavr brick install ./path/to/folder    # install from local
stavr brick list                        # show installed
stavr brick update <id>                 # check for updates
stavr brick remove <id>                 # uninstall
stavr brick disable <id>                # keep installed, hide from shelf
```

## Manifest validation

Strict — reject anything malformed at install time, before the code runs. Validation rules:

- `schema_version` must be a known integer (currently 1)
- `id` must be unique across installed bricks, kebab-case, no spaces
- `type` must be one of the six known types
- `entry` must be a relative path within the brick directory (no `..` or absolute paths)
- `capabilities[].risk_class` must be one of the canonical 8 (read-only through destructive)
- `permissions_requested` hosts must be domains or `localhost`; paths must be relative to user data dirs
- `version` must be semver

Reject with a clear error message; never partially install.

## Discovery

Out of scope for v1: a hosted public registry. v1 supports point-to-source install only. Discovery is "find a GitHub repo and paste it."

v2 candidate: an optional registry at `registry.stavr.dev` (or hosted in the stavr GitHub org) that aggregates publicly-listed bricks. Opt-in to publish. Search by capability ("show me all bricks that handle home-automation"). Each listing still links to its actual source repo — the registry is just a catalog index, not the runtime origin.

## What this adds to the existing design

- New file: `src/bricks/registry.ts` — the source manager (add, list, fetch manifest, validate).
- New file: `src/bricks/installer.ts` — handles git clone, npm install, local copy, hashing for integrity.
- New file: `src/bricks/sandbox.ts` — worker_thread launcher with resource limits.
- New schema additions to `001_bom_schema.sql`: `brick_sources`, `installed_bricks`. Tracks source URL, version, install date, last update check.
- New MCP tool: `brick_install`, `brick_list`, `brick_remove`. Behind feature flag initially.
- New event kinds: `brick_installed`, `brick_updated`, `brick_removed`, `brick_capability_added` — so the audit log captures the install supply chain.
- The `Connector` interface from `connector.ts` is unchanged — it's the runtime contract. The manifest is the install-time contract.

## Open questions

1. **Update policy** — should stavr auto-check for updates? Recommendation: weekly check, notification badge, never auto-install. User decides when to pull.

2. **Signature / verification** — should we require signed brick packages? Out of scope for v1; revisit if there's a real attack vector. For now, "the user explicitly approved this source URL" is the trust model.

3. **Cross-brick dependencies** — can brick A depend on brick B? v1: no. Each brick is standalone. If shared logic is needed, factor into an npm library that both depend on independently.

4. **What happens to in-flight workers when a brick is removed/updated?** Recommendation: removed brick's capabilities become unavailable mid-job → BOM step fails → steward replans. Update: brick is hot-swappable for new invocations; in-flight workers keep using the old version until they finish.

5. **MCP servers as a special case** — a `type: "mcp"` brick is just a pointer to an MCP server (executable + args). The brick manifest can be very thin — name, MCP server command, transport. Stavr spawns the MCP server as a child process and proxies its tools. Means the "external brick sources" pattern subsumes both custom code AND existing MCP ecosystem. Big win for v0.2.

## Land order

1. Schema additions for `brick_sources` and `installed_bricks` (small migration).
2. Manifest schema + validator (`src/bricks/manifest.ts`).
3. Local-source install path only (just file copy + manifest registration). Validates the whole approach without networking.
4. GitHub-source install (adds the `gh:` URL handler + clone + manifest fetch).
5. npm-source install.
6. Sandbox via worker_thread (can ship without strict sandboxing in v0.2.0 — gate behind a config toggle).
7. Shelf UI for "Add source" + brick browser + install confirmation. Lands with the Toolkit page.
