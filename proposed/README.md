# stavr — proposed changes

Concrete artifacts for the stavr build. Drop into the repo, review, land incrementally. Nothing here touches existing code paths until you wire it up.

## What stavr is

**stavr is a local-first orchestration layer that plans multi-step work, routes each step to the right AI model under a cost budget, and lets you plug in anything as a connector — with a visual toolkit your non-technical users can actually use.**

Four pillars:

1. **BOM-driven planning.** A goal goes in. A structured Bill of Materials comes out — numbered steps, each tagged with capability (what kind of thinking is needed), model assignment, cost estimate, and dependencies. You review it as a "food label" before approving, and it runs to completion including retries and fixes.

2. **Connector bus.** A standardized way to wrap any external service or local capability into stavr. MCP servers, REST APIs, OAuth-protected SaaS, LAN-only controllers (Unifi), home automation (Wiser), game platforms (Roblox, Unity), webhooks, cron schedules, SMTP — all the same orange-brick shape with a uniform `Connector` interface. Anyone can add a new one.

3. **Profile-based cost routing.** Three modes: Turbo (best model per step, no cost ceiling), Balanced (cheapest model that fits the capability), Eco (local AI first, refuses paid spend without your nod). Each profile has explicit budget caps and a per-capability model preference list. Profile switches log to the event stream so you can correlate behavior to mode.

4. **Visual toolkit.** A DUPLO-style canvas where the stavr bus runs across the middle, external services live above (cloud, needs auth), local capabilities live below (your machine), and brain bricks plug into a socket at the end of the bus. Click any brick to configure it — each brick owns its own form fields. Drag from "The Shelf" to add new pieces.

Underneath all of this, stavr has a trust-scope and audit-log mechanism that makes "approve a plan, walk away, come back to a result" actually safe. **That mechanism is plumbing, not the headline.** See [`POSITIONING.md`](./POSITIONING.md) for the one-pager on what stavr is and is not.

## Prior art note

The trust-scope-plus-audit primitive that stavr uses to make plans safely executable is structurally the same idea as Tessera Protocol (`tessera-protocol.github.io/tessera`), which shipped first. Stavr's authority layer is independently derived but not novel. Tessera is narrowly an authority guard pattern; stavr is a broader orchestration system that happens to use the same shape underneath. If you ever publish the stavr trust-scope module in isolation, cite Tessera.

## Land order (recommended)

1. **`sse-heartbeat-fix.md`** — read first, apply immediately. Pure stability win, no architecture change. The 5-minute SSE reconnect cycle you've been living with goes away.

2. **`001_bom_schema.sql`** — adds the `boms`, `bom_steps`, `bom_versions`, `connectors`, `no_go_list`, `profile_config`, `profile_state` tables to `~/.stavr/runestone.db`. Idempotent. Add to `src/persistence.ts`'s init sequence after the existing tables. Boot default for `profile_state.active_mode` is `balanced`.

3. **`types.ts`** — risk classes, capability tags, BOM event kinds, profile modes with full routing tables, no-go list shape with a `matchNoGo()` matcher. Merge BOM event kinds into `src/event-types.ts`. Move the rest into `src/types/`.

4. **`connector.ts`** — the extension point. Defines what an orange-brick connector implements: id, kind, position (above/below the bus), config schema, status, capabilities, exec. Plus a registry interface for the daemon to track installed connectors. Drop in `src/connectors/connector.ts`; each concrete connector (Wiser, Unifi, Roblox, Unity, webhook) is its own file under `src/connectors/`.

5. **`steward-planner.ts`** — the planning loop. Takes a goal + available capabilities + active profile, produces a BOM, persists it, emits `bom_proposed`. Has a `replan()` for failure recovery. Wire to existing `LlmProvider`. Add a `propose_plan` MCP tool that calls it. Feature-flag behind `stavr.experimental.planner=true`.

6. **Executor (follow-up PR).** Reads approved BOMs, dispatches workers per step under the BOM-derived trust scope, captures cost/results, calls `planner.replan()` on failure. Not in this batch — land 1-5 first.

## What this does NOT change

- The existing dashboard pages — they keep working. New BOM-aware UI is additive.
- The existing reactive steward loop (`src/steward/loop.ts`) — still runs for direct prompts.
- The existing trust-scope and decision flow — fully preserved. BOMs derive scopes from their risk envelope on approval; the rest is unchanged. Trust scopes are the safety substrate, not the product.
- The shim/daemon split — unchanged.

## What this does change (when wired)

- A new event kind `bom_proposed` lands when a chat session asks stavr to plan something.
- The user approves the BOM as a single artifact (the food-label card from the design session). One click reviews and authorizes the whole plan.
- An approved BOM auto-creates a trust scope from its risk envelope so the workers it spawns can act without further prompts — within the envelope. Out-of-envelope actions (no-go list) still interrupt.
- The connector interface lets anyone add Wiser/Unifi/Roblox/Unity/whatever as orange bricks. stavr handles auth, exposes their capabilities to the planner, applies no-go list, audits every exec.
- Profile modes shape per-step model selection. Switching profiles changes the next dispatch, not in-flight work.

## What's deliberately omitted from this batch

- UI mockups in code — landing the backend first.
- New dashboard pages — the Plans/Decide/Streams/Topo/Kit pages from the design session are separate PRs once the backend supports them.
- The executor that actually runs approved BOMs.
- Concrete connector implementations (Wiser, Unifi, Roblox, Unity) — interface is here, instances are separate packages.

## File index

| File | Purpose |
|------|---------|
| `POSITIONING.md` | One-pager — what stavr IS and IS NOT |
| `README.md` | This file — overview + land order |
| `sse-heartbeat-fix.md` | Stability win — apply first |
| `001_bom_schema.sql` | DB migration for BOMs, connectors, no-go, profiles |
| `types.ts` | Risk, events, profiles, no-go, capability tags |
| `connector.ts` | Extension interface for orange bricks |
| `steward-planner.ts` | Planning loop skeleton |

## Open questions to validate before merging

1. **Capability detection** — the planner has to know whether step 3 is "code-reasoning" (opus) or "cheap-classifier" (llama-8b). Should the caller tag explicitly via `propose_plan` args, or should the planner LLM-classify in a pre-step? Recommendation: caller tags when known, planner classifies when omitted.

2. **Profile mode → model mapping** — the routing tables in `types.ts` are draft. Confirm the model lists per capability tag before depending on them. Update the table when new models drop (Claude 5, GPT-6, etc.).

3. **BOM size cap** — proposed 12 steps max per BOM, bigger jobs split into parent + child BOMs. May need to be larger for complex multi-file refactors. Test against real plans.

4. **No-go list defaults** — the 12 seeded rules in the SQL migration are conservative. Add/remove based on your environment. The `source='default'` rows are upgradeable; user-added rules have `source='user'`.

5. **Risk class taxonomy completeness** — 8 classes feels right but might need a ninth for "system-config" (changes to stavr itself, profile mode switches, no-go list edits). Validate against a week of real decisions.
