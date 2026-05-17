// v0.5 P4 — Scheduled dispatcher.
//
// Minute-granularity cron expression evaluator. Per ADR-032 §Decision 4 + the
// v0.4 scheduler BOM: cron syntax `m h dom mon dow` (* / list / range / step).
// Daily self-critique runs at `0 3 * * *` per ADR-032 §Decision 7; that exact
// cadence is the default cronExpr.
//
// Capacity + dedupe sit on the AGENT loop side (loop.ts), not here. This
// module's only job is to fire ticks when the wall clock matches the cron
// expression and forward the matched timestamp to the caller.

export interface ScheduledDispatcher {
  /** For tests: evaluate cron against an explicit now-time and fire if it matches. */
  tickNow(now?: Date): boolean;
  stop(): void;
}

export interface ScheduledOpts {
  /** Default `0 3 * * *` — daily self-critique at 03:00 local time. */
  cronExpr?: string;
  onTick: (reason: string) => void;
  /** Override for tests — when set, internal timer doesn't run. */
  manualMode?: boolean;
  /** Poll interval in ms. Default 60_000 (once a minute). */
  pollIntervalMs?: number;
}

const DEFAULT_CRON = '0 3 * * *';

interface ParsedCron {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
}

export function parseCron(expr: string): ParsedCron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron expression must have 5 fields, got ${parts.length}: ${expr}`);
  const [m, h, dom, mon, dow] = parts;
  return {
    minute: parseField(m, 0, 59),
    hour: parseField(h, 0, 23),
    dayOfMonth: parseField(dom, 1, 31),
    month: parseField(mon, 1, 12),
    dayOfWeek: parseField(dow, 0, 6),
  };
}

function parseField(field: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    let stepMatch = part.match(/^(.*?)\/(\d+)$/);
    const step = stepMatch ? Number(stepMatch[2]) : 1;
    const rangePart = stepMatch ? stepMatch[1] : part;
    let lo = min;
    let hi = max;
    if (rangePart === '*' || rangePart === '') {
      // keep min..max
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-').map(Number);
      lo = a; hi = b;
    } else {
      const v = Number(rangePart);
      if (Number.isNaN(v)) throw new Error(`invalid cron token: ${part}`);
      lo = v; hi = v;
    }
    for (let i = lo; i <= hi; i += step) {
      if (i < min || i > max) continue;
      out.add(i);
    }
  }
  return out;
}

export function matches(parsed: ParsedCron, when: Date): boolean {
  return (
    parsed.minute.has(when.getMinutes()) &&
    parsed.hour.has(when.getHours()) &&
    parsed.dayOfMonth.has(when.getDate()) &&
    parsed.month.has(when.getMonth() + 1) &&
    parsed.dayOfWeek.has(when.getDay())
  );
}

export function startScheduledDispatcher(opts: ScheduledOpts): ScheduledDispatcher {
  const cronExpr = opts.cronExpr ?? DEFAULT_CRON;
  const parsed = parseCron(cronExpr);
  const pollMs = opts.pollIntervalMs ?? 60_000;
  let lastTickMinute = -1;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  function tickNow(now: Date = new Date()): boolean {
    if (stopped) return false;
    // Dedupe within the same minute — multiple polls inside one minute should
    // fire at most one onTick callback.
    const key = now.getHours() * 60 + now.getMinutes();
    if (key === lastTickMinute) return false;
    if (matches(parsed, now)) {
      lastTickMinute = key;
      opts.onTick(`cron:${cronExpr}`);
      return true;
    }
    return false;
  }

  if (!opts.manualMode) {
    timer = setInterval(() => {
      try { tickNow(); } catch { /* swallow */ }
    }, pollMs);
    timer.unref?.();
  }

  return {
    tickNow,
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
    },
  };
}
