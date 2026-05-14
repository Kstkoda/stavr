# stavr — positioning

One-pager. Drop into the main `README.md` when you update it, or into product copy / docs / pitches.

## What stavr is

**stavr plans multi-step work, routes each step to the right AI model under a cost budget, and wraps anything as a connector — with a visual toolkit anyone can use.**

Think of it as the layer between "I want this done" and "it's done," running on your own machine, with the safety to walk away while it works.

## What stavr is not

- **Not an authority layer.** That space belongs to Tessera Protocol. Stavr has trust scopes and an audit log under the hood, but they're plumbing — the same way every database has transactions but no database sells itself as "a transaction layer."
- **Not a workflow builder.** Stavr doesn't ask you to draw flowcharts. The planner produces the plan; you review and approve it as a single artifact.
- **Not a cloud service.** Everything runs on your machine. Local AI is a first-class peer to cloud AI. The only thing leaving your network is what you explicitly route through external connectors.
- **Not Claude-only.** Claude is the default brain for the steward, but any chat-completion model can be the brain. Per-step routing is multi-model by design — local Llama, Mistral, GPT, Gemini, whatever you've configured.

## The four pillars

### 1. BOM-driven planning
A goal comes in. A structured **Bill of Materials** comes out — numbered steps, each tagged with what capability it needs, which model handles it, what risk class it carries, and what it costs. You read it like a food label: ingredients, cost, what's allowed, what isn't. One click approves the whole plan. stavr runs to completion including retries and fixes — only interrupts you for explicitly destructive actions on the no-go list.

### 2. Connector bus
A standardized way to plug anything into stavr. MCP servers (GitHub, Gmail, Slack), local OS access (files, terminal, PowerShell), home automation (Wiser, Hue), network gear (Unifi), games (Roblox, Unity), webhooks, cron, SMTP, custom scripts — they all look the same to the planner: an orange `Connector` brick that exposes capabilities the planner can use in BOM steps. Anyone can add a new connector by implementing the interface.

### 3. Profile-based cost routing
Three modes:

- **Turbo** — best model for each step, no cost ceiling. For when output quality matters more than spend.
- **Balanced** (default) — cheapest model that fits the capability. Promotes on failure. Soft cap $20/day, hard $40.
- **Eco** — local AI first. Refuses paid calls without your explicit nod. Soft cap $5/day, hard $10.

Each mode is a config: budget caps + per-capability model preference list + failure policy. Mode switching is one click; it affects the next dispatch, not in-flight work.

### 4. Visual toolkit
A DUPLO-style canvas where the stavr rail runs across the middle, external services sit above (cloud, needs auth), local capabilities sit below (your machine), and brain bricks plug into a socket at the end of the rail. Click any brick to configure it — each brick owns its own form fields (Wiser wants OAuth, Unifi wants controller URL + credentials, webhook wants URL + auth method). Drag from "The Shelf" to add new pieces. Color codes the type — purple is cloud AI, yellow is local AI, blue is MCP tools, gray is OS access, green is filters, orange is connectors, red is stavr itself.

## Who stavr is for

Two roles, same product:

- **The engineer** who wants to plan work across multiple AI models, pin per-step model assignments, audit every action, integrate arbitrary services, and trust the system enough to run jobs unattended.
- **The non-technical user** (think your partner, a junior employee, a client) who wants to add a "Gmail" brick, drop a "Llama" brain into the steward, and say "sort my inbox into important and not" without learning what an MCP is.

If both can use the same dashboard, the design is right.

## The headline sentences

If you have to describe stavr in one sentence, pick one of:

- "stavr plans your work, picks the cheapest AI that can do each step, and only interrupts you when something destructive needs your nod."
- "A local orchestrator that turns a goal into a reviewable plan, routes each step across local and cloud AI under a cost budget, and lets anyone plug in new tools as visual bricks."
- "Approve a plan once. Walk away. Come back to a result you can audit."

If you find yourself reaching for "authority layer" or "scoped, revocable permissions" — stop. That's Tessera's sentence. Use one of the three above.

## What makes stavr defensible (and what doesn't)

**Defensible:**
- BOM as the unit of approval (Tessera grants credentials per action; stavr approves whole plans)
- Connector bus + visual toolkit UX (no one else has this for local agent orchestration)
- Profile-based cost routing with local-AI-first Eco mode (most agent systems assume cloud)
- Local-first + Claude Desktop / Cursor / IDE integration via MCP

**Not defensible (and that's fine):**
- The trust scope + audit log substrate — same shape as Tessera, multiple other systems converging on it
- The risk-class taxonomy — anyone designing this space will land on something similar
- The default-deny + explicit-grant pattern — this is just how authority should work

The point is: stavr's value is in pillars 1-4 above. The safety mechanism underneath is necessary but unremarkable. Don't market the unremarkable parts.
