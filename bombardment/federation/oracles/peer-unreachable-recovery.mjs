// Bombardment Phase 3d — peer-unreachable-recovery oracle.
//
// Actively disrupts hub connectivity, observes the registry's
// view-of-hub transition from `online` -> `degraded`/`offline`, restores
// connectivity, and observes the recovery back to `online` within a
// bounded timeout.
//
// This is a *driver-style* oracle — it mutates the topology rather
// than just probing. As such it is NOT in the default oracle set;
// it is invoked explicitly by `run-recovery-slice.mjs` so the
// continuous-mode runner cannot accidentally take the federation
// down mid-soak.
//
// Disruption mechanism: `docker pause` / `docker unpause` on the hub
// container. Pause freezes the process so /api/federation/health
// stops responding (PeerClient hits the 3s timeout and records
// ok=false) without actually killing the process — preserves
// container identity + IP across the disruption, which is the
// correct shape for testing "the peer briefly went away and came
// back."
//
// Budget defaults to ~3 min (5 ping cycles * 60s default interval is
// excessive; the daemon's first failed probe transitions state
// immediately, so 90s per phase is comfortable):
//
//   STAVR_BOMBARDMENT_RECOVERY_BUDGET_MS — total budget, default 180_000
//   STAVR_BOMBARDMENT_RECOVERY_PAUSE_MS  — pause duration,  default  10_000
//
// The viewer is peer-a (same network as hub, so the disruption
// crosses a real Docker veth boundary).

import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { getJson } from '../http-probe.mjs';
import { TOPOLOGY } from '../topology.mjs';

const BUDGET_MS = Number(process.env.STAVR_BOMBARDMENT_RECOVERY_BUDGET_MS ?? 180_000);
const PAUSE_MS = Number(process.env.STAVR_BOMBARDMENT_RECOVERY_PAUSE_MS ?? 10_000);
const VIEWER_ID = 'peer-a';
const TARGET_ID = 'hub';
const POLL_INTERVAL_MS = 3000;

function dockerExec(args) {
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

async function readState() {
  const viewer = TOPOLOGY.peers.find((p) => p.id === VIEWER_ID);
  const r = await getJson(`${viewer.baseUrl}/api/federation/peers`, { timeoutMs: 4000 });
  const view = r.body.peers.find((p) => p.id === TARGET_ID);
  return view ? view.state : 'missing';
}

async function pingViaTool(toolName, viewerBaseUrl) {
  // Trigger an explicit ping cycle by hitting the daemon's federation
  // reload endpoint if present; otherwise just sleep one POLL_INTERVAL.
  // Phase 3 doesn't add a /api/federation/ping endpoint — the daemon's
  // own 60s setInterval drives convergence. The 60s wait is built in
  // to BUDGET_MS.
  await sleep(POLL_INTERVAL_MS);
}

export async function peerUnreachableRecovery() {
  const start = Date.now();
  const target = TOPOLOGY.peers.find((p) => p.id === TARGET_ID);
  const viewer = TOPOLOGY.peers.find((p) => p.id === VIEWER_ID);
  const transcript = [];

  function record(phase, state) {
    transcript.push({ phase, state, t_ms: Date.now() - start });
  }

  // 1) Establish baseline: target reports online from viewer.
  let baseline;
  try {
    baseline = await readState();
  } catch (err) {
    return {
      name: 'federation_peer_unreachable_recovery',
      ok: false,
      reason: `could not read baseline state from ${viewer.baseUrl}: ${err.message}`,
      evidence: { transcript },
      durationMs: Date.now() - start,
    };
  }
  record('baseline', baseline);
  if (baseline !== 'online') {
    return {
      name: 'federation_peer_unreachable_recovery',
      ok: false,
      reason: `baseline state is "${baseline}", expected "online" — refuse to disrupt`,
      evidence: { transcript },
      durationMs: Date.now() - start,
    };
  }

  // 2) Disrupt: pause the hub container. PeerClient probes will time
  //    out and recordPingResult(false) flips state to `degraded`.
  const pause = dockerExec(['pause', target.container]);
  if (pause.status !== 0) {
    return {
      name: 'federation_peer_unreachable_recovery',
      ok: false,
      reason: `docker pause failed: ${pause.stderr.trim()}`,
      evidence: { transcript },
      durationMs: Date.now() - start,
    };
  }

  // 3) Poll until the state leaves `online`. Default daemon ping
  //    interval is 60s — give it a generous budget.
  const downDeadline = Date.now() + Math.max(BUDGET_MS / 2, 90_000);
  let detectedDown = false;
  while (Date.now() < downDeadline) {
    await sleep(POLL_INTERVAL_MS);
    try {
      const s = await readState();
      record('post_pause', s);
      if (s !== 'online') {
        detectedDown = true;
        break;
      }
    } catch (err) {
      record('post_pause', `read_error: ${err.message}`);
    }
  }

  // 4) Hold the disruption briefly, then unpause.
  await sleep(PAUSE_MS);
  const unpause = dockerExec(['unpause', target.container]);
  if (unpause.status !== 0) {
    return {
      name: 'federation_peer_unreachable_recovery',
      ok: false,
      reason: `docker unpause failed: ${unpause.stderr.trim()} (container may need manual recovery)`,
      evidence: { transcript, detectedDown },
      durationMs: Date.now() - start,
    };
  }

  if (!detectedDown) {
    return {
      name: 'federation_peer_unreachable_recovery',
      ok: false,
      reason: 'viewer never observed target leaving `online` despite pause — ping cycle stuck?',
      evidence: { transcript },
      durationMs: Date.now() - start,
    };
  }

  // 5) Poll until state returns to `online` within remaining budget.
  const upDeadline = start + BUDGET_MS;
  while (Date.now() < upDeadline) {
    await sleep(POLL_INTERVAL_MS);
    try {
      const s = await readState();
      record('post_unpause', s);
      if (s === 'online') {
        return {
          name: 'federation_peer_unreachable_recovery',
          ok: true,
          evidence: { transcript },
          durationMs: Date.now() - start,
        };
      }
    } catch (err) {
      record('post_unpause', `read_error: ${err.message}`);
    }
  }

  return {
    name: 'federation_peer_unreachable_recovery',
    ok: false,
    reason: `target did not recover to online within ${BUDGET_MS}ms`,
    evidence: { transcript },
    durationMs: Date.now() - start,
  };
}
