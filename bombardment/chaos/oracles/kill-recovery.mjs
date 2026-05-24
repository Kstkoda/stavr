// Bombardment Phase 4a — kill-recovery oracle.
//
// One destructive cycle, three invariants:
//
//   1. RESTART POLICY — after `docker kill` SIGKILLs peer-a, the
//      `restart: unless-stopped` policy brings the container back and
//      /healthz returns 200 within RESTART_BUDGET_MS.
//
//   2. STARTUP DECISION SWEEP — a decision row that was `open` and had
//      `expires_at` in the past at kill time appears as a
//      decision_late_response event in the event log after restart
//      (proves startupDecisionSweep ran and wrote through publish()).
//
//   3. SSE RECONNECT — an SSE consumer that captured the latest event
//      id BEFORE the kill can reconnect to /events/sse?since_id=<id>
//      AFTER the restart, and the reconnect succeeds (header 200,
//      `:ok` ack, no immediate close). Replay correctness over the
//      cut is asserted by checking that the late-response event from
//      invariant 2 is included in the post-reconnect stream.
//
// Why one oracle, not three: each invariant requires the SAME kill +
// restart cycle. Splitting them would either kill the container three
// times (cumulative blast radius, slow) or rely on shared state across
// oracles (fragile). One driver, one kill, three assertions.

import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { getJson } from '../../federation/http-probe.mjs';
import { TOPOLOGY } from '../../federation/topology.mjs';

const TARGET_ID = 'peer-a';
const RESTART_BUDGET_MS = Number(
  process.env.STAVR_BOMBARDMENT_RESTART_BUDGET_MS ?? 90_000,
);
const SWEEP_BUDGET_MS = Number(
  process.env.STAVR_BOMBARDMENT_SWEEP_BUDGET_MS ?? 30_000,
);
const SSE_BASELINE_MS = Number(
  process.env.STAVR_BOMBARDMENT_SSE_BASELINE_MS ?? 3_000,
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

// Opens an SSE connection, collects events for a settle window, then
// returns the latest event id seen + the open socket so the caller
// can keep the consumer alive across the kill. The daemon's stream
// will fail naturally when the container dies; we listen for that
// to confirm the cut happened from the consumer's side.
function openSseConsumer(baseUrl) {
  return new Promise((resolveOuter, rejectOuter) => {
    const url = new URL('/events/sse', baseUrl);
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'GET',
        headers: { Accept: 'text/event-stream' },
      },
      (res) => {
        if (res.statusCode !== 200) {
          rejectOuter(new Error(`baseline SSE returned HTTP ${res.statusCode}`));
          return;
        }
        const consumer = {
          req,
          res,
          lastEventId: null,
          closed: false,
          dropDetected: false,
        };
        res.setEncoding('utf8');
        let buf = '';
        res.on('data', (chunk) => {
          buf += chunk;
          let nlIdx;
          // SSE messages are separated by a blank line; parse on
          // double-newline boundary so we never half-read a JSON event.
          while ((nlIdx = buf.indexOf('\n\n')) !== -1) {
            const frame = buf.slice(0, nlIdx);
            buf = buf.slice(nlIdx + 2);
            if (frame.startsWith('data:')) {
              const json = frame.slice('data:'.length).trim();
              try {
                const ev = JSON.parse(json);
                if (ev && typeof ev.id === 'string') consumer.lastEventId = ev.id;
              } catch {
                /* ignore non-JSON frames (comments, heartbeat) */
              }
            }
          }
        });
        res.on('end', () => {
          consumer.closed = true;
          consumer.dropDetected = true;
        });
        res.on('error', () => {
          consumer.closed = true;
          consumer.dropDetected = true;
        });
        resolveOuter(consumer);
      },
    );
    req.on('error', rejectOuter);
    req.setTimeout(5_000, () => {
      req.destroy(new Error('timeout connecting baseline SSE'));
    });
    req.end();
  });
}

