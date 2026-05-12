// Reference test for the weather adapter — see docs/writing-an-adapter.md §6.
// Not run as part of `npm test` until the adapter is moved to src/adapters/.

import { describe, it, expect, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerWeatherTools } from './weather-adapter.js';

// Helper: dig out the registered tool's handler. The MCP SDK doesn't expose a
// public accessor in v1.29, so we reach into the private map. This mirrors the
// pattern used in tests/github-adapter.test.ts.
function getToolHandler(server: McpServer, name: string): (args: unknown) => Promise<unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools = (server as any)._registeredTools as Map<string, { callback: (a: unknown) => Promise<unknown> }>;
  const t = tools.get(name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t.callback;
}

describe('weather adapter', () => {
  it('returns parsed weather on success', async () => {
    const fetcher = vi.fn(async () =>
      new Response(
        JSON.stringify({
          main: { temp: 12, humidity: 80 },
          weather: [{ description: 'cloudy' }],
          name: 'Stockholm',
        }),
        { status: 200 },
      ),
    );

    const server = new McpServer({ name: 'test', version: '0.0.0' });
    registerWeatherTools(server, { fetcher, apiKey: 'test-key' });

    const result = (await getToolHandler(server, 'weather.current')({
      city: 'Stockholm',
      units: 'metric',
    })) as { structuredContent?: { temp?: number; conditions?: string } };

    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[0]).toContain('q=Stockholm');
    expect(result.structuredContent).toMatchObject({ temp: 12, conditions: 'cloudy' });
  });

  it('errors when the API key is missing', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    registerWeatherTools(server, { fetcher: vi.fn(), apiKey: undefined });

    const result = (await getToolHandler(server, 'weather.current')({
      city: 'Stockholm',
      units: 'metric',
    })) as { isError?: boolean };

    expect(result.isError).toBe(true);
  });

  it('maps a 404 to "city not found"', async () => {
    const fetcher = vi.fn(async () => new Response('not found', { status: 404 }));

    const server = new McpServer({ name: 'test', version: '0.0.0' });
    registerWeatherTools(server, { fetcher, apiKey: 'test-key' });

    const result = (await getToolHandler(server, 'weather.current')({
      city: 'NoSuchCity',
      units: 'metric',
    })) as { isError?: boolean; content?: Array<{ text?: string }> };

    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toContain('city not found');
  });
});
