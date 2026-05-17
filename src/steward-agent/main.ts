// v0.5 P3 — Steward-agent subprocess entry point.
//
// Spawned by `child_process.fork('dist/steward-agent/main.js', ...)` from
// src/steward/spawner.ts. On boot:
//   1. Resolve STAVR_HOME (env override, else ~/.stavr)
//   2. Open the three state stores (P1)
//   3. Restore latest snapshot if present
//   4. Start the agent loop (./loop.ts) — handles IPC + runtime dispatch
//
// PM2-supervised (max_restarts: 3, restart_delay: 30000). Crash here is
// non-fatal to the daemon — heartbeat timeout marks Steward unhealthy on
// /diagnostics, PM2 respawns inside the 30s window.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { openStewardDbs, findLatestSnapshot } from './db/init.js';
import { startStewardAgentLoop } from './loop.js';
import { getLogger } from '../log.js';

interface CliArgs {
  daemonUrl?: string;
  initOnly: boolean;
  stavrHome: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    initOnly: false,
    stavrHome: process.env.STAVR_HOME?.trim() || join(homedir(), '.stavr'),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--daemon-url' && argv[i + 1]) {
      args.daemonUrl = argv[++i];
    } else if (a === '--init-only') {
      args.initOnly = true;
    } else if (a === '--stavr-home' && argv[i + 1]) {
      args.stavrHome = argv[++i];
    }
  }
  return args;
}

export async function runStewardAgent(argv: string[] = process.argv.slice(2)): Promise<void> {
  const log = getLogger();
  const args = parseArgs(argv);

  log.info('steward-agent boot', {
    stavr_home: args.stavrHome,
    daemon_url: args.daemonUrl ?? '(none)',
    init_only: args.initOnly,
    pid: process.pid,
  });

  const bundle = openStewardDbs(args.stavrHome);

  // Restore working memory from latest snapshot if present. Episodic-log
  // replay (per ADR-032 §Decision 6) is deferred to a later phase — the
  // snapshot's working_memory is the high-value bit; replay is observability
  // not correctness.
  const snapshot = findLatestSnapshot(bundle.stewardHome);
  if (snapshot) {
    let restored = 0;
    for (const [k, v] of Object.entries(snapshot.snapshot.working_memory)) {
      bundle.memory.setWorking(k, v);
      restored++;
    }
    log.info('steward-agent restored from snapshot', {
      path: snapshot.path,
      restored_keys: restored,
      active_boms: snapshot.snapshot.active_bom_ids.length,
    });
  }

  if (args.initOnly) {
    log.info('steward-agent --init-only: stores ready, exiting');
    bundle.close();
    return;
  }

  const loop = startStewardAgentLoop({
    memory: bundle.memory,
    lessons: bundle.lessons,
    prefs: bundle.prefs,
  });

  const onSignal = (sig: NodeJS.Signals) => {
    log.info('steward-agent signal', { signal: sig });
    loop.stop();
    bundle.close();
    process.exit(0);
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  // Subprocess loses parent — exit so PM2 respawns rather than leaving us orphaned.
  process.on('disconnect', () => {
    log.warn('steward-agent disconnected from parent; exiting');
    loop.stop();
    bundle.close();
    process.exit(0);
  });
}

// CLI entry: when run as `node dist/steward-agent/main.js`, kick off the agent.
// During tests, this module is imported but the bottom-of-file invocation is
// behind an env-gate so tests can call runStewardAgent() directly without
// spawning a real loop.
if (process.env.STAVR_AGENT_AUTORUN !== 'false') {
  const invokedDirectly =
    process.argv[1] && (process.argv[1].endsWith('main.js') || process.argv[1].endsWith('main.ts'));
  if (invokedDirectly) {
    runStewardAgent().catch((err) => {
      console.error('steward-agent fatal:', err);
      process.exit(1);
    });
  }
}
