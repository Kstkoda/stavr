// Reference adapter — see docs/writing-an-adapter.md.
// Demonstrates the standard adapter shape with HTTP backing.
// Not registered in src/server.ts; copy to src/adapters/weather.ts to wire it in.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

// WHY: we import the helpers via relative path from src/ when this file lives in
// src/adapters/. From examples/weather/ the path is one extra "../" — adjust on copy.
import { toolError, toolJson } from '../../src/server.js';

const REQUEST_TIMEOUT_MS = 10_000;

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface RegisterWeatherToolsOptions {
  // SIDE-EFFECT seam: tests inject a stub instead of letting the adapter hit the real network.
  fetcher?: Fetcher;
  apiKey?: string;
}

class WeatherApiError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

async function fetchJson(url: string, fetcher: Fetcher): Promise<unknown> {
  // CONTRACT: throws WeatherApiError on any non-2xx; never resolves on a non-2xx.
  // FAILURE-MODE: network failure surfaces as a TypeError from fetch; we wrap it.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetcher(url, { signal: ctrl.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new WeatherApiError(`HTTP ${res.status}: ${body.slice(0, 200)}`, res.status);
    }
    return await res.json();
  } catch (err) {
    if (err instanceof WeatherApiError) throw err;
    throw new WeatherApiError(`weather request failed: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

// TOOL CARD (planned, spec 41 Wave B):
//   tier: 'auto', idempotent: true, side_effects: ['network'],
//   typical_latency_class: 's',
//   failure_modes: ['OPENWEATHER_API_KEY missing', 'city not found', 'upstream 5xx', 'timeout'],
//   preconditions: ['OPENWEATHER_API_KEY in env'],
//   postconditions: ['no state change; result reflects upstream at time of call'],
//   example_args: { city: 'Stockholm', units: 'metric' }
export function registerWeatherTools(
  server: McpServer,
  opts: RegisterWeatherToolsOptions = {},
): void {
  const fetcher: Fetcher = opts.fetcher ?? (globalThis.fetch as Fetcher);
  const apiKey = opts.apiKey ?? process.env['OPENWEATHER_API_KEY'];

  server.registerTool(
    'weather.current',
    {
      description:
        'Get current weather for a city. Returns temperature, conditions, humidity. Read-only; no state change.',
      inputSchema: {
        city: z.string().min(1).describe('City name, e.g. "Stockholm" or "Stockholm,SE"'),
        units: z
          .enum(['metric', 'imperial'])
          .optional()
          .default('metric')
          .describe('Temperature units; defaults to metric (Celsius).'),
      },
    },
    async ({ city, units }) => {
      if (!apiKey) {
        return toolError('weather adapter requires OPENWEATHER_API_KEY in the environment');
      }
      const url =
        `https://api.openweathermap.org/data/2.5/weather` +
        `?q=${encodeURIComponent(city)}` +
        `&units=${units}` +
        `&appid=${apiKey}`;
      try {
        const raw = (await fetchJson(url, fetcher)) as {
          main?: { temp?: number; humidity?: number };
          weather?: Array<{ description?: string }>;
          name?: string;
        };
        return toolJson({
          city: raw.name ?? city,
          temp: raw.main?.temp,
          humidity: raw.main?.humidity,
          conditions: raw.weather?.[0]?.description,
          units,
        });
      } catch (err) {
        if (err instanceof WeatherApiError && err.status === 404) {
          return toolError(`city not found: ${city}`);
        }
        return toolError((err as Error).message);
      }
    },
  );
}

export const WEATHER_TOOL_NAMES = ['weather.current'] as const;
