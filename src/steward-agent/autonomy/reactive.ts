// v0.5 P4 — Reactive dispatcher.
//
// Today's behavior, factored into its own module so the three modes share a
// single trigger surface. The loop in P3 already handles incoming agent
// requests; reactive mode just exposes a `wake()` method the daemon-side
// adapter calls when an interesting event arrives (worker_step_complete,
// bom_step_done, decision_response, etc.).

export interface ReactiveDispatcher {
  /** Trigger a single reactive tick. */
  wake(reason: string): void;
  stop(): void;
}

export interface ReactiveOpts {
  /** Invoked synchronously on wake. */
  onWake: (reason: string) => void;
  /** Coalesce wakes inside this window to one trigger. Default 50ms. */
  coalesceMs?: number;
}

export function startReactiveDispatcher(opts: ReactiveOpts): ReactiveDispatcher {
  const coalesceMs = opts.coalesceMs ?? 50;
  let pending: { reason: string; timer: NodeJS.Timeout } | null = null;
  let stopped = false;

  function wake(reason: string): void {
    if (stopped) return;
    if (coalesceMs <= 0) {
      opts.onWake(reason);
      return;
    }
    if (pending) {
      // Keep the freshest reason — newer event usually carries more info.
      pending.reason = reason;
      return;
    }
    const slot = { reason, timer: null as unknown as NodeJS.Timeout };
    slot.timer = setTimeout(() => {
      pending = null;
      opts.onWake(slot.reason);
    }, coalesceMs);
    slot.timer.unref?.();
    pending = slot;
  }

  return {
    wake,
    stop() {
      stopped = true;
      if (pending) {
        clearTimeout(pending.timer);
        pending = null;
      }
    },
  };
}
