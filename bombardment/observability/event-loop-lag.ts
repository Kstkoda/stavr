/**
 * Bombardment Phase 2 — event-loop-lag sampler.
 *
 * Tracks tick-to-tick scheduler lag while a workload runs. The daemon
 * already exposes loop-lag via observability/event-loop.ts metrics,
 * but those aren't surfaced by /healthz, and the soak harness needs
 * an in-process recorder it can summarize at end of run.
 *
 * Mechanism: schedule a setInterval at `targetMs`; on every tick,
 * measure how late we fired vs the target. The lag is the scheduler's
 * actual gap minus the requested gap.
 *
 * Why a fresh sampler instead of importing the daemon's metrics:
 * we want the sampler to be self-contained — the harness needs the
 * raw samples to compute its own percentiles, and the metrics path
 * is exposed via /metrics (push-pull), not directly accessible to the
 * test driver.
 */

export interface LagSampler {
  /** All recorded lag samples in ms. */
  samples(): number[];
  /** p50/p95/p99/max convenience summary. */
  summary(): { n: number; p50: number; p95: number; p99: number; max: number; meanMs: number };
  /** Stop the sampler. Idempotent. */
  stop(): void;
}

export function startEventLoopLagSampler(targetMs = 50): LagSampler {
  const samples: number[] = [];
  // Monotonic clock via perf_hooks. Date.now() can step (NTP, DST, VM
  // suspend/resume): a forward step pollutes p99/max with a one-shot
  // huge "lag" sample; a backward step yields negative lag clamped to 0,
  // silently HIDING a real wedge in that interval. performance.now() is
  // not affected by wall-clock adjustments.
  let last = performance.now();
  const handle = setInterval(() => {
    const now = performance.now();
    const lag = now - last - targetMs;
    samples.push(Math.max(0, lag));
    last = now;
  }, targetMs);
  // Don't keep the process alive on the sampler alone.
  if (typeof handle.unref === 'function') handle.unref();

  return {
    samples: () => samples.slice(),
    summary: () => {
      if (samples.length === 0) return { n: 0, p50: 0, p95: 0, p99: 0, max: 0, meanMs: 0 };
      const sorted = [...samples].sort((a, b) => a - b);
      const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))];
      const sum = sorted.reduce((a, b) => a + b, 0);
      return {
        n: sorted.length,
        p50: pct(50),
        p95: pct(95),
        p99: pct(99),
        max: sorted[sorted.length - 1],
        meanMs: sum / sorted.length,
      };
    },
    stop: () => clearInterval(handle),
  };
}
