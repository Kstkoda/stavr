# Stavr Dashboard (v0.3)

The dashboard is your oversight surface for a running stavr daemon. It binds
to `127.0.0.1:7777` by default and hosts eight pages plus a JSON data plane.

> Local-first by design. There is no auth, no CORS, no multi-user model.
> See [ADR-006](../adr/006-daemon-binds-127001-only.md).

```
http://127.0.0.1:7777/dashboard
```

`GET /dashboard` redirects to `/dashboard/home`. Every page shares the same
shell (top nav, inspector panel, connection banner) and the same Dark 2.0
design tokens. Every page paints from a server-side snapshot on initial
load, then live-refreshes via SSE on relevant event kinds.

---

## Pages

### Home (`/dashboard/home`)
At-a-glance daemon picture in four cards.

| Card | What it shows | Click target |
|---|---|---|
| Daemon health | uptime, port, version, active scope count, event count; profile-mode pill | Profile pill → Settings |
| Active BOMs | total count + 3 most recent as food-label mini cards | Card → Plans (deep-linked) |
| Recent decisions | 5 most recent decisions as food-label cards | Card → Decide |
| Quick actions | shortcuts to Plans / Decide / Topology / Settings | each → that page |

Aggregator endpoint: `GET /dashboard/home/data` returns `{ health, boms, decisions }` in one round-trip. The page paints from this on first load and re-fetches on SSE pings (debounced 200ms) plus a 5s fallback poll.

### Topology (`/dashboard/topology`)
SVG ops control center. Steward (red circle) sits on a horizontal red bus; bricks tile above (external), workers tile below (internal). Click any node → inspector slides in with live status + recent events + actions.

Time scrubber along the bottom drags the view backward through history; release snaps back to live. Workers whose `started_at..ended_at` doesn't span the scrubbed-to moment dim.

Right sidebar: in-flight BOMs grouped by trust scope, rendered as compact food-label cards.

Live updates: every `worker_*`, `bom_step_*`, `trust_scope_*` event triggers a debounced reload (600ms).

Deep-link: `/dashboard/topology#<bom-id>` scrolls to + inspects that BOM's node.

### Streams (`/dashboard/streams`)
Multi-pane terminal view for live worker output. Up to 20 panes in a 4-wide responsive grid; each pane shows worker name + type + status pill and tails the last ~8 events.

Top bar: substring search across panes, type filter, status filter, visible count.

Workers with no output in 2 minutes fade to half opacity (crashed workers stay full opacity).

Click ⤢ on any pane → that pane opens full-screen.

Live append on `/dashboard/stream` — matches events on `correlation_id` or `payload.id` against worker ids.

### Plans (`/dashboard/plans`)
Every BOM as a food-label card with What / Risk / Reversible / Cost. Click expands inline detail — full step list, deps, profile, trust scope, Approve / Reject buttons.

**Allowed vs Will-ask-first** strip under each card visualises the envelope split:
- Green chips: classes pre-approved on scope creation (read-only / write-local / execute / write-remote)
- Amber chips: classes that always re-prompt (destructive / financial / credential / external-comm)

Approve POSTs to `/dashboard/plans/:id/respond` (existing API, unchanged) and navigates to `/dashboard/topology#<bom-id>` on success.

Status filter chips (proposed / running visible by default) with live counts.

### Decide (`/dashboard/decide`)
Open decisions as cards with the question + options as buttons + live countdown timer.

- Timer goes amber by default, red at ≤30s, pulses red at ≤10s
- Default option is flagged; cards with no default are red-warned (timeout errors)
- Context block lazy-loads last 3 events related to the decision
- Option click → POST `/dashboard/decisions/:id/respond` (existing API)

Recently-resolved section below, dim, with chosen option + responder + reason.

Live refresh on every `decision_*` event.

### Toolkit (`/dashboard/toolkit`)
ESB bus visualisation. Bricks tile above (external — purple / orange / blue) and below (internal — green / yellow / blue) the red steward bus.

Click any brick → inspector with a form rendered from its `configSchema()`. Save / Test buttons in the inspector footer:
- Save → `POST /dashboard/bricks/:id/apply` with `{ config }`
- Test → `POST /dashboard/bricks/:id/test`
- Install → sidebar `POST /dashboard/bricks/install` with `{ source_path }`

Form fields by `kind`: text / url / password (masked, secret) / number / toggle / select / headers (KV editor) / schedule (cron) / oauth (button) / json / path.

Secret-field defaults are stripped before serialisation — a saved password never echoes back into the rendered form.

Deep-link: `/dashboard/toolkit#<brick-id>` auto-opens the inspector for that brick.

### Capabilities (`/dashboard/capabilities`)
Lego baseplate showing what each profile mode unlocks. One slot per `CapabilityTag`; toggle Turbo / Balanced / Eco at the top to re-render the slot grid.

Slots are colour-tiered by model:
- **Opus** — purple stud
- **Sonnet** — blue stud
- **Haiku** — yellow stud
- **Other** — grey stud

Below the baseplate: budget + policy card per mode (daily soft / daily hard / per-job soft, on_capability_miss, approval_policy, steward_brain).

Read-only in v0.3. Editing assignments is a v0.4 concern; for now swap the active profile from Settings.

