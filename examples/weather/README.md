# Weather adapter (reference example)

A minimal Stavr adapter that exposes one MCP tool, `weather.current`, backed by OpenWeather's HTTP API. This is the worked example referenced by [`docs/writing-an-adapter.md`](../../docs/writing-an-adapter.md).

This adapter is **not registered in `src/server.ts`** — it exists purely as reference code. To use it, copy `weather-adapter.ts` to `src/adapters/weather.ts` and add an import in `createSwitchServer`.

## What it demonstrates

- The `registerXxxTools(server, opts?)` pattern.
- A test seam (`opts.fetcher`) so unit tests can stub HTTP without hitting the network.
- HTTP wrapping with timeout, status-code handling, and a typed error class.
- Zod input validation with descriptive `.describe(...)` strings.
- Tool-card declaration in a comment (Wave B of spec 41 will wire this up).
- A vitest spec mirroring the patterns in `tests/github-adapter.test.ts`.

## How to enable

```bash
cp examples/weather/weather-adapter.ts src/adapters/weather.ts
# then edit src/server.ts to import and register:
#   import { registerWeatherTools } from './adapters/weather.js';
#   registerWeatherTools(server);
```

Set `OPENWEATHER_API_KEY` in the environment of the Switch process. Without the key the tool returns an error rather than crashing.

## Standalone compile check

```bash
npx tsc --noEmit examples/weather/weather-adapter.ts
```

This is the smoke test that the example is well-typed against the current SDK.

## Files

- [`weather-adapter.ts`](./weather-adapter.ts) — the adapter, ~110 lines.
- [`weather-adapter.test.ts`](./weather-adapter.test.ts) — the vitest spec.
