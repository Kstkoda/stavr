/**
 * Global vitest setup. Runs once before the test suite starts.
 *
 * Phase 2 of family-mode-phase-1 introduced a structural chokepoint that
 * routes every CONFIRM- and EXPLICIT-tier tool call through an
 * `await_decision` cycle (see `src/security/decision-gate.ts`). Existing
 * tests that exercise worker_spawn / host_exec / propose_plan / etc would
 * otherwise hang on the 1800s decision timeout (vitest's testTimeout is
 * 15s) — so the suite opts in to the documented test-mode auto-approve.
 *
 * Production never sets STAVR_CHOKEPOINT_TEST_AUTO_APPROVE. Negative-path
 * tests for the real decision route in `tests/security/chokepoint.test.ts`
 * delete the env var in their own setUp so they exercise the live gate.
 *
 * No-Go list and Layer 0 capability deny still fire in test mode — only
 * the per-actor CONFIRM/EXPLICIT decision route is short-circuited.
 */
process.env.STAVR_CHOKEPOINT_TEST_AUTO_APPROVE = '1';