// Returns true if /events/sse?since_id=<id> returns a successful 200
// stream that includes the seeded late-response event for the given
// correlation_id. Drains the stream for SSE_BASELINE_MS then closes.
function verifyReconnect(baseUrl, sinceId, expectedCorrelationId) {
  return new Promise((resolveOuter) => {
    const url = new URL('/events/sse', baseUrl);
    if (sinceId) url.searchParams.set('since_id', sinceId);
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'GET',
        headers: { Accept: 'text/event-stream' },
      },
      (res) => {
        if (res.statusCode !== 200) {
          resolveOuter({ ok: false, reason: `reconnect HTTP ${res.statusCode}` });
          return;
        }
        let buf = '';
        let lateResponseSeen = false;
        let frameCount = 0;
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buf += chunk;
          let nlIdx;
          while ((nlIdx = buf.indexOf('\n\n')) !== -1) {
            const frame = buf.slice(0, nlIdx);
            buf = buf.slice(nlIdx + 2);
            if (frame.startsWith('data:')) {
              frameCount++;
              const json = frame.slice('data:'.length).trim();
              try {
                const ev = JSON.parse(json);
                if (
                  ev?.kind === 'decision_late_response' &&
                  ev?.correlation_id === expectedCorrelationId
                ) {
                  lateResponseSeen = true;
                }
              } catch {
                /* skip non-JSON */
              }
            }
          }
        });
        setTimeout(() => {
          req.destroy();
          resolveOuter({ ok: true, frameCount, lateResponseSeen });
        }, SSE_BASELINE_MS);
      },
    );
    req.on('error', (err) => resolveOuter({ ok: false, reason: err.message }));
    req.setTimeout(10_000, () => {
      req.destroy();
      resolveOuter({ ok: false, reason: 'reconnect timed out' });
    });
    req.end();
  });
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
    '/opt/bombardment-chaos/seed-decision.mjs',
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

  // 3) Open the SSE consumer + let it settle so lastEventId is current.
  let consumer;
  try {
    consumer = await openSseConsumer(target.baseUrl);
  } catch (err) {
    return {
      name: 'chaos_kill_recovery',
      ok: false,
      reason: `baseline SSE open failed: ${err.message}`,
      evidence: { transcript },
      durationMs: Date.now() - start,
    };
  }
  await sleep(SSE_BASELINE_MS);
  const sinceId = consumer.lastEventId;
  note('sse_baseline_last_id', sinceId);

  // Fail-fast when sinceId is null. Without a baseline event id the
  // post-kill reconnect at step 7 would call /events/sse with no
  // ?since_id= query param; the daemon's SSE handler then replays its
  // ENTIRE event history on connect (persistence.ts getEvents with no
  // sinceEventId returns all historical rows up to limit=500). That
  // path would surface the late-response event via the no-filter
  // full-replay, silently turning invariant 3 into a tautology
  // instead of a since_id correctness test. The seed-decision helper
  // writes a `decision_request` event for exactly this purpose, so
  // sinceId being null here means SSE never delivered the historical
  // replay — that is itself a real failure to flag.
  if (!sinceId) {
    consumer.req.destroy();
    return {
      name: 'chaos_kill_recovery',
      ok: false,
      reason:
        'baseline SSE consumer captured no event id during settle window — ' +
        'reconnect step would fall back to no-filter full replay, masking a ' +
        'since_id regression. Check that seed-decision wrote its decision_request ' +
        'event and that the SSE historical replay path is firing.',
      evidence: { transcript },
      durationMs: Date.now() - start,
    };
  }

  // Snapshot the container's restart count BEFORE the kill so we can
  // assert post-recovery that the restart-policy actually fired (vs.
  // /healthz happening to keep answering through some other path).
  const preKillRestarts = inspectRestartCount(target.container);
  note('pre_kill_restart_count', preKillRestarts);

  // 4) The kill. We use `docker kill` directly because it's the only
  //    primitive that guarantees the daemon process dies synchronously
  //    before this script proceeds — Pumba's kill is asynchronous from
  //    the runner's POV. The Pumba sidecar in chaos.yml exists for
  //    the operator-driven demo path.
  const kill = dockerExec(['kill', '-s', 'SIGKILL', target.container]);
  if (kill.status !== 0) {
    consumer.req.destroy();
    return {
      name: 'chaos_kill_recovery',
      ok: false,
      reason: `docker kill failed: ${kill.stderr.trim()}`,
      evidence: { transcript },
      durationMs: Date.now() - start,
    };
  }
  note('docker_kill_issued', true);

  // 5) Invariant 1 — restart-policy recovery. Poll /healthz until it
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
    consumer.req.destroy();
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
    consumer.req.destroy();
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

  // The SSE consumer's connection died with the container; assert the
  // consumer noticed the drop. Without this, a future change that kept
  // a long-lived TCP socket alive across the kill would silently pass.
  await sleep(500);
  note('sse_consumer_drop_detected', consumer.dropDetected);
  if (!consumer.dropDetected) {
    consumer.req.destroy();
    return {
      name: 'chaos_kill_recovery',
      ok: false,
      reason:
        'SSE consumer did not observe the connection drop after the kill — ' +
        'the original stream stayed alive somehow, which means the post-kill ' +
        'reconnect is not actually exercising a fresh connection',
      evidence: { transcript },
      durationMs: Date.now() - start,
    };
  }
  consumer.req.destroy();

  // 6) Invariant 2 — startupDecisionSweep produced a
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
      '/opt/bombardment-chaos/find-late-response.mjs',
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

  // 7) Invariant 3 — SSE reconnect with the pre-kill since_id, and
  //    confirm the late-response event from invariant 2 is included
  //    in the post-reconnect replay.
  const reconnect = await verifyReconnect(target.baseUrl, sinceId, correlationId);
  if (!reconnect.ok) {
    return {
      name: 'chaos_kill_recovery',
      ok: false,
      reason: `SSE reconnect failed: ${reconnect.reason}`,
      evidence: { transcript, sinceId },
      durationMs: Date.now() - start,
    };
  }
  if (!reconnect.lateResponseSeen) {
    return {
      name: 'chaos_kill_recovery',
      ok: false,
      reason: `SSE reconnect succeeded but did not include the late-response event for ${correlationId} (frames=${reconnect.frameCount}) — replay-from-since_id may have skipped it`,
      evidence: { transcript, sinceId },
      durationMs: Date.now() - start,
    };
  }
  note('sse_reconnect_replay_ok', { frameCount: reconnect.frameCount });

  return {
    name: 'chaos_kill_recovery',
    ok: true,
    evidence: { transcript, correlation_id: correlationId },
    durationMs: Date.now() - start,
  };
}
