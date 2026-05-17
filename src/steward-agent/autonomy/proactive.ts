// v0.5 P4 — Proactive dispatcher.
//
// Steward proposes BOMs from observed patterns + active lessons. Hard guards
// per ADR-032 §Decision 4:
//   1. Daily cost cap from prefs.cost_cap_daily_usd (default $2.00 — see
//      Open Question §3 — lower-risk path chosen)
//   2. Per-pattern dedupe inside a 24h window (in-memory; intentional —
//      a process restart clears dedupe, which biases toward propose-more
//      rather than suppress-too-much)
//   3. Trust scope enforcement is the daemon's job (rule §6 / §Decision 9);
//      this dispatcher just emits proposals, daemon refuses out-of-scope ones
//
// Cost ledger key in memory: `proactive:cost:<YYYY-MM-DD>` → number. Updated
// by callers via recordSpend() after each proactive BOM's cost lands.

import type { MemoryStore, PrefsStore } from '../db/types.js';
import { PREF_KEYS } from '../db/types.js';
import { getLogger } from '../../log.js';

export interface ProactiveDispatcher {
  /** Returns true if a proposal would be allowed right now under the cap. */
  canPropose(): boolean;
  /** Record observed spend so the cap is enforced; caller passes USD. */
  recordSpend(usd: number, now?: Date): void;
  /** Returns true if pattern hasn't fired inside the dedupe window. */
  shouldFire(pattern: string, now?: Date): boolean;
  /** Mark a pattern as fired so subsequent shouldFire() returns false. */
  markFired(pattern: string, now?: Date): void;
  /** Active spend total for the current local day. */
  spendToday(now?: Date): number;
  stop(): void;
}

export interface ProactiveOpts {
  memory: MemoryStore;
  prefs: PrefsStore;
  onPropose: (reason: string) => void;
  /** Dedupe window in ms. Default 24h. */
  patternDedupeMs?: number;
}

function dayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function spendStateKey(d: Date): string {
  return `proactive:cost:${dayKey(d)}`;
}

export function startProactiveDispatcher(opts: ProactiveOpts): ProactiveDispatcher {
  const dedupeMs = opts.patternDedupeMs ?? 24 * 3600 * 1000;
  const log = getLogger();
  // In-memory pattern dedupe; intentional per the header comment.
  const lastFiredByPattern = new Map<string, number>();
  let stopped = false;

  function getCapUsd(): number {
    return opts.prefs.getOrDefault<number>(PREF_KEYS.COST_CAP_DAILY_USD);
  }

  function spendToday(now: Date = new Date()): number {
    const raw = opts.memory.getWorking(spendStateKey(now));
    return typeof raw === 'number' ? raw : 0;
  }

  function recordSpend(usd: number, now: Date = new Date()): void {
    if (usd <= 0) return;
    const cur = spendToday(now);
    opts.memory.setWorking(spendStateKey(now), cur + usd);
  }

  function canPropose(): boolean {
    if (stopped) return false;
    return spendToday() < getCapUsd();
  }

  function shouldFire(pattern: string, now: Date = new Date()): boolean {
    if (stopped) return false;
    const last = lastFiredByPattern.get(pattern);
    if (last === undefined) return true;
    return now.getTime() - last >= dedupeMs;
  }

  function markFired(pattern: string, now: Date = new Date()): void {
    lastFiredByPattern.set(pattern, now.getTime());
  }

  function proposeIfAllowed(pattern: string, reason: string): boolean {
    if (!shouldFire(pattern)) return false;
    if (!canPropose()) {
      log.info('proactive proposal blocked by daily cost cap', {
        pattern,
        cap_usd: getCapUsd(),
        spend_today_usd: spendToday(),
      });
      return false;
    }
    markFired(pattern);
    opts.onPropose(reason);
    return true;
  }

  // We intentionally don't auto-fire here — the agent loop drives proactive
  // proposals via its own pattern-observation pipeline (v0.6). For P4 we
  // ship the gate primitives; callers compose them.
  // Expose proposeIfAllowed via a closure for callers that prefer the
  // higher-level API; below we surface the lower-level API to keep tests
  // direct.
  return {
    canPropose,
    recordSpend,
    shouldFire,
    markFired,
    spendToday,
    stop() {
      stopped = true;
    },
  };
}
