# ADR 023 — Param-constraint matching syntax (exact + `^`-prefix regex)

**Status**: Accepted
**Date**: 2026-05-12

## Context

A trust scope's `allowed_actions` and `forbidden_actions` are
`{ tool, param_constraints }` matchers. The matcher language has to cover the
real cases ("just this repo", "any of Kenneth's repos", "this command only")
without being so flexible that a misread matcher silently auto-approves an
action it shouldn't have.

## Decision

Tool names match by exact string equality. `param_constraints` is a flat
record of `string → unknown`. For each entry:

- A string value starting with `^` is treated as a JavaScript `RegExp` and
  tested against `String(actualValue)`. Example: `{ repo: '^Kstkoda/.*' }`
  matches any repo under `Kstkoda/`.
- Any other value is compared by deep equality against the actual arg. Strings,
  numbers, booleans, nested objects, and arrays all work. Example:
  `{ repo: 'Kstkoda/privacy-tracker' }` matches only that exact repo.
- An omitted `param_constraints` (or `{}`) means "any args for the named
  tool" — equivalent to a wildcard on params.

All constraint entries must match for the matcher to match (AND inside one
matcher). Multiple matchers OR together. A `forbidden_actions` match is an
unconditional veto, evaluated first.

## Consequences

- The default mode is strict: equality matching means a typo in the scope's
  param_constraints will simply fail to match, not over-match.
- The `^` prefix is a single, obvious tell that "this is a regex." Reading a
  proposed scope, Kenneth can tell at a glance which fields are loose and
  which are tight.
- Regexes are anchored only at the start (the `^` is part of the pattern, not
  added by us). That means `^a/.*` matches "a/b" and "a/b/c"; if you want a
  full-anchor you write `^a/[^/]+$`. We accept the small cost of "write your
  own `$`" for the clarity of "the `^` you see is the only one we add."
- Matchers cannot express "tool prefix" (e.g. all `github.*`). If you need
  that, list each tool. We considered glob/prefix syntax on `tool` and ruled
  it out (see Alternatives) — the cost of "I have to list 10 tools" is small
  next to the cost of a too-clever matcher.

## Alternatives considered

- **Always-regex** — over-broad by default; one missing anchor and the scope
  matches more than the author meant. We want exact-by-default for safety.
- **Tool name globbing (`github.*`)** — see above; clarity beats convenience.
- **JSON-schema / JSONPath constraint language** — too much surface; users
  would need to learn another mini-language to read a proposed scope.
