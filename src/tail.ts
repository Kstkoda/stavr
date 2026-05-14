import type { StoredEvent } from './persistence.js';

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const RESET_AFTER_CLEAN_MS = 30_000;
const GIVE_UP_AFTER_MS = 60 * 60_000;

export interface TailOptions {
  /** Base daemon URL, e.g. http://127.0.0.1:7777 */
  url: string;
  /** Show events since this duration (e.g. "5m", "1h", "30s"). */
  since?: string;
  /** Show events since this event ID. */
  sinceId?: string;
  /** Comma-separated event kinds to include. Omit or use ["*"] for all. */
  kinds?: string[];
  /** Client-side filter: only show events where payload.worker_name or payload.name matches. */
  worker?: string;
  /** Server-side filter: only events with this source_agent. */
  sourceAgent?: string;
  noColor?: boolean;
  json?: boolean;
  signal?: AbortSignal;
  /** Test seam: override initial backoff. */
  initialBackoffMs?: number;
  /** Test seam: override max backoff. */
  maxBackoffMs?: number;
  /** Test seam: override give-up window. */
  giveUpAfterMs?: number;
}

// ---- Duration parser ----

function parseDurationMs(dur: string): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(dur.trim());
  if (!m) throw new Error(`Cannot parse duration: "${dur}". Expected format like 5m, 1h, 30s`);
  const n = parseFloat(m[1]);
  switch (m[2]) {
    case 'ms': return n;
    case 's': return n * 1_000;
    case 'm': return n * 60_000;
    case 'h': return n * 3_600_000;
    default: throw new Error(`Unknown unit: ${m[2]}`);
  }
}

function buildSseUrl(opts: TailOptions): string {
  const base = opts.url.replace(/\/$/, '');
  const params = new URLSearchParams();

  if (opts.sinceId) {
    params.set('since_id', opts.sinceId);
  } else if (opts.since) {
    const ms = parseDurationMs(opts.since);
    params.set('since_at', new Date(Date.now() - ms).toISOString());
  }

  if (opts.kinds?.length && !opts.kinds.includes('*')) {
    params.set('kind', opts.kinds.join(','));
  }
  if (opts.sourceAgent) {
    params.set('source_agent', opts.sourceAgent);
  }

  const qs = params.toString();
  return `${base}/events/sse${qs ? '?' + qs : ''}`;
}

// ---- Formatting ----

const ESC = '\x1b';
const C: Record<string, string> = {
  reset: `${ESC}[0m`,
  cyan: `${ESC}[36m`,
  yellowBold: `${ESC}[1;33m`,
  dimYellow: `${ESC}[2;33m`,
  magenta: `${ESC}[35m`,
  green: `${ESC}[32m`,
  redBold: `${ESC}[1;31m`,
  dim: `${ESC}[2m`,
};

function colorFor(kind: string, payload: unknown): { open: string; close: string } {
  const none = { open: '', close: '' };
  const wrap = (open: string) => ({ open, close: C.reset });
  if (kind === 'decision_request') return wrap(C.yellowBold);
  if (kind === 'decision_response' || kind === 'decision_late_response') return wrap(C.dimYellow);
  if (kind.startsWith('trust_scope_')) return wrap(C.magenta);
  if (kind === 'error' || kind === 'worker_stuck') return wrap(C.redBold);
  if (kind === 'progress') return wrap(C.dim);
  if (kind === 'worker_log') {
    const stream = (payload as Record<string, unknown>)?.stream;
    return stream === 'stderr' ? wrap(C.dim) : wrap(C.cyan);
  }
  if (kind.startsWith('worker_')) return wrap(C.green);
  return none;
}

function truncate(s: string, max = 200): string {
  return s.length <= max ? s : s.slice(0, max) + '…';
}

