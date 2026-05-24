# bombardment/

The forge. Tests are derivative — the rig builds the failure modes the
in-process unit suite cannot reach: install-time, end-to-end, cross-
process, sustained-load, and adversarial. Every failure the rig finds
should become a permanent regression so the floor only ever rises.

**Owning BOM:** `proposed/bombardment-rig-bom.md`.
**Recon:** `proposed/hardening-recon.md`.

## Layout

```
bombardment/
├── install-smoke.mjs            Phase 0 — boot dist/cli.js, assert /status version
├── seed.ts                      Phase 1 — STAVR_HARDENING_SEED + mulberry32 PRNG
├── capture.ts                   Phase 1 — preserve-on-failure (events + heap + manifest)
├── oracles/                     Phase 1 — continuously-assertable invariants
│   ├── index.ts                  registry + runOracles() driver
│   ├── types.ts                  Oracle, OracleCtx, OracleResult
│   ├── no-orphan-sessions.ts     broker.sessionCount() ≤ baseline + slack
│   ├── no-live-revoked-scopes.ts trust_scopes terminal-status rows have no live grant
│   ├── workers-reach-terminal.ts no stuck non-terminal workers (configurable strict mode)
│   ├── healthz-implies-live.ts   /healthz=200 ⇒ db reachable+writable, broker live
│   ├── retention-bounds.ts       operational events ≤ cap × slack
│   └── event-log-consistency.ts  decisions + workers projections agree with the log
├── load-runner.mjs              Phase 2 — multi-mode synthetic load harness (CLI, seeded)
├── observability/               Phase 2 — growth-shape helpers
│   ├── growth-shape.ts            RSS slope, baseline-return, heap per-class diff
│   └── event-loop-lag.ts          tick-to-tick scheduler lag sampler
└── artifacts/                   preserve-on-failure dumps (gitignored)
```

## Seeded reproducibility

Every workload and fault generator in the rig derives its RNG from
`STAVR_HARDENING_SEED`. Set it to reproduce a failure:

```bash
STAVR_HARDENING_SEED=42 npm run test -- tests/soak
```

Unset, the rig captures a fresh seed at startup and logs it in
`bombardment/artifacts/*/manifest.json` so a one-off failure can be
re-run.

## Oracles

An oracle is a pure check against daemon state. Each is safe to invoke
mid-load — no writes, no destructive side effects. The soak harness
runs the default oracle set at every sample window (default 60s) and
at end of run.

```typescript
import { runOracles } from '../bombardment/oracles/index.js';

const summary = await runOracles({
  kind: 'in-process',
  store,
  broker,
  baseline: { sessionCount, subscriptionCount, eventCount },
});

if (summary.failed > 0) {
  captureOnFailure(store, { reason: 'oracle_violation', oracleResult: summary.results.find((r) => r.ok === false) });
  throw new Error(`oracle violation: ${summary.failed} failed`);
}
```

## Preserve-on-failure

`captureOnFailure(store, { reason })` dumps:

- `events.jsonl` — last 5000 events from the EventStore
- `heap-<ts>.heapsnapshot` — V8 heap snapshot
- `manifest.json` — seed, oracle result, captured-at, caller-supplied extras

Artifacts land under `bombardment/artifacts/<ts>-seed<n>-<reason>/`.
CI workflows upload the directory on failure (see
`.github/workflows/soak.yml`).

## Multi-mode soak

`tests/soak/multi-mode-soak.test.ts` boots an in-process daemon
(`mountTransports({port: 0})`), spawns `bombardment/load-runner.mjs` as
a subprocess against it, runs the default oracle set every sample
window, and at end-of-run asserts:

- No oracle violations during the run (the first violation is captured
  to `bombardment/artifacts/multi-mode-soak/` via `captureOnFailure`).
- RSS ceiling (`STAVR_SOAK_RSS_CEILING_MB`, default 600).
- RSS slope < 1 MB/s (`STAVR_SOAK_RSS_SLOPE_BPS`) over the run — catches
  slow leaks that hide under the ceiling.
- `broker.sessionCount` + `subscriptionCount` return to baseline + slack.
- Workers reach terminal (strict mode at end-of-run).
- Retention sweep bounded event count under cap.

Gating: `STAVR_RUN_SOAK=1` (short, ~3 min) or `=long` (~30 min). The
weekly `.github/workflows/soak.yml` runs `long` mode with full
artifact upload (heap snapshots, heap-diff, run-summary, load-runner CSV).

Reproduce a failure:
```bash
STAVR_HARDENING_SEED=<seed> STAVR_RUN_SOAK=long STAVR_SOAK_MINUTES=10 \
  npx vitest run tests/soak/multi-mode-soak.test.ts
```

## Out of scope (deferred to other cycles)

- ADR-036 hash-chain integrity oracle (own cycle; the audit-integrity
  promise is separate from stability)
- True N-peer federation harness (Phase 3 of this BOM)
- Fault-injecting proxy + process-kill chaos (Phase 4)
- Adversarial fuzz layer (Phase 5)
- Escalation ratchet + resilience score (Phase 6)
