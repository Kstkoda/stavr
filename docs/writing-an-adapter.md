# Writing an adapter

This guide walks through adding a new adapter to Stavr, end-to-end, using a working **weather** example. By the end you'll have read enough code to add an adapter of your own and you'll have a copy-pasteable starting point in [`examples/weather/`](../examples/weather/).

An *adapter* is a file that exposes some external system (a CLI, an HTTP API, a piece of hardware) as one or more MCP tools. Adapters are the main extension point of Stavr — almost every new capability lands as either a new adapter or a new event kind.

Read this once end-to-end (~15 minutes) before starting. The full canonical example lives in [`src/adapters/github.ts`](../src/adapters/github.ts); the weather example in this guide is the minimal version.

---

## 0. Decide whether this is an adapter

A few questions to ask first:

- **Does it talk to an external system?** Adapters wrap CLIs and APIs. If your work doesn't talk to anything outside the process, it's probably an internal tool — see `src/tools/` (e.g. `decisions.ts`).
- **Is it stateless?** Adapters should not hold state across calls. State lives in the event store, not in the adapter. If you find yourself wanting an instance variable that persists across tool invocations, you're probably reaching for a feature of the broker instead.
- **Are the operations read or write?** Read-only adapters can ship with `tier: 'auto'` and run without confirmation. Write actions should go through `await_decision` — see [ADR-008](../adr/008-write-actions-await-decision.md).

If yes-yes-read, keep going.

---

## 1. File location

Adapters live in `src/adapters/<name>.ts`. One file per adapter. The file exports a `registerXxxTools(server, opts?)` function. That's the only public surface.

For our example, we'll work in `examples/weather/weather-adapter.ts` (the example lives under `examples/` so it doesn't bloat the production build). To wire it in for real, you'd move it to `src/adapters/weather.ts`.

---

## 2. The `registerXxxTools` pattern

Every adapter follows the same shape:

```ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { toolError, toolJson } from '../src/server.js';

export interface RegisterWeatherToolsOptions {
  // Test seam: override the HTTP fetcher so unit tests can stub it.
  fetcher?: (url: string) => Promise<Response>;
  apiKey?: string;
}

export function registerWeatherTools(
  server: McpServer,
  opts: RegisterWeatherToolsOptions = {},
): void {
  const fetcher = opts.fetcher ?? globalThis.fetch;
  const apiKey = opts.apiKey ?? process.env.OPENWEATHER_API_KEY;

  server.registerTool(
    'weather.current',
    {
      description: 'Get current weather for a city. Returns temperature (C), conditions, humidity.',
      inputSchema: {
        city: z.string().min(1).describe('City name, e.g. "Stockholm"'),
        units: z.enum(['metric', 'imperial']).optional().default('metric'),
      },
    },
    async ({ city, units }) => {
      if (!apiKey) return toolError('weather adapter requires OPENWEATHER_API_KEY');
      // ... see the full example below
    },
  );
}
```

Three things to notice:

1. **`opts` has a test seam.** The `fetcher` option lets tests pass in a stub instead of letting the adapter hit the real network. Every adapter must have this seam. For CLIs, the seam is an `exec` runner; for HTTP APIs, it's a `fetcher`.
2. **The input schema is Zod.** `z.string().min(1)` rather than `z.string()` so empty strings fail validation, not the upstream API. `.describe(...)` strings appear in the MCP tool metadata and are visible to agents picking tools.
3. **Errors return a shaped response.** `toolError(message)` and `toolJson(value)` are the two helpers from `src/server.ts`. They produce the `{ content, structuredContent, isError? }` shape the MCP SDK expects.

---

## 3. Wrapping external commands

The two common shapes:

### HTTP API (like our weather adapter)

```ts
async function fetchJson(url: string, fetcher: typeof fetch): Promise<unknown> {
  const res = await fetcher(url);
  if (!res.ok) {
    throw new WeatherApiError(`HTTP ${res.status}: ${await res.text()}`, res.status);
  }
  return res.json();
}

class WeatherApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}
```

Wrap every outbound call. Catch in the tool handler and convert to `toolError`. Don't let raw `fetch` rejections escape the handler — the MCP error gets less useful the further from the call site you handle it.

### CLI subprocess (like the GitHub adapter)

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileP = promisify(execFile);