function summarize(kind: string, payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const p = payload as Record<string, unknown>;
  switch (kind) {
    case 'progress': return String(p.message ?? '');
    case 'worker_progress': return String(p.message ?? '');
    case 'worker_log': {
      const raw = String(p.line ?? '');
      return truncate(p.format === 'stream-json' ? `[json] ${raw}` : raw);
    }
    case 'decision_request': return String(p.question ?? '');
    case 'decision_response': return `chosen: ${p.chosen_option_id}`;
    case 'decision_late_response': return `late: ${p.chosen_option_id}`;
    case 'worker_spawned': return `${p.name} (${p.type})`;
    case 'worker_terminated': return `${p.id ?? p.name} → ${p.reason}`;
    case 'worker_stuck': return String(p.hint ?? '');
    case 'error': return String(p.message ?? '');
    case 'trust_scope_proposed': return `${p.scope_id}: ${p.title}`;
    case 'trust_scope_granted': return `${p.scope_id} granted by ${p.granted_by}`;
    case 'trust_scope_revoked': return `${p.scope_id} revoked by ${p.revoked_by}`;
    default: return truncate(JSON.stringify(payload));
  }
}

function formatEvent(ev: StoredEvent, noColor: boolean, json: boolean): string {
  if (json) return JSON.stringify(ev);

  // HH:MM:SSZ
  const time = ev.at.slice(11, 19) + 'Z';
  const summary = summarize(ev.kind, ev.payload);
  const corr = ev.correlation_id ? `[${ev.correlation_id.slice(0, 8)}]` : '';

  const parts = [time.padEnd(9), ev.kind.padEnd(30), ev.source_agent];
  if (summary) parts.push(summary);
  if (corr) parts.push(corr);
  const line = parts.join('  ');

  if (noColor) return line;
  const col = colorFor(ev.kind, ev.payload);
  return col.open ? `${col.open}${line}${col.close}` : line;
}

// ---- SSE reader ----

async function streamSse(
  url: string,
  onEvent: (data: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  if (!res.body) throw new Error('Response has no body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let dataAccum = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop()!;
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          dataAccum += line.slice(6);
        } else if (line === '' && dataAccum) {
          onEvent(dataAccum);
          dataAccum = '';
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

// ---- Main entry point ----

export async function runTail(opts: TailOptions, onLine: (line: string) => void): Promise<void> {
  const initialBackoffMs = opts.initialBackoffMs ?? INITIAL_BACKOFF_MS;
  const maxBackoffMs = opts.maxBackoffMs ?? MAX_BACKOFF_MS;
  const giveUpAfterMs = opts.giveUpAfterMs ?? GIVE_UP_AFTER_MS;

  const ac = new AbortController();
  const signal = opts.signal ?? ac.signal;

  const sseUrl = buildSseUrl(opts);

  let backoffMs = initialBackoffMs;
  let consecutiveErrors = 0;
  let firstFailureAt: number | null = null;
  let lastSuccessAt = Date.now();
  let lastErrorAt = 0;

  const onData = (data: string): void => {
    try {
      const ev = JSON.parse(data) as StoredEvent;
      // Client-side worker filter
      if (opts.worker) {
        const p = ev.payload as Record<string, unknown>;
        if (p?.worker_name !== opts.worker && p?.name !== opts.worker) return;
      }
      onLine(formatEvent(ev, opts.noColor ?? false, opts.json ?? false));
    } catch {
      // skip malformed SSE data frames
    }
  };

  while (!signal.aborted) {
    const now = Date.now();
    // Reset window: clean stretch resets backoff
    if (
      consecutiveErrors > 0 &&
      now - lastErrorAt > RESET_AFTER_CLEAN_MS &&
      now - lastSuccessAt > RESET_AFTER_CLEAN_MS
    ) {
      consecutiveErrors = 0;
      backoffMs = initialBackoffMs;
      firstFailureAt = null;
    }

    try {
      await streamSse(sseUrl, onData, signal);
      lastSuccessAt = Date.now();
      break; // stream ended normally
    } catch (err) {
      if (signal.aborted) break;

      const errNow = Date.now();
      if (firstFailureAt === null) firstFailureAt = errNow;
      consecutiveErrors++;
      lastErrorAt = errNow;

      if (errNow - firstFailureAt > giveUpAfterMs) {
        throw new Error(`stavr tail: giving up after ${giveUpAfterMs}ms without a successful connection`);
      }

      // Backoff wait (honours abort)
      const delay = backoffMs;
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, delay);
        signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
      });
    }
  }
}
