# Stavr v0.2 release notes

**Status:** under review on `feature/v0.2-foundation-and-executor`. Not merged.

v0.2 is the BOM-driven planning + execution substrate. v0.1 was "one human approves each action"; v0.2 is "one human approves the whole plan, and the executor runs it to completion under a derived trust scope."

## What's new

### BOM planning
- New MCP tool `propose_plan` (feature-flagged behind `experimental.planner` in `stavr.yaml`). Caller gives a goal + correlation id; the steward planner returns a `bom_id` plus an approval URL.
- The planner produces a Bill of Materials: numbered steps, each tagged with a capability (reading / code-execution / code-reasoning / …), a risk class (read-only / write-local / external-comm / …), and a model assignment chosen from the active profile's routing table.
- Profile modes seeded at first boot: **Turbo**, **Balanced** (default), **Eco**. Routing, budget caps, and approval policy are per-mode and live in the `profile_config` table.
- The "food-label" approval card renders at `http://127.0.0.1:7777/dashboard/plans` — risk-envelope chips, total cost estimate + max, step-by-step preview with per-step model and cost. Approve/Reject buttons emit the corresponding event into the audit log.

### BOM executor
- `BomExecutor` subscribes to `bom_approved`, walks the active version's steps in topological order honouring `depends_on`, dispatches each step through the connector registry, and persists progress to `bom_steps`.
- On step failure: retries up to `maxRetriesPerStep` (default 3) before invoking `planner.replan()`. If the replan stays within the original risk envelope, the new version is activated and the loop resumes; otherwise the BOM is paused with `bom_failed` carrying the escalation reason.
- On daemon restart, the executor scans `boms.status='running'` rows and resumes from the latest incomplete step.

### Connector bus
- `Connector` interface and `ConnectorRegistry` are the extension point for orange-brick adapters. Each connector exposes a config schema (rendered by the inspector), a list of capabilities (each tagged with capabilityTag + riskClass), and an `exec()` entry point.
- First concrete implementation: **WebhookConnector**. Config: URL, method, auth (none / bearer / basic / custom header), static headers, timeout, retries. Capability: `webhook_fire`.

### Local-source brick installer
- `src/bricks/installer.ts` reads `stavr-brick.json`, validates with Zod, copies the brick to `~/.stavr/bricks/<id>/`, persists the row in `installed_bricks`, dynamically imports the brick's entry, and registers the returned Connector.
- Path traversal in `entry`, invalid kinds, and duplicate ids are rejected at validation.
- On daemon boot, `rehydrate()` re-registers every enabled installed brick — no reinstall required across restart.

### Risk envelope + no-go list
- New canonical `RiskClass` taxonomy (8 classes) lives at `src/types/stavr-bom.ts`.
- `no_go_list` table seeded with 12 default rules covering destructive shell, schema-destructive SQL, credential rotation, external email, payment endpoints, prod deploys.
- `src/policy/nogo.ts` matchNoGo() is the pure matcher; persistence is opaque to the matcher.

### SSE stability fix
- `/mcp/sse` and `/events/sse` now write a `: heartbeat <ts>\n\n` comment every 25s. The 5-minute body-timeout reconnect cycle on undici-based clients is gone.

### Dashboard
- `/dashboard/plans` page lists BOMs by status, shows the food-label approval card, and pushes live progress via the existing `/dashboard/stream` SSE.
- New routes: `GET /dashboard/plans/list`, `GET /dashboard/plans/:bomId`, `POST /dashboard/plans/:bomId/respond`.

## Cross-cutting

### Project rename: cowire → stavr
The rename is bundled here because it landed mid-run; the BOM PR carries the rebrand sweep across source, docs, tests, and design artifacts. Residual work (repo URL on GitHub, npm publish target, brick scratch dir paths) is tracked in `REBRAND-NEXT-STEPS.md`.

### Feature flags
`experimental.planner` defaults to `false`. With the flag off, the v0.2 subsystem (planner + executor + connector registry + brick installer) is not instantiated; the daemon behaves exactly as v0.1. Flip the flag in `~/.stavr/stavr.yaml` to enable.

## Acceptance criteria — checklist

Backend
- [x] `npm run build` and `npm test` green at every commit on the feature branch.
- [x] Schema migration applied to fresh `~/.stavr/stavr.db`; all tables from the schema migration present.
- [x] SSE heartbeats live; no body-timeout errors over a 30-minute observation.
- [x] `experimental.planner` toggles availability; default false.
- [x] `propose_plan` MCP tool registered + callable; returns `{ bom_id }` on success.
- [x] Approving a BOM creates a `trust_scope_granted` whose allowed risk classes match the BOM envelope, links `bom.scope_id`, emits `bom_approved`.
- [x] `BomExecutor` subscribes to `bom_approved`, dispatches steps per `depends_on`, persists `bom_step_*` events, calls `planner.replan()` on failure, advances `bom.steps_done`, marks `bom.status='done'` on completion or `'failed'` on unrecoverable error.
- [x] Local-source brick installer + manifest validation + restart persistence.
- [x] WebhookConnector with the full `Connector` interface.

Frontend
- [x] `/dashboard/plans` route serving the HTML page.
- [x] Click expands the food-label approval card; Approve/Reject POSTs to the respond endpoint.
- [x] Live SSE updates from `/dashboard/stream` reflect step progress.

Integration
- [x] End-to-end smoke test passes: propose_plan → approve → executor → webhook step → bom_completed.
- [x] Webhook connector exercised through the executor; response captured in step result.

Process
- [x] One feature branch: `feature/v0.2-foundation-and-executor`.
- [x] One PR open against `main`, NOT merged. Description summarises the BOM and lists acceptance criteria.
- [x] All commits use Conventional Commits.

## What's deliberately not in this PR

- GitHub and npm brick source installers — local only here. (`proposed/external-brick-sources.md` is the design.)
- Concrete connectors beyond Webhook (Wiser, Unifi, Roblox, Unity wait).
- Topology / Streams / Decide / Kit / Home dashboard pages — only Plans is in scope.
- Removal of the existing reactive steward loop — it stays parallel to the planner.
- Repo move on GitHub (`Kstkoda/cowire` → `stenlund/stavr`) — see `REBRAND-NEXT-STEPS.md`.

## Risk envelope honoured during the build

`read-only`, `write-local`, `execute`, `write-remote` (feature branch + one PR). No force-push, no credential edits, no external comms outside this PR, no financial spend. The runner stopped once at a contradiction — the user's parallel rename clashed with the BOM's "do not rename" rule — and continued under the user's explicit instruction to adopt the rename.
