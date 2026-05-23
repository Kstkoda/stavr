# BOM: stavR Hardening — Test & Resilience Coverage Recon

**Owner:** CC
**Sensitivity:** `routine` — read-only recon. No code, test, or workflow changes. The deliverable is one findings document.
**Verification window:** n/a — the recon's "verification" is the operator reviewing the output doc.
**Branch:** `chore/hardening-recon` (off current `main`).
**Base:** current `main`.
**Estimated scope:** 1 phase (recon), one document, ~half a day of CC time. STOP for operator review.

---

## Why this BOM exists

stavR's recent defects cluster into one pattern: **unit-tests-green, never-exercised-end-to-end.** The Telegram approval poller was never wired. `wincred` declared a dependency version (`^1.1.6`) that has never existed on npm. The MCP transport was constructed with no `eventStore`, silently losing in-flight calls. v0.7 federation merged but never worked cross-machine. `/status` reported a stale version. Every one of these passed all ~1665 unit tests. The defects live in the *seams* between components and in the gap between "works on the dev box" and "works installed, cross-machine, under stress."

The fix is a hardening rig: a reproducible, disposable environment that exercises stavR end-to-end under fault injection and adversarial load, with **oracles** that detect when an invariant breaks. Before that rig can be designed, we need an honest map of what test / chaos / soak / perf infrastructure **already exists**, so the rig extends it rather than duplicating it.

**This BOM is recon only. It builds nothing.** It produces the coverage map and gap analysis that the hardening-rig design — and a 10-3-1 on scope — will be built on.

## What the recon must inventory and assess

1. **Test asset inventory.** Walk `tests/`. Categorize every test file (unit / integration / e2e / chaos / soak / security / trust / transport / workers / persistence / observability / federation). For each category: file count and a one-line characterization of what it actually exercises. Critically, classify each as **mocked-unit** (collaborators stubbed), **integration** (real components wired together), or **e2e** (a whole daemon process running over a real transport). The headline "~1665 tests" hides this split — surface it.

2. **CI / automation inventory.** Every `.github/workflows/*.yml` — trigger, what it runs, how long, what class of defect it would catch. Specifically: does `soak.yml` run on a schedule, for how long, and does it assert on memory growth? Is there any cross-machine / multi-node job at all? Note `daemon-sea.yml`, `governor-build.yml`, `governor-release.yml`.

3. **Ad-hoc perf / load assets.** Inventory `tmp/perf/*` — `load-runner.mjs`, `freeze-probe.mjs`, `peer-smoke.mjs`, `spin-peer.ps1`, the `phase7-*` JSON outputs. Are these a reusable harness or one-shot scratch? What did `peer-smoke` / `spin-peer` attempt (federation/peer exercise)? What is salvageable into a real rig?

4. **Escaped-bug → coverage map.** For each real defect that reached a running system — Telegram poller never wired; `wincred` phantom dependency; MCP transport built with no `eventStore`; federation never working cross-machine; stale `/status` version; the v0.6.x memory leak; the family-mode-phase-1 self-approval hole — state which test layer *would* have caught it and why the existing suite did not. This is the gap analysis grounded in real incidents, not hypotheticals.

5. **Five-layer rig assessment.** For each candidate layer report what exists today, what is missing, and a rough effort band (S / M / L):
   - (a) **Topology virtualization** — multi-daemon + relay-hub federation on simulated LAN/WAN; the layer that would finally exercise cross-machine federation.
   - (b) **Fault injection / chaos** — process kills, netem latency/loss, partitions, disk-full, clock skew, projection corruption.
   - (c) **Adversarial load / fuzz** — malformed JSON-RPC, session churn, forged actor IDs, self-approval attempts, gated calls without scope.
   - (d) **Soak / endurance** — sustained load with RSS / heap / event-loop-lag tracking.
   - (e) **Oracles / continuous invariant checks** — the detection layer.

6. **Oracle / invariant audit.** What invariants are asserted *anywhere* today? Is there a test that the event-log hash chain (ADR-036) stays intact across writes? That the SQLite projection rebuilds from the log (family-mode-phase-2 Phase 2 ran a one-off "event-log smoke" — is it a permanent test or throwaway)? List the invariants that *should* be continuously checkable but currently are not.

7. **Reproducibility check.** Do the existing chaos / load tests use seeded randomness? Can a failure be replayed deterministically to a minimal repro? Non-reproducible hammering is low-value — flag it if that is the current state.

## Output

`proposed/hardening-recon.md`, containing: the coverage map (tasks 1-3), the escaped-bug gap analysis (task 4), the five-layer assessment with effort bands (tasks 5-7), and a recommended **scope shortlist** to seed the operator's 10-3-1 on how large a rig to build and whether it earns its own cycle. **Operator reviews before any rig is built.**

## Don't-touch

Recon is strictly read-only. Do not write or modify any test, workflow, or source file. Do not build any part of the rig. Do not run the soak or load scripts (inventory and read them — do not execute long-running jobs). The single deliverable is `proposed/hardening-recon.md`.

## Run prompt for CC

```
Read CLAUDE.md, then proposed/hardening-recon-bom.md. Execute the recon —
inventory and assess stavR's existing test / chaos / soak / perf coverage
per the seven tasks in the BOM. Output proposed/hardening-recon.md and STOP.

This is read-only: no code, test, or workflow changes; do not run long
soak/load jobs; do not build any rig. One document, one commit, DCO
sign-off (-s).

Skärp och hängslen: git status --short + git symbolic-ref HEAD before every
mutating git op. Stay on chore/hardening-recon.

Go — recon only, then STOP for operator review.
```

---

## End of BOM
