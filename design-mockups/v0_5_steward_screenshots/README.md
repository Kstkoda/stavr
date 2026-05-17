# v0.5 Steward portability — screenshots

Placeholder for the screenshots the BOM §P6 calls for:

- `diagnostics-steward-panel.png` — `/dashboard/diagnostics` rendered with the
  new Steward subprocess panel showing PID, autonomy mode chip, last
  heartbeat, lessons count, working-memory keys.
- `topology-with-steward-node.png` — `/dashboard/topology` showing the
  `stavr-steward-agent` subprocess as a `core` node.
- `pm2-list.png` — `pm2 list` with both `stavr` and `stavr-steward-agent`
  online.

**Status (autonomous run, 2026-05-17):** screenshots not captured. The
autonomous run had no PM2 environment, no live browser, and no spawned
subprocess to photograph; the BOM explicitly flagged visual fidelity as
NOT a stop condition. Capture deferred to the human reviewer (Kenneth)
once the parity-shadow soak begins.

The panel renderer + test coverage are in:
- `src/dashboard/pages/diagnostics.ts:renderStewardPanel`
- `tests/dashboard/steward-panel.test.ts`
