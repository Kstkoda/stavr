# ADR 004 — Zod for event-payload validation

**Status**: Accepted
**Date**: 2026-05-12

## Context

Every event published through Switch has a typed payload that depends on its `kind` (e.g. `commit_pushed` carries `{sha, message, branch}`, `decision_request` carries `{question, options, default_option_id?, deadline_seconds}`). The same shapes need to be validated at runtime (untrusted callers across MCP) and known at compile time (TypeScript code that consumes events). The natural representations are JSON Schema (machine-readable, language-agnostic) and Zod (TypeScript-first, validation + type inference in one declaration).

## Decision

Declare every event payload as a Zod schema in `src/event-types.ts`. Use `z.infer` to get the TypeScript types for free. At runtime, `validatePayloadForKind(kind, payload)` looks up the schema by kind and `.parse`s. For external consumers that want JSON Schema, generate `dist/schemas/events.json` from Zod via `zod-to-json-schema` at build time (planned in spec 41 Wave B).

## Consequences

- **One source of truth.** Schema, TypeScript type, and runtime validator are the same declaration. Drift is impossible.
- **Excellent DX inside TS.** `z.infer<typeof Foo>` plus structural narrowing covers the common cases without manual `interface` duplication.
- **Generated JSON Schema for outside consumers.** Other agents and Switch instances can consume the JSON Schema without speaking TypeScript — that's the deliverable for spec 41 Wave B.
- **Build-step required.** External consumers don't read Zod directly; they read the generated JSON Schema. Forgetting to regenerate means stale public contracts (mitigated by a CI gate in Wave B).
- **Zod ≠ JSON Schema 1:1.** Some Zod constructs (e.g. `refine`) don't translate cleanly. We avoid them in event-payload schemas to keep the export faithful.

## Alternatives considered

- **JSON Schema, hand-written.** Verbose, and you still need a separate TS type or manual duplication. Drift between the schema and the type was the original failure mode this ADR is designed to prevent.
- **TypeScript types only, validated nowhere.** Trusts every caller. Acceptable inside the process; unacceptable across an MCP boundary.
- **Protobuf / similar IDL.** Heavy for a small set of event kinds. The build, the language bindings, and the documentation tax all exceed what we'd save.
