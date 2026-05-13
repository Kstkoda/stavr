import type { EventStore, StoredEvent } from './persistence.js';

/**
 * Spec 50 Layer 1 — usage aggregator.
 *
 * Reads the event log for cost-bearing events and rolls them into the
 * widget/CLI response shape. Today's events come from two sources:
 *
 *   1. `worker_progress` events whose payload is stream-json `result` with
 *      usage fields (today's CC worker output).
 *   2. `steward_usage` events emitted by the daemon-hosted Steward (spec 49).
 *
 * Both sources land in the same totals/by_model/by_credential rollup. New
 * sources can be added by extending `extractUsageFromEvent`.
 */

export interface UsageBucket {
  at: string;
  cost_usd: number;
  events: number;
}

export interface UsageRecent {
  at: string;
  source: string;
  model: string;
  credential: string;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
}

export interface UsageReport {
  as_of: string;
  window: string;
  granularity: string;
  totals: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    cost_usd: number;
    events: number;
  };
  by_credential: Record<string, { cost_usd: number; events: number }>;
  by_model: Record<
    string,
    { cost_usd: number; input_tokens: number; output_tokens: number; events: number }
  >;
  buckets: UsageBucket[];
  burn_rate: {
    last_15_min_usd: number;
    projected_daily_usd: number;
    projected_weekly_usd: number;
    projected_monthly_usd: number;
  };
  api_balance: { estimated_usd: number | null; as_of: string | null; source: string };
  max_session: { status: 'active' | 'throttled' | 'unknown'; last_throttle_at: string | null };
  recent: UsageRecent[];
}

export interface ComputeUsageOpts {
  window?: '1h' | '6h' | '24h' | '7d';
  granularity?: 'minute' | 'hour' | 'day';
  /** Now-ish; tests inject. */
  now?: Date;
  apiBalance?: UsageReport['api_balance'];
}

interface ExtractedUsage {
  at: string;
  model: string;
  credential: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cost_usd: number;
  source: string;
}

const WINDOW_MS: Record<NonNullable<ComputeUsageOpts['window']>, number> = {
  '1h': 60 * 60_000,
  '6h': 6 * 60 * 60_000,
  '24h': 24 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000,
};

export function computeUsage(store: EventStore, opts: ComputeUsageOpts = {}): UsageReport {
  const now = opts.now ?? new Date();
  const window = opts.window ?? '24h';
  const granularity = opts.granularity ?? 'hour';
  const windowMs = WINDOW_MS[window];
  const cutoff = new Date(now.getTime() - windowMs).toISOString();

  const events = collectUsageEvents(store, cutoff);

  const totals = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    cost_usd: 0,
    events: 0,
  };
  const byCredential: UsageReport['by_credential'] = {};
  const byModel: UsageReport['by_model'] = {};
  const bucketsMap = new Map<string, UsageBucket>();
  for (const e of events) {
    totals.input_tokens += e.input_tokens;
    totals.output_tokens += e.output_tokens;
    totals.cache_creation_input_tokens += e.cache_creation_input_tokens ?? 0;
    totals.cache_read_input_tokens += e.cache_read_input_tokens ?? 0;
    totals.cost_usd += e.cost_usd;
    totals.events += 1;

    const cred = byCredential[e.credential] ?? { cost_usd: 0, events: 0 };
    cred.cost_usd += e.cost_usd;
    cred.events += 1;
    byCredential[e.credential] = cred;

    const mod = byModel[e.model] ?? { cost_usd: 0, input_tokens: 0, output_tokens: 0, events: 0 };
    mod.cost_usd += e.cost_usd;
    mod.input_tokens += e.input_tokens;
    mod.output_tokens += e.output_tokens;
    mod.events += 1;
    byModel[e.model] = mod;

    const bucketKey = bucketKeyFor(e.at, granularity);
    const bucket = bucketsMap.get(bucketKey) ?? { at: bucketKey, cost_usd: 0, events: 0 };
    bucket.cost_usd += e.cost_usd;
    bucket.events += 1;
    bucketsMap.set(bucketKey, bucket);
  }

  // 15-minute burn rate from the most-recent slice of events.
  const fifteenMinCutoff = new Date(now.getTime() - 15 * 60_000).toISOString();
  const last15Min = events.filter((e) => e.at >= fifteenMinCutoff).reduce((s, e) => s + e.cost_usd, 0);
  const ratePerHour = last15Min * 4;
  const burn_rate = {
    last_15_min_usd: round(last15Min, 4),
    projected_daily_usd: round(ratePerHour * 24, 4),
    projected_weekly_usd: round(ratePerHour * 24 * 7, 4),
    projected_monthly_usd: round(ratePerHour * 24 * 30, 4),
  };

  const recent: UsageRecent[] = events
    .slice()
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 10)
    .map((e) => ({
      at: e.at,
      source: e.source,
      model: e.model,
      credential: e.credential,
      cost_usd: round(e.cost_usd, 4),
      input_tokens: e.input_tokens,
      output_tokens: e.output_tokens,
    }));

  return {
    as_of: now.toISOString(),
    window,
    granularity,
    totals: {
      input_tokens: totals.input_tokens,
      output_tokens: totals.output_tokens,
      cache_creation_input_tokens: totals.cache_creation_input_tokens,
      cache_read_input_tokens: totals.cache_read_input_tokens,
      cost_usd: round(totals.cost_usd, 4),
      events: totals.events,
    },
    by_credential: byCredential,
    by_model: byModel,
    buckets: Array.from(bucketsMap.values()).sort((a, b) => a.at.localeCompare(b.at)),
    burn_rate,
    api_balance: opts.apiBalance ?? { estimated_usd: null, as_of: null, source: 'unavailable' },
    max_session: { status: 'unknown', last_throttle_at: null },
    recent,
  };
}

