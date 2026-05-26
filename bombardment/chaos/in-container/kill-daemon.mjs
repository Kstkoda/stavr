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
// for processes whose argv includes BOTH "/app/dist/cli.js" (the CLI
// entry — set by bombardment/docker/entrypoint.sh) AND the "daemon"
// subcommand token. The script then SIGKILLs it and exits; once the
// daemon is gone, tini exits too, the container dies, and Docker's
// restart policy brings it back.
//
// Why the full-argv match (entry + subcommand) instead of a positional
// substring on '/app/dist/cli.js': a future helper or sidecar that
// happens to re-invoke the same CLI entry for a different subcommand
// (e.g. `node /app/dist/cli.js status`, `... events tail`) would match
// the bare substring and be SIGKILLed by mistake. Requiring the
// "daemon" subcommand token narrows the match to the long-lived
// daemon process this oracle is targeting.
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
    let argv;
    try {
      // /proc/<pid>/cmdline is NUL-separated argv; split into tokens
      // (drop the trailing empty after the final NUL).
      argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
        .split('\0')
        .filter((tok) => tok.length > 0);
    } catch {
      continue;
    }
    // The daemon is the node process invoked by entrypoint.sh as
    //   node /app/dist/cli.js daemon start ...
    // Require BOTH the CLI entry argv token AND the 'daemon' subcommand
    // token — a positional substring on '/app/dist/cli.js' alone would
    // match any future helper that re-uses the CLI entry for a different
    // subcommand (e.g. `node /app/dist/cli.js status`).
    if (argv.includes('/app/dist/cli.js') && argv.includes('daemon')) return pid;
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
