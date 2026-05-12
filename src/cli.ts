#!/usr/bin/env node
import { Command } from 'commander';
import { EventStore } from './persistence.js';
import { Broker } from './broker.js';
import { mountTransports } from './transports.js';
import { defaultDbPath } from './paths.js';

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
  .action(async (opts: { port: number; stdioOnly?: boolean; db: string }) => {
    const store = new EventStore();
    store.init(opts.db);
    const broker = new Broker(store);

    const transports = await mountTransports(broker, {
      port: opts.stdioOnly ? undefined : opts.port,
      stdioOnly: opts.stdioOnly,
    });

    const shutdown = async (sig: string) => {
      console.error(`[cowire] received ${sig}; shutting down`);
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

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
