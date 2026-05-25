#!/usr/bin/env node
// Bombardment Phase 4a — in-container helper: hard-kill the daemon
// process from inside the container.
//
// Why not `docker kill` from the runner: Docker marks any container
// stopped via `docker stop` OR `docker kill` as "manually stopped",
// and `restart: unless-stopped` explicitly refuses to restart
// manually-stopped containers. The kill-recovery oracle wants the
// opposite — a daemon-crash scenario where the restart policy DOES
// fire — so the kill must happen from inside the container, where
// Docker sees it as an unexpected child-process death of PID 1's
// child and the restart policy applies.
//
// Invoked from the runner via:
//   docker exec stavr-peer-a node /app/bombardment-chaos/kill-daemon.mjs
//
// The script finds the daemon process (not itself) by scanning /proc
// for processes whose cmdline contains "dist/cli.js" (the daemon's
// entrypoint script — set by bombardment/docker/entrypoint.sh), then
// sends SIGKILL. The script then exits; once the daemon is gone, tini
// exits too, the container dies, and Docker's restart policy brings
// it back.
//
// We match on cmdline rather than comm because Node.js sets the
// process comm to "node-MainThread" by default (the main thread's
// name leaks into /proc), and the truncated 15-char comm differs by
// runtime version. cmdline is the exact argv and is robust.
//
// Exit codes:
//   0 — daemon process found and signalled (SIGKILL delivered)
//   1 — no daemon process found, OR signal delivery failed

import { readdirSync, readFileSync } from 'node:fs';

const ownPid = process.pid;

function findDaemonPid() {
  const procDirs = readdirSync('/proc').filter((name) => /^\d+$/.test(name));
  for (const dir of procDirs) {
    const pid = Number(dir);
    // Skip tini (PID 1) and ourselves.
    if (pid === 1 || pid === ownPid) continue;
    let cmdline;
    try {
      // /proc/<pid>/cmdline is NUL-separated argv; join to plain string.
      cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
    } catch {
      continue;
    }
    // The daemon is the node process invoked by entrypoint.sh as
    //   node /app/dist/cli.js daemon start ...
    // bombardment-chaos helpers (this script, seed-decision, etc.)
    // run from /app/bombardment-chaos/<helper>.mjs, so the cli.js
    // substring is unique to the daemon.
    if (cmdline.includes('/app/dist/cli.js')) return pid;
  }
  return null;
}

const daemonPid = findDaemonPid();
if (daemonPid === null) {
  console.error('[kill-daemon] no node process found in /proc');
  process.exit(1);
}

try {
  process.kill(daemonPid, 'SIGKILL');
  console.log(`[kill-daemon] sent SIGKILL to pid ${daemonPid}`);
  process.exit(0);
} catch (err) {
  console.error(`[kill-daemon] kill ${daemonPid} failed: ${err.message}`);
  process.exit(1);
}
