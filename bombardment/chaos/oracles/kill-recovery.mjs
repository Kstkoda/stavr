// Bombardment Phase 4a — kill-recovery oracle.
//
// One destructive cycle, two invariants:
//
//   1. RESTART POLICY — after `docker kill` SIGKILLs peer-a, the
//      `restart: unless-stopped` policy brings the container back and
//      /healthz returns 200 within RESTART_BUDGET_MS. The container's
//      RestartCount must also increment relative to a pre-kill snapshot;
//      /healthz answering again is necessary but not sufficient evidence
//      that the policy fired.
//
//   2. STARTUP DECISION SWEEP — a decision row that was `open` and had
//      `expires_at` in the past at kill time appears as a
//      decision_late_response event in the event log after restart
//      (proves startupDecisionSweep ran and wrote through publish()).
//
// Invariant 3 (SSE consumer reconnect across kill, with ?since_id=)
// was dropped — see proposed/bombardment-chaos-debug-bom.md "Decision
// (locked 2026-05-25)". The SSE endpoint is loopback-gated; from the
// host the consumer gets 403, from inside the container it dies with
// the container, and a netns-sharing sidecar loses its namespace at
// SIGKILL. The since_id replay path is already covered in-process by
// `tests/chaos.test.ts` ("disconnected client can reconnect and
// resume from since_event_id"). The across-a-container-kill wrapper
// is impossible by topology and adds no coverage.
//
// Why one oracle, not two: each invariant requires the SAME kill +
// restart cycle. Splitting them would either kill the container twice
// (cumulative blast radius, slow) or rely on shared state across
// oracles (fragile). One driver, one kill, two assertions.

import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { getJson } from '../../federation/http-probe.mjs';
import { TOPOLOGY } from '../../federation/topology.mjs';

const TARGET_ID = 'peer-a';
const RESTART_BUDGET_MS = Number(
  process.env.STAVR_BOMBARDMENT_RESTART_BUDGET_MS ?? 90_000,
);
const SWEEP_BUDGET_MS = Number(
  process.env.STAVR_BOMBARDMENT_SWEEP_BUDGET_MS ?? 30_000,
);
const POLL_INTERVAL_MS = 1_000;

function dockerExec(args, opts = {}) {
  return spawnSync('docker', args, { encoding: 'utf8', ...opts });
}

// Read the container's current RestartCount from `docker inspect`. The
// kill-recovery oracle snapshots this before the kill and asserts it
// incremented after recovery — that's the positive proof the restart
// policy actually fired, distinct from "the daemon happened to keep
// answering /healthz somehow." Returns -1 on docker error.
function inspectRestartCount(container) {
  const r = dockerExec(['inspect', '--format', '{{.RestartCount}}', container]);
  if (r.status !== 0) return -1;
  const n = Number.parseInt((r.stdout ?? '').trim(), 10);
  return Number.isFinite(n) ? n : -1;
}

