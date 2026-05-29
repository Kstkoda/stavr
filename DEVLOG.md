# stavR — devlog

> Local-first agent broker. Plans the work (BOM), dispatches it across MCP connectors and Claude Code workers, routes to the right model under a cost budget, and ships it on your machine.

- **Repo:** [Kstkoda/stavr](https://github.com/Kstkoda/stavr) · **Local:** `C:\dev\cowire`
- **Last updated:** 2026-05-29
- **Active branch:** `docs/proposed-bom-additions` (worker-dispatch substrate just merged to main via PR #88)

## ✅ Done (recent)

- **Worker-dispatch substrate, Phases 0–4 — merged (PR #88, 2026-05-29).** Job + invoke + binding interface, four executor bindings, admission control + watchdog + retention, parallel MCP tool surfaces, dashboard cutover, and the bespoke worker subsystem deleted. Phase 4 = grant-scope-aware dispatch gate (per-actor/tool/target + budget), including the resolve/decrement-after-admission fix that closed a grant-budget leak.
- **Family-son MCP over Docker** — compose substrate, bootstrap+pairing, bearer-auth smoke, chokepoint smoke (5/5 pass).
- **Bombardment chaos rig green** — real netem via iproute2 baked into the CI image.
- Foundations already in place: 4-tier approval model, Layer 0 capability master switch, OS-native governor (systemd/launchd/Windows Service), dashboard (Helm / Topology / Diagnostics / History), hash-chained event log.

## 🔨 In progress

- `docs/proposed-bom-additions` — landing BOMs for **claude-execute-mcp-tool** (subprocess delegation via worker-dispatch) and **mcp-long-running-primitives** (Tasks extension + resources/subscribe + progress passthrough).

## ⏭️ Next

- **Phase 5 — federated job-flow** (the last substrate phase on the worker-dispatch side).
- **claude.execute MCP-tool-dispatch** — the new path after the Anthropic-OAuth-proxy approach was found structurally impossible; routes a `claude.execute` MCP tool → worker-dispatch → local `claude -p` subprocess.
- Family-mode functional **cross-machine** (v0.7 federation merged but never worked end-to-end across machines).
- Topology v3 explorer (concentric + Cytoscape level-of-detail); Rules page + no-go dashboard editor (v0.8).

## ❓ Open questions

- Production federation wants 4–5 always-on nodes with a single operator; **remote dashboard access is still an unbuilt gap** (near-term = tunnel-to-loopback).
- Unresolved naming/scope: "RS" acronym, Rules-page scope, Shadow-mode axes.

---
*Maintained as this project's diary. Aggregated with the other `C:\dev` projects in the **C:\dev devlog** Cowork artifact.*
