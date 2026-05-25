# tests/fuzz — Phase 5 adversarial properties

Seeded generative property tests over stability-critical pure-function
surfaces. Each file is one surface; each `it.each([...])` is one
invariant.

Surfaces covered (Phase 5):

| File | Surface | Why it's stability-critical |
|---|---|---|
| `mcp-envelope.fuzz.test.ts` | `normalizeMcpMethod` + `normalizeMcpToolName` | Unbounded label values would blow Prometheus cardinality and DoS the gateway-metrics path. Cardinality cap MUST hold for every input. |
| `respond-policy.fuzz.test.ts` | `mayRespond` (decision-respond gate) | Self-approval refusal + operator-only check are the family-mode security floor. Phase 4.5's HARD RULE: every code path through `mayRespond`. |
| `host-exec-allowlist.fuzz.test.ts` | `validateAllowlistCall` | The only chokepoint between AI tool and arbitrary code execution on the operator's host. Shell-metachar / path-shape filters MUST hold. |
| `trust-scope.fuzz.test.ts` | `matchesOne` + `scopeCovers` | Trust scope is the per-tool authorization decision. Forbidden MUST override allowed; status=inactive MUST refuse regardless of match. |

## Seeding

Each test passes `STAVR_HARDENING_SEED` (or a fixed default) into
fast-check's `seed` option, so failures are reproducible:

    STAVR_HARDENING_SEED=12345 npx vitest run tests/fuzz

The shrunken counter-example is logged in the fast-check assertion
output; reproduce by re-running with the same seed.

## What's intentionally out of scope

JSON-RPC envelope parsing at the SDK layer (the MCP SDK owns it; we
fuzz our normalisation of the parsed method/tool names instead).
Network-level fuzz of the HTTP transport (that's chaos territory —
Phase 4b's netchaos slice covers loss/latency; Phase 4a covers
mid-RPC restart). Worker-dispatch scope-aware enforcement is gated on
`proposed/worker-dispatch-bom.md` Phase 4 landing — Phase 5 will
cover (`actor` × `source_agent` × `grant-scope`) tuples once that
surface exists; until then trust-scope.fuzz covers the matcher-level
invariants.