async function runMyCli(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileP('my-cli', args, {
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30_000,
    });
    return stdout;
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string };
    throw new MyCliError(`my-cli ${args.join(' ')} failed: ${e.stderr ?? e.message}`);
  }
}
```

Always set `maxBuffer` (default 1 MiB is too small for diffs) and `timeout` (so the tool doesn't hang the MCP session indefinitely). See `ghExec` in `src/adapters/github.ts` for the canonical version.

---

## 4. Tool cards (spec 41 Wave B preview)

Wave B of spec 41 introduces a `ToolCard` sidecar for every registered tool. The shape:

```ts
interface ToolCard {
  tier: 'auto' | 'confirm' | 'never';
  idempotent: boolean;
  side_effects: ('reads_db' | 'writes_db' | 'reads_github' | 'writes_github' | 'reads_fs' | 'writes_fs' | 'spawns_process' | 'network')[];
  typical_latency_class: 'ms' | 's' | 'min';
  failure_modes: string[];
  preconditions: string[];
  postconditions: string[];
  example_args?: Record<string, unknown>;
}
```

In Wave A this is **described conceptually only** — the helper `registerToolWithCard` and the runtime registry land in Wave B. For now, plan your tool's card in a comment at the registration site, and Wave B will wire it up.

A complete card for the weather adapter:

```ts
// TOOL CARD (planned, spec 41 Wave B):
// tier: 'auto', idempotent: true, side_effects: ['network'], latency: 's',
// failure_modes: ['OPENWEATHER_API_KEY missing', 'city not found', 'upstream 5xx'],
// preconditions: ['OPENWEATHER_API_KEY in env'],
// postconditions: ['no state change; result reflects upstream at time of call'],
// example_args: { city: 'Stockholm', units: 'metric' }
```

---

## 5. Registering with the server

Once the adapter file exists in `src/adapters/<name>.ts`, wire it into `src/server.ts`:

```ts
import { registerWeatherTools } from './adapters/weather.js';

export function createSwitchServer(broker: Broker): SwitchServerHandle {
  // ... existing code ...
  registerWeatherTools(server);
}
```

That's the entire wiring step. Adapters are not configurable per-MCP-session today; they're either compiled in or they're not. If you need optional registration (e.g. only register when an env var is set), do that check inside `registerWeatherTools` and return early without calling `server.registerTool`.

---

## 6. Testing pattern

`tests/<name>-adapter.test.ts`, mirroring `tests/github-adapter.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerWeatherTools } from '../examples/weather/weather-adapter.js';

describe('weather adapter', () => {
  it('returns parsed weather on success', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({ main: { temp: 12 }, weather: [{ description: 'cloudy' }] })),
    );

    registerWeatherTools(server, { fetcher, apiKey: 'test-key' });

    const tool = (server as any)._registeredTools.get('weather.current');
    const result = await tool.callback({ city: 'Stockholm', units: 'metric' });

    expect(fetcher).toHaveBeenCalledOnce();
    expect(result.structuredContent).toMatchObject({ temp: 12, conditions: 'cloudy' });
  });

  it('errors when the API key is missing', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    registerWeatherTools(server, { fetcher: vi.fn(), apiKey: undefined });

    const tool = (server as any)._registeredTools.get('weather.current');
    const result = await tool.callback({ city: 'Stockholm', units: 'metric' });

    expect(result.isError).toBe(true);
  });
});
```

Patterns to keep:

- **One file per adapter.** Tests for `weather` go in `tests/weather-adapter.test.ts`.
- **Mock the seam, not the SDK.** Stub `fetcher`/`exec`, not the MCP server.
- **Assert on `structuredContent`** for happy paths and `isError` for failures.
- **No live network.** If a test needs HTTP, the test is wrong — pass a `fetcher` stub.

---

## 7. README update

When adding an adapter:

- Add a short section to the README under the "Tools registered" / "GitHub adapter" area: what it does, what credentials it needs, which tools it exposes.
- If the adapter requires environment setup (e.g. an API key), document the env var.

This is the only doc surface a user sees. They will not read your code; they will read the README.

---

## Full worked example: the weather adapter

See [`examples/weather/`](../examples/weather/) for a runnable example:

- [`weather-adapter.ts`](../examples/weather/weather-adapter.ts) — 80–120 lines, fully commented, demonstrates every piece described above.
- [`weather-adapter.test.ts`](../examples/weather/weather-adapter.test.ts) — vitest spec using the mocked-`fetcher` pattern.
- [`README.md`](../examples/weather/README.md) — what the example does, how to wire it in.

The example is **not** registered in `src/server.ts`. It exists purely as reference code; copy it to `src/adapters/weather.ts` and add the import to wire it in for real.

You can verify the example compiles standalone:

```bash
npx tsc --noEmit examples/weather/weather-adapter.ts
```

---

## Checklist

Before opening a PR for a new adapter:

- [ ] File at `src/adapters/<name>.ts` exports `registerXxxTools(server, opts?)`.
- [ ] Every tool has a Zod input schema with descriptive `.describe(...)` strings.
- [ ] External calls are wrapped with timeout + error normalization.
- [ ] There is a test seam in `opts` (an injectable runner/fetcher).
- [ ] Tool card is planned in a comment (Wave B will wire it up).
- [ ] Adapter is registered in `src/server.ts`.
- [ ] Test file mirrors `tests/github-adapter.test.ts` patterns.
- [ ] `npm test` passes; `npm run typecheck` clean.
- [ ] README has a one-paragraph section describing the adapter and any env it needs.