export async function killRecovery() {
  const start = Date.now();
  const target = TOPOLOGY.peers.find((p) => p.id === TARGET_ID);
  if (!target) {
    return {
      name: 'chaos_kill_recovery',
      ok: false,
      reason: `topology has no peer ${TARGET_ID}`,
      durationMs: Date.now() - start,
    };
  }
  const transcript = [];
  const correlationId = `bombardment-chaos-${randomUUID()}`;

  function note(phase, detail) {
    transcript.push({ phase, detail, t_ms: Date.now() - start });
  }

  // 1) Confirm baseline health.
  try {
    await getJson(`${target.baseUrl}/healthz`, { timeoutMs: 4000 });
  } catch (err) {
    return {
      name: 'chaos_kill_recovery',
      ok: false,
      reason: `baseline /healthz failed: ${err.message}`,
      durationMs: Date.now() - start,
    };
  }
  note('baseline_healthy', true);

  // 2) Seed the decision row inside the container.
  const seed = dockerExec([
    'exec',
    target.container,
    'node',
    '/app/bombardment-chaos/seed-decision.mjs',
    correlationId,
  ]);
  if (seed.status !== 0) {
    return {
      name: 'chaos_kill_recovery',
      ok: false,
      reason: `seed-decision failed: ${(seed.stderr || seed.stdout || '').trim()}`,
      evidence: { transcript },
      durationMs: Date.now() - start,
    };
  }
  note('decision_seeded', seed.stdout.trim());

  // Snapshot the container's restart count BEFORE the kill so we can
  // assert post-recovery that the restart-policy actually fired (vs.
  // /healthz happening to keep answering through some other path).
  const preKillRestarts = inspectRestartCount(target.container);
  note('pre_kill_restart_count', preKillRestarts);

  // 3) The kill. We can't use `docker kill` here: Docker marks any
  //    container stopped via `docker stop` OR `docker kill` as
  //    "manually stopped" and `restart: unless-stopped` then explicitly
  //    refuses to restart it (the documented semantics of the policy).
  //    The kill-recovery test wants the opposite — a daemon-crash
  //    scenario where the restart policy DOES fire — so the kill has
  //    to happen from inside the container, where Docker sees it as an
  //    unexpected child-process death rather than an operator action.
  //    The in-container `kill-daemon.mjs` helper finds the node PID
  //    via /proc and sends SIGKILL directly; once the daemon is gone,
  //    tini (PID 1) exits, the container dies, and the restart policy
  //    brings it back. This is more realistic than `docker kill` for
  //    the test scenario regardless of the manual-stop quirk — a real
  //    daemon crash is a process exit, not a Docker API action.
  const kill = dockerExec([
    'exec',
    target.container,
    'node',
    '/app/bombardment-chaos/kill-daemon.mjs',
  ]);
  if (kill.status !== 0) {
    return {
      name: 'chaos_kill_recovery',
      ok: false,
      reason: `kill-daemon failed: ${(kill.stderr || kill.stdout || '').trim()}`,
      evidence: { transcript },
      durationMs: Date.now() - start,
    };
  }
  note('kill_daemon_issued', kill.stdout.trim());

  // 4) Invariant 1 — restart-policy recovery. Poll /healthz until it
  //    returns 200 or budget expires. Inside the same poll loop, note
  //    when docker reports the container as running again so the
  //    transcript can distinguish "restart never happened" from
  //    "restarted but /healthz slow".
  const restartDeadline = Date.now() + RESTART_BUDGET_MS;
  let recovered = false;
  let lastErr = '';
  while (Date.now() < restartDeadline) {
    await sleep(POLL_INTERVAL_MS);
    try {
      const r = await getJson(`${target.baseUrl}/healthz`, { timeoutMs: 2000 });
      if (r.body && r.body.ok === true) {
        recovered = true;
        break;
      }
    } catch (err) {
      lastErr = err.message;
    }
  }
  if (!recovered) {
    return {
      name: 'chaos_kill_recovery',
      ok: false,
      reason: `target did not recover within ${RESTART_BUDGET_MS}ms (last err: ${lastErr})`,
      evidence: { transcript },
      durationMs: Date.now() - start,
    };
  }
  note('healthz_recovered', true);

  // Positive verification that the restart-policy actually fired:
  // RestartCount must have incremented relative to the pre-kill
  // snapshot. /healthz answering again is necessary but not sufficient
  // — a daemon that trapped SIGKILL via a side process, or a future
  // restart-policy misconfig where the container keeps serving without
  // a restart, would silently pass the /healthz check.
  const postRecoveryRestarts = inspectRestartCount(target.container);
  note('post_recovery_restart_count', postRecoveryRestarts);
  if (postRecoveryRestarts <= preKillRestarts) {
    return {
      name: 'chaos_kill_recovery',
      ok: false,
      reason:
        `restart count did not increment after kill ` +
        `(pre=${preKillRestarts}, post=${postRecoveryRestarts}) — ` +
        `/healthz recovered but the container was never restarted by the policy`,
      evidence: { transcript },
      durationMs: Date.now() - start,
    };
  }

  // 5) Invariant 2 — startupDecisionSweep produced a
  //    decision_late_response event for the seeded row. Poll the
  //    in-container helper because the sweep races daemon startup
  //    (it can land before /healthz answers, but it can also lag by a
  //    second or two while the broker initialises listeners).
  const sweepDeadline = Date.now() + SWEEP_BUDGET_MS;
  let lateResponseFound = false;
  let lateEvent = null;
  while (Date.now() < sweepDeadline) {
    const probe = dockerExec([
      'exec',
      target.container,
      'node',
      '/app/bombardment-chaos/find-late-response.mjs',
      correlationId,
    ]);
    if (probe.status === 0) {
      lateResponseFound = true;
      try {
        lateEvent = JSON.parse(probe.stdout.trim()).event;
      } catch {
        /* leave lateEvent null */
      }
      break;
    }
    // Exit code 3 = "not found yet" — keep polling.
    // Exit code 1 = DB unreachable, transient during restart.
    await sleep(POLL_INTERVAL_MS);
  }
  if (!lateResponseFound) {
    return {
      name: 'chaos_kill_recovery',
      ok: false,
      reason: `decision_late_response for ${correlationId} not observed within ${SWEEP_BUDGET_MS}ms after restart — startupDecisionSweep did not fire?`,
      evidence: { transcript },
      durationMs: Date.now() - start,
    };
  }
  note('decision_late_response_found', lateEvent?.id ?? '<unknown id>');

  return {
    name: 'chaos_kill_recovery',
    ok: true,
    evidence: { transcript, correlation_id: correlationId },
    durationMs: Date.now() - start,
  };
}
