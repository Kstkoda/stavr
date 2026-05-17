// v0.5 P4 — Autonomy mode selector + barrel.
//
// ADR-032 §Decision 4: three autonomy levels persisted in prefs.db. The mode
// shapes WHEN Steward thinks (reactive=on event, scheduled=on cron tick,
// proactive=on observed pattern), never WHAT it does — the actual planning
// stays in the runtime (P2). The user-approval gate is unchanged: Steward
// proposes, daemon dispatches, user approves via Decision card.

import type { PrefsStore, MemoryStore } from '../db/types.js';
import { PREF_KEYS } from '../db/types.js';
import { startReactiveDispatcher, type ReactiveDispatcher } from './reactive.js';
import { startScheduledDispatcher, type ScheduledDispatcher } from './scheduled.js';
import { startProactiveDispatcher, type ProactiveDispatcher, type ProactiveOpts } from './proactive.js';

export * from './reactive.js';
export * from './scheduled.js';
export * from './proactive.js';
export { startProbation } from './probation.js';

export type AutonomyMode = 'reactive' | 'scheduled' | 'proactive';

export function readAutonomyMode(prefs: PrefsStore): AutonomyMode {
  const raw = prefs.getOrDefault<string>(PREF_KEYS.AUTONOMY_MODE);
  if (raw === 'scheduled' || raw === 'proactive') return raw;
  return 'reactive';
}

export function writeAutonomyMode(prefs: PrefsStore, mode: AutonomyMode): void {
  prefs.set(PREF_KEYS.AUTONOMY_MODE, mode);
}

export interface AutonomyHandle {
  mode: AutonomyMode;
  reactive: ReactiveDispatcher;
  scheduled?: ScheduledDispatcher;
  proactive?: ProactiveDispatcher;
  stop(): void;
}

export interface StartAutonomyOpts {
  prefs: PrefsStore;
  memory: MemoryStore;
  /** Callback invoked when a tick fires — caller hands it off to the loop. */
  onTrigger: (source: 'reactive' | 'scheduled' | 'proactive', reason: string) => void;
  scheduledCronExpr?: string;
  proactive?: Omit<ProactiveOpts, 'memory' | 'prefs' | 'onPropose'>;
}

/**
 * Start the three dispatchers, gated by the active mode. Lower-risk path per
 * Open Question §3: scheduled + proactive ALWAYS load (enabled in code) but
 * only fire ticks when prefs.autonomy_mode selects them. Tests that pin a
 * specific mode get clean behavior; flipping prefs at runtime is a single
 * call to writeAutonomyMode().
 */
export function startAutonomy(opts: StartAutonomyOpts): AutonomyHandle {
  const mode = readAutonomyMode(opts.prefs);

  const reactive = startReactiveDispatcher({
    onWake: (reason) => opts.onTrigger('reactive', reason),
  });

  let scheduled: ScheduledDispatcher | undefined;
  let proactive: ProactiveDispatcher | undefined;

  if (mode === 'scheduled' || mode === 'proactive') {
    scheduled = startScheduledDispatcher({
      cronExpr: opts.scheduledCronExpr,
      onTick: (reason) => opts.onTrigger('scheduled', reason),
    });
  }
  if (mode === 'proactive') {
    proactive = startProactiveDispatcher({
      ...(opts.proactive ?? {}),
      memory: opts.memory,
      prefs: opts.prefs,
      onPropose: (reason) => opts.onTrigger('proactive', reason),
    });
  }

  return {
    mode,
    reactive,
    scheduled,
    proactive,
    stop() {
      reactive.stop();
      scheduled?.stop();
      proactive?.stop();
    },
  };
}
