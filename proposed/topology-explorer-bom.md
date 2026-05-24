# BOM: stavR Topology - Level-of-Detail Explorer Rebuild

**Owner:** CC
**Sensitivity:** `routine` - dashboard-UX work. No daemon broker / transport / persistence / security / schema touched; the only daemon `src/` opened is the topology data fetcher + adapter (Phase 1). Standard autonomous flow, one delta report at completion.
**Verification window:** `targeted` - `npm test` + `npm run build` green per phase. The mockup is the visual source of truth (CLAUDE.md section 6) - CC opens it in a browser and matches computed styles. The operator runs the visual smoke.
**Branch:** `feat/topology-explorer` off `main`.
**Base:** `main`.
**Estimated scope:** recon + 4 phases. One PR.

---

## Why this BOM exists

The v2 topology page (`design-mockups/dashboard-topology-v2-graph.html` / `src/dashboard/pages/topology.ts`) does not hold up: the galactic-map canvas renders empty because the data fetcher never wires the MCP registry into nodes; the flat force-directed graph does not use the screen and will not scale; local models and tools/MCP are not represented at all. Operator verdict: "still crap, the whole screen is not utilized."

A 10-3-1 (2026-05-24) settled the replacement: a **concentric layout** (option 3) rendered with **Cytoscape.js** (option 10), reframed as a **level-of-detail (semantic-zoom) explorer** - because the real graph is not 15 nodes, it is hundreds. You never render hundreds flat; you zoom through levels and collapse rings. The canonical mockup is `design-mockups/dashboard-topology-v3-explorer.html`.

## Decided design - do NOT re-litigate

- **Three levels of detail (semantic zoom):** (L1) Federation - a hub-mesh of relay hubs, households peering pairwise; (L2) Household - concentric rings around the home daemon; (L3) drill-down - collapsible rings, click a ring or node to expand/collapse and explore.
- **Concentric layout, Cytoscape.js render.** Pannable + draggable; rings open and collapse interactively.
- **Status = a BADGE, not a halo.** Operator-approved exception to CLAUDE.md section 5 ("status = halo ring"). At hundreds-of-nodes scale a discrete status badge reads clearer than a halo; the operator decided this explicitly. **CC must not "correct" it back to a halo.** Type still = node colour per section 5 (the 8 type colours stay).
- **Scale = hundreds of nodes.** The LOD + collapse model IS the scale answer - rings collapsed by default, expanded on demand. Never render the full graph flat.
- **Local models (Ollama) and tools/MCP servers ARE nodes** - they were missing from v2 and must appear. The empty-canvas bug is exactly the MCP registry never reaching the node set.
- **Trust scopes, decisions, and events are NOT topology nodes.** They are home-node data - surfaced in the click-inspector when the operator selects their home daemon, not as graph nodes.

## Phases

### Phase 0 - Recon
Pin the current state: `src/dashboard/pages/topology.ts`, the topology data fetcher(s) + adapter under `src/dashboard/data/` (including whatever `topology-data` / `topology-actor-nodes` resolve to), and the topology tests (`tests/dashboard/topology*.test.ts`). Identify exactly what feeds nodes today and why the MCP registry is not wired. Commit `design-mockups/dashboard-topology-v3-explorer.html` (currently untracked) as the canonical mockup. One findings paragraph in the PR description.

### Phase 1 - Graph data model + fetcher
Reshape the topology data layer to produce the LOD graph model: relay hubs (from federation / `peers.yaml`), the home daemon, MCP servers (wired from the MCP registry - the v2 gap), local models (the Ollama runtime), and peers - each typed and assigned to L1/L2/L3. Output a Cytoscape-shaped graph (nodes + edges + level + type + status). Trust scopes / decisions / events stay OFF the graph - they are inspector data, not nodes. **Tests are derivative (CLAUDE.md #1):** rewrite the topology-data tests in the same commit.

### Phase 2 - Cytoscape concentric explorer
Add `cytoscape` as a dependency - explicitly permitted by this BOM, and the ONLY dependency addition allowed. Replace the v2 force-directed render with Cytoscape.js: concentric layout, the 3-level semantic zoom, collapsible/expandable rings, pan + drag. Status = badge; type = node colour (section 5). Match `dashboard-topology-v3-explorer.html` - open it in a browser and inspect computed styles per CLAUDE.md section 6; the mockup wins over any v2 code. Rewrite the topology render tests in the same commit (CLAUDE.md #1 - the v2 tests assert on the force-directed graph and must be replaced).

### Phase 3 - Click-inspector + home-node data
Click a node -> an inspector. Selecting the home daemon surfaces the data deliberately NOT on the graph: trust scopes, open/recent decisions, recent events. Keep it consistent with the existing inspector pattern (mini-trends if v2 had them). No-orphan rule: every node type must have a drill path (an inspector or a detail page).

### Phase 4 - Build + verify
`npm test` + `npm run build` green; one PR, per-phase commits, DCO sign-off (`-s`). Operator visual smoke: the L1/L2/L3 zoom, ring collapse/expand, status badges, MCP + Ollama nodes present, the home-node inspector showing scopes/decisions/events.

## Deferred (NOT in this BOM)

- Moving the worker roster to the Streams page / in-flight BOMs to the Plans page (v2 followup items) - v3 simply has no such panels; if those need a home it is a Streams/Plans task, separate.
- The `Ctrl+K` shortcut rebind - a shell-level concern, separate.

## Don't-touch

- Daemon `src/` except the topology data fetcher + adapter (Phase 1). No broker, transport, persistence, security, schema.
- Other dashboard pages.
- `package.json` dependencies except adding `cytoscape` (Phase 2).

## Run prompt for CC

```
Read CLAUDE.md, then proposed/topology-explorer-bom.md. Open
design-mockups/dashboard-topology-v3-explorer.html in a browser - it is the
visual source of truth (CLAUDE.md section 6).

Rebuild the topology page as a level-of-detail explorer: concentric layout,
Cytoscape.js, 3 semantic-zoom levels (federation hub-mesh -> household
concentric -> collapsible rings). Wire local models + MCP servers as nodes
(the v2 empty-canvas bug). Status = a BADGE, not a halo - an operator-approved
exception to section 5; do NOT convert it to a halo. Trust scopes / decisions
/ events are NOT graph nodes - they are home-node inspector data.

Branch feat/topology-explorer off main. Sensitivity routine - standard
autonomous flow, one delta report. Tests are derivative (CLAUDE.md #1) -
rewrite the topology tests in the same commit as the code. cytoscape is the
one permitted new dependency. One PR, per-phase commits, DCO -s.

Skarp och hangslen: git status --short + git symbolic-ref HEAD before every
mutating git op. Go.
```

---

## End of BOM