function collectUsageEvents(store: EventStore, cutoffIso: string): ExtractedUsage[] {
  // Pull both streams in chunks; cap at 5000 each.
  const stewardEvents = store.getEvents({ kinds: ['steward_usage'], limit: 5000 }).events.filter(
    (e) => e.at >= cutoffIso,
  );
  const workerEvents = store.getEvents({ kinds: ['worker_progress'], limit: 5000 }).events.filter(
    (e) => e.at >= cutoffIso,
  );
  const out: ExtractedUsage[] = [];
  for (const e of [...stewardEvents, ...workerEvents]) {
    const x = extractUsageFromEvent(e);
    if (x) out.push(x);
  }
  return out;
}

export function extractUsageFromEvent(ev: StoredEvent): ExtractedUsage | undefined {
  // String-compare against the event kind so this module works whether or
  // not the spec-49 'steward_usage' kind is in the enum at compile time
  // (chunk 5 adds it; this chunk's PR is independent of that one).
  const kindStr = ev.kind as string;
  if (kindStr === 'steward_usage') {
    const p = ev.payload as {
      provider?: string;
      model?: string;
      input_tokens?: number;
      output_tokens?: number;
      cache_read_tokens?: number;
      cache_creation_tokens?: number;
      cost_usd?: number;
      credential_id?: string;
    };
    return {
      at: ev.at,
      model: p.model ?? 'unknown',
      credential: p.credential_id ?? p.provider ?? 'unknown',
      input_tokens: p.input_tokens ?? 0,
      output_tokens: p.output_tokens ?? 0,
      cache_creation_input_tokens: p.cache_creation_tokens,
      cache_read_input_tokens: p.cache_read_tokens,
      cost_usd: p.cost_usd ?? 0,
      source: `steward:${p.provider ?? 'unknown'}`,
    };
  }
  if (kindStr === 'worker_progress') {
    const p = ev.payload as {
      payload?: { format?: string; event?: { type?: string; usage?: Record<string, number>; cost_usd?: number; model?: string } };
      id?: string;
    };
    const inner = p.payload;
    if (inner?.format !== 'stream-json' || inner.event?.type !== 'result') return undefined;
    const usage = inner.event.usage ?? {};
    return {
      at: ev.at,
      model: inner.event.model ?? 'unknown',
      credential: 'worker',
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens,
      cache_read_input_tokens: usage.cache_read_input_tokens,
      cost_usd: inner.event.cost_usd ?? 0,
      source: `worker:${p.id ?? 'unknown'}`,
    };
  }
  return undefined;
}

function bucketKeyFor(iso: string, granularity: 'minute' | 'hour' | 'day'): string {
  const d = new Date(iso);
  if (granularity === 'day') return d.toISOString().slice(0, 10) + 'T00:00:00Z';
  if (granularity === 'hour') return d.toISOString().slice(0, 13) + ':00:00Z';
  return d.toISOString().slice(0, 16) + ':00Z';
}

function round(n: number, p: number): number {
  const k = 10 ** p;
  return Math.round(n * k) / k;
}

// ---- Anthropic admin API (spec 50 Layer 2 helper) ---------------------------

interface AdminBalanceCache {
  fetchedAt: number;
  result: UsageReport['api_balance'];
}
let cachedBalance: AdminBalanceCache | undefined;

/**
 * Best-effort: if ANTHROPIC_ADMIN_API_KEY is set, fetch the org's credit
 * balance (5-minute cache). Returns null + source='unavailable' otherwise.
 * The exact admin endpoint changes over time; we fail gracefully on any
 * non-2xx so the rest of the response still ships.
 */
export async function fetchAnthropicBalance(opts: {
  fetchImpl?: typeof fetch;
  envKey?: string;
} = {}): Promise<UsageReport['api_balance']> {
  const adminKey = opts.envKey ?? process.env.ANTHROPIC_ADMIN_API_KEY;
  if (!adminKey) return { estimated_usd: null, as_of: null, source: 'unavailable' };
  if (cachedBalance && Date.now() - cachedBalance.fetchedAt < 5 * 60_000) {
    return cachedBalance.result;
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl('https://api.anthropic.com/v1/organizations/credits', {
      headers: { 'x-api-key': adminKey, 'anthropic-version': '2023-06-01' },
    });
    if (!res.ok) {
      const result: UsageReport['api_balance'] = {
        estimated_usd: null,
        as_of: null,
        source: 'unavailable',
      };
      cachedBalance = { fetchedAt: Date.now(), result };
      return result;
    }
    const body = (await res.json()) as { balance_usd?: number };
    const result: UsageReport['api_balance'] = {
      estimated_usd: body.balance_usd ?? null,
      as_of: new Date().toISOString(),
      source: 'anthropic_admin_api',
    };
    cachedBalance = { fetchedAt: Date.now(), result };
    return result;
  } catch {
    const result: UsageReport['api_balance'] = {
      estimated_usd: null,
      as_of: null,
      source: 'unavailable',
    };
    cachedBalance = { fetchedAt: Date.now(), result };
    return result;
  }
}

export function _resetAdminBalanceCache(): void {
  cachedBalance = undefined;
}
