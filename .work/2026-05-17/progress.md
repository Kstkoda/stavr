# v0.4 visible-value bundle — overnight run 2026-05-17

## Context notes

Several reference files in OVERNIGHT_TASK_2026_05_17.md were not present in the
repo at the start of this run:

- `CLAUDE.md` — absent at repo root
- `docs/stavr-progress-and-plan.md` — absent
- `design-mockups/dashboard-mockup-v8.html` — absent
- `design-mockups/README.md` — absent
- `memory/SESSION_2026_05_16.md` — absent (only `project_stavr_runtime_toggles.md`
  found in `memory/`)

The v8 visual refresh (Phase 3) is therefore implemented from the textual
description in the brief plus the existing tokens / page structure in
`src/dashboard/` — no canonical mockup HTML was available to copy verbatim.
The visual language stays close to the existing Dark 2.0 tokens with the
additions called out in §3.2 (rust-glow, bg-popover, backdrop blur).

The MCPs registry static list (Phase 4) was hand-curated from public knowledge
of the github.com/mcp directory — there is no `memory/SESSION_2026_05_16.md`
snapshot to draw from. Entries are best-effort and the URLs reflect the
public directory structure; users should refresh the list when github.com/mcp
publishes a stable export.

## Phase log

- Phase 1: branch + scaffold — done
- Phase 2: OllamaProvider + profile routing + observability — done
  - `src/steward/providers/ollama.ts`: provider with `/api/chat` (non-stream) + `listAvailableModels()` via `/api/tags`. Mock tool-call mapping, system-prompt + multi-turn message mapping, AbortController-based timeout. Observability via `recordProviderRequest` + `recordProviderLatency` in finally block.
  - `src/observability/metrics.ts`: added `stavr_provider_requests_total` counter + `stavr_provider_latency_seconds` histogram with `{provider, model, status}` labels. Model-label cardinality kept bounded via truncation.
  - `src/types/stavr-bom.ts`: added four `local-*` capability tags as union members; added `LOCAL_FRIENDLY_TAGS` and `isLocalModel()` helpers. Routing tables updated for all three profiles per brief §2.3: Turbo never local, Balanced local for `cheap-classifier` + `simple-summary` + `local-*`, Eco local-first across every local-friendly tag. Frontier fallback retained in every Balanced row.
  - `src/steward/planner.ts`: extended `estimateStepCost` + `estimateStepDuration` for the four local-* tags; added Ollama models to the price table (zero per-token cost); updated planner LLM system prompt to include the new tags.
  - `src/daemon.ts`: lazy singleton `getOllamaProvider()` for dashboard consumption + `_resetOllamaProviderForTests()` test seam. The Steward subprocess still selects one primary provider per `steward-config.yaml`; cross-provider step routing is a v0.5 portability concern (ADR-032).
  - Tests: 37 new — `tests/steward/providers/ollama.test.ts` (7 cases: happy path, tool_calls, error mapping, listAvailableModels, host trim, message mapping), `tests/steward/planner-routing.test.ts` (matrix invariants across all three profiles), `tests/observability/ollama-metrics.test.ts` (Prometheus label assertions).
  - Full suite: 502 passing / 1 pre-existing skip.
