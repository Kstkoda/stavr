#!/usr/bin/env node
import { Command } from 'commander';
import { EventStore } from './persistence.js';
import { Broker } from './broker.js';
import { mountTransports } from './transports.js';
import { defaultDbPath } from './paths.js';
import {
  daemonStatus,
  restartDaemon,
  startDaemon,
  stopDaemon,
} from './daemon.js';
import { runConnectTest } from './connect-test.js';
import { configureLogger, parseLogFormat } from './log.js';
import {
  installWatchdog,
  uninstallWatchdog,
  watchdogStatus,
} from './watchdog-install.js';
import { registerStewardCli } from './steward/cli.js';
import { registerCredentialsCli } from './credentials/cli.js';

const program = new Command();
program
  .name('cowire')
  .description('Cowire (Switch) — MCP-native broker between Co, CC, and user channels')
  .version('0.1.0');

program
  .command('start')
  .description('Start Switch (stdio + HTTP/SSE by default).')
  .option('-p, --port <port>', 'HTTP/SSE port', (v) => Number(v), 7777)
  .option('--stdio-only', 'Disable HTTP/SSE transport.')
  .option('--db <path>', 'SQLite path', defaultDbPath())
  .option('--log-format <fmt>', 'Log format: text (default) or json (newline-delimited JSON to stderr).', 'text')
  .action(async (opts: { port: number; stdioOnly?: boolean; db: string; logFormat: string }) => {
    const logger = configureLogger({ format: parseLogFormat(opts.logFormat) });
    const store = new EventStore();
    store.init(opts.db);
    const broker = new Broker(store);

    const transports = await mountTransports(broker, {
      mode: opts.stdioOnly ? 'stdio' : 'both',
      port: opts.stdioOnly ? undefined : opts.port,
    });

    const shutdown = async (sig: string) => {
      logger.info('shutting down', { signal: sig });
      await transports.shutdown();
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
  });

program
  .command('status')
  .description('Print local DB stats and recent decisions.')
  .option('--db <path>', 'SQLite path', defaultDbPath())
  .action((opts: { db: string }) => {
    const store = new EventStore();
    store.init(opts.db);
    const total = store.eventCount();
    const decisions = store.listRecentDecisions(10);
    console.log(JSON.stringify({ db: opts.db, event_count: total, recent_decisions: decisions }, null, 2));
    store.close();
  });

program
  .command('events')
  .description('Query the event log from the CLI.')
  .option('--kind <kind...>', 'Filter by one or more event kinds.')
  .option('--since <id>', 'Cursor: event id to read after.')
  .option('--source-agent <agent>', 'Filter by source agent.')
  .option('--tenant-id <id>', 'Filter by tenant id.')
  .option('--limit <n>', 'Max events to return (default 50).', (v) => Number(v), 50)
  .option('--db <path>', 'SQLite path', defaultDbPath())
  .action((opts: { kind?: string[]; since?: string; sourceAgent?: string; tenantId?: string; limit: number; db: string }) => {
    const store = new EventStore();
    store.init(opts.db);
    const result = store.getEvents({
      sinceEventId: opts.since,
      kinds: opts.kind,
      sourceAgent: opts.sourceAgent,
      tenantId: opts.tenantId,
      limit: opts.limit,
    });
    console.log(JSON.stringify(result, null, 2));
    store.close();
  });

// ---- daemon subcommands ----

const daemon = program.command('daemon').description('Manage the long-running Switch daemon.');

daemon
  .command('start')
  .description('Start the Switch daemon bound to 127.0.0.1:<port>.')
  .option('-p, --port <port>', 'HTTP/SSE port', (v) => Number(v), 7777)
  .option('--db <path>', 'SQLite path', defaultDbPath())
  .option('--detach', 'Fork into background and return; otherwise run in foreground.', false)
  .option('--force', 'Override a stale or running PID file.', false)
  .option('--log-format <fmt>', 'Log format: text (default) or json (newline-delimited JSON to stderr).', 'text')
  .action(async (opts: { port: number; db: string; detach: boolean; force: boolean; logFormat: string }) => {
    const logFormat = parseLogFormat(opts.logFormat);
    configureLogger({ format: logFormat });
    try {
      const result = await startDaemon({
        port: opts.port,
        db: opts.db,
        detach: opts.detach,
        force: opts.force,
        logFormat,
      });
      if (result.detached) {
        console.log(JSON.stringify({ ok: true, detached: true, pid: result.pid, port: opts.port, db: opts.db }, null, 2));
        process.exit(0);
      }
      // Foreground: startDaemon blocks; we won't reach here unless it returned synthetically.
    } catch (err) {
      console.error(`[cowire] daemon start failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

daemon
  .command('stop')
  .description('Send SIGTERM to the running daemon, fall back to SIGKILL after 10s.')
  .action(async () => {
    const result = await stopDaemon();
    if (result.pid === 0) {
      console.error('[cowire] no PID file found; nothing to stop');
      process.exit(1);
    }
    if (!result.stopped) {
      console.error(`[cowire] failed to stop daemon (pid ${result.pid})`);
      process.exit(1);
    }
    console.log(JSON.stringify({ ok: true, stopped: true, pid: result.pid }, null, 2));
  });

daemon
  .command('status')
  .description('Print daemon status (running PID, port, uptime, connected clients, event count).')
  .action(async () => {
    const status = await daemonStatus();
    console.log(JSON.stringify(status, null, 2));
    if (!status.running) process.exit(1);
  });

daemon
  .command('install')
  .description('Register the watchdog with the OS (schtasks on Windows, launchctl on macOS, systemd --user on Linux). Idempotent.')
  .action(async () => {
    try {
      const result = await installWatchdog();
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error(`[cowire] daemon install failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

daemon
  .command('uninstall')
  .description('Remove the watchdog registration from the OS scheduler.')
  .action(async () => {
    try {
      const result = await uninstallWatchdog();
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error(`[cowire] daemon uninstall failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

daemon
  .command('watchdog-status')
  .description('Show whether the watchdog is registered, whether it is currently running, last ping result and restart count.')
  .action(async () => {
    try {
      const result = await watchdogStatus();
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error(`[cowire] watchdog-status failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

daemon
  .command('restart')
  .description('Stop and start the daemon, preserving port/db from the previous run.')
  .action(async () => {
    try {
      const result = await restartDaemon();
      console.log(JSON.stringify({ ok: true, restarted: true, ...result }, null, 2));
    } catch (err) {
      console.error(`[cowire] daemon restart failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

registerStewardCli(program, defaultDbPath);
registerCredentialsCli(program, defaultDbPath);

program
  .command('shim')
  .description('Stdio↔SSE proxy: speak stdio to an MCP client, SSE to the Switch daemon.')
  .option(
    '-u, --url <url>',
    'Daemon SSE URL',
    process.env.COWIRE_DAEMON_URL ?? 'http://127.0.0.1:7777/mcp/sse',
  )
  .action(async (opts: { url: string }) => {
    const { runShim } = await import('./shim.js');
    await runShim({ url: opts.url, exitOnClose: true });
  });

program
  .command('connect-test')
  .description('Smoke-test the daemon: connect via SSE, emit a test event, subscribe, print received notifications.')
  .option('-u, --url <url>', 'Daemon SSE URL', 'http://127.0.0.1:7777/mcp/sse')
  .option('-w, --wait-ms <n>', 'How long to wait for notifications after emit (ms)', (v) => Number(v), 2000)
  .action(async (opts: { url: string; waitMs: number }) => {
    try {
      const result = await runConnectTest({ url: opts.url, waitMs: opts.waitMs });
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error(`[cowire] connect-test failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