### Settings (`/dashboard/settings`)
Every config the daemon stores in its DB has a UI control here.

**Profile mode.** Radio cards for Turbo / Balanced / Eco. Click flips active mode and emits `profile_mode_switched`. `POST /dashboard/settings/profile`.

**Trust scopes.** Table of active scopes with Extend (prompts for hours) and Revoke buttons. Both call into `trustStore` and emit matching events. `POST /dashboard/settings/scopes/:id/{extend,revoke}`.

**No-go list.** Every rule with source tag. Default rules are read-only; user rules can be toggled + deleted. Add-form supports custom risk_class + pattern. `POST /dashboard/settings/nogo`, `/dashboard/settings/nogo/:id/{toggle,delete}`.

**Bricks.** Installed bricks with Configure (→ Toolkit) and Uninstall buttons; install form mirrors Toolkit's sidebar. `POST /dashboard/bricks/install`, `/dashboard/bricks/:id/uninstall`.

---

## Design language

All design decisions live in [ADR-028](../adr/028-dashboard-architecture.md). Key invariants:

- **Colour coding**:
  - external AI = purple (`--accent-ai-external`)
  - internal AI = yellow (`--accent-ai-internal`)
  - MCP utilities = blue (`--accent-mcp`)
  - steward = red (`--accent-steward`)
  - connector above bus = orange (`--accent-connector-above`)
  - connector below bus = green (`--accent-connector-below`)
- **Food-label visual grammar**: 4-cell card with What / Risk / Reversible / Cost. Re-used wherever an action surfaces for approval.
- **ESB framing**: steward is the bus (red), external above (purple/orange), internal/local below (yellow/green/blue).
- **No connecting lines** between bricks — they're either registered or not. Lego/DUPLO don't have wires.
- **Three profile modes**: Turbo (Opus all the way), Balanced (Sonnet + Opus for hard steps), Eco (Sonnet/Haiku, fail-fast).

---

## Data plane

The dashboard pages consume these JSON endpoints (unchanged from v0.2; some added in v0.3):

| Endpoint | Purpose |
|---|---|
| `GET /dashboard/status` | uptime, scopes, event counts |
| `GET /dashboard/home/data` | Home aggregator (v0.3 new) |
| `GET /dashboard/workers` | worker list |
| `GET /dashboard/workers/:id` | one worker + recent events |
| `GET /dashboard/events` | filterable history |
| `GET /dashboard/plans/list` | BOM list |
| `GET /dashboard/plans/:id` | BOM + steps |
| `POST /dashboard/plans/:id/respond` | approve / reject |
| `GET /dashboard/decisions` | open or resolved decisions |
| `POST /dashboard/decisions/:id/respond` | resolve decision |
| `GET /dashboard/stream` | SSE event tap |
| `GET /dashboard/export` | JSON / CSV audit dump |
| `POST /dashboard/bricks/install` | install a brick (v0.3 new) |
| `POST /dashboard/bricks/:id/apply` | applyConfig (v0.3 new) |
| `POST /dashboard/bricks/:id/test` | testConnection (v0.3 new) |
| `POST /dashboard/bricks/:id/uninstall` | uninstall (v0.3 new) |
| `POST /dashboard/settings/profile` | switch profile mode (v0.3 new) |
| `POST /dashboard/settings/scopes/:id/extend` | extend scope (v0.3 new) |
| `POST /dashboard/settings/scopes/:id/revoke` | revoke scope (v0.3 new) |
| `POST /dashboard/settings/nogo` | add user no-go rule (v0.3 new) |
| `POST /dashboard/settings/nogo/:id/toggle` | toggle user rule (v0.3 new) |
| `POST /dashboard/settings/nogo/:id/delete` | delete user rule (v0.3 new) |

---

## Accessibility

The shell carries `role="navigation"` + `aria-label="Primary"` on the top nav and `role="main"` on the page container. Every interactive element has a label or text content. The active nav entry has `aria-current="page"`. The inspector panel has `aria-hidden` toggling; the connection banner has `role="status"` + `aria-live="polite"`.

Focus styles use the MCP-blue accent at 2px offset; the brick component's SVG carries `role="button" tabindex="0"` so it's keyboard-reachable.

---

## Architecture

See [ADR-028](../adr/028-dashboard-architecture.md) for the full rationale. Quick reference:

```
src/dashboard/
  tokens.ts                # Dark 2.0 CSS custom properties
  shell.ts                 # renderShell({ title, activePage, body, ... })
  index.ts                 # mountDashboardPages(app, deps)
  components/
    food-label.ts          # 4-cell What/Risk/Reversible/Cost card
    brick.ts               # Lego/DUPLO-style SVG node
    inspector.ts           # right-side floating panel
    pill.ts                # status / variant badges
    scrubber.ts            # time-scrubber slider
  pages/                   # one file per nav entry
    home.ts topology.ts streams.ts plans.ts decide.ts
    toolkit.ts capabilities.ts settings.ts
  adapters/
    bom.ts                 # BOM → food-label + risk split
    decision.ts            # DecisionRecord → food-label
    topology.ts            # workers + bricks → layout
```

Tests live in `tests/dashboard/`, one file per page plus one per component plus the e2e walkthrough.
