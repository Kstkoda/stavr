import { Command } from 'commander';
import { EventStore } from './persistence.js';
import { computeUsage, fetchAnthropicBalance, type ComputeUsageOpts } from './usage.js';
import { defaultDbPath } from './paths.js';
import { readPidFile } from './daemon.js';

/**
 * Spec 50 Layer 1 — `stavr usage` CLI command.
 *
 * Three modes:
 *   - one-shot (default): print the pretty table once and exit.
 *   - --watch:            refresh every 5s with ANSI redraw.
 *   - --json:             print the raw aggregated JSON (one snapshot).
 *
 * Data source preference:
 *   1. If a daemon is running on the recorded port, fetch /usage live.
 *   2. Otherwise open the SQLite DB directly and compute locally.
 */
export function registerUsageCli(program: Command): void {
  program
    .command('usage')
    .description('Show token + cost usage rolled up from the event log.')
    .option('--window <w>', '1h, 6h, 24h, 7d', '24h')
    .option('--granularity <g>', 'minute, hour, day', 'hour')
    .option('--watch', 'Refresh every 5 seconds')
    .option('--json', 'Print raw JSON to stdout')
    .option('--db <path>', 'SQLite path (local fallback when daemon is down)', defaultDbPath())
    .action(async (opts: { window: string; granularity: string; watch?: boolean; json?: boolean; db: string }) => {
      const render = async (): Promise<void> => {
        const usage = (await fetchUsageSnapshot(opts)) as UsageShape;
        if (opts.json) {
          process.stdout.write(JSON.stringify(usage) + '\n');
        } else {
          process.stdout.write(prettyUsage(usage));
        }
      };
      if (!opts.watch) {
        await render();
        return;
      }
      // ANSI redraw loop. SIGINT exits cleanly.
      process.stdout.write('\x1b[?25l'); // hide cursor
      const cleanup = (): void => {
        process.stdout.write('\x1b[?25h'); // show cursor
        process.exit(0);
      };
      process.on('SIGINT', cleanup);
      // eslint-disable-next-line no-constant-condition
      while (true) {
        process.stdout.write('\x1b[2J\x1b[H'); // clear screen + cursor home
        await render();
        await new Promise<void>((r) => setTimeout(r, 5000));
      }
    });
}

async function fetchUsageSnapshot(opts: { window: string; granularity: string; db: string }) {
  const pid = readPidFile();
  if (pid && pid.port) {
    try {
      const res = await fetch(
        `http://127.0.0.1:${pid.port}/usage?window=${encodeURIComponent(opts.window)}&granularity=${encodeURIComponent(opts.granularity)}`,
        { signal: AbortSignal.timeout(5000) },
      );
      if (res.ok) return await res.json();
    } catch {
      // Fall through to local DB.
    }
  }
  const store = new EventStore();
  store.init(opts.db);
  const cOpts: ComputeUsageOpts = {
    window: opts.window as ComputeUsageOpts['window'],
    granularity: opts.granularity as ComputeUsageOpts['granularity'],
    apiBalance: await fetchAnthropicBalance(),
  };
  const usage = computeUsage(store, cOpts);
  store.close();
  return usage;
}

interface UsageShape {
  as_of: string;
  window: string;
  totals: { input_tokens: number; output_tokens: number; cost_usd: number; events: number };
  by_credential: Record<string, { cost_usd: number; events: number }>;
  by_model: Record<string, { cost_usd: number; input_tokens: number; output_tokens: number; events: number }>;
  burn_rate: { last_15_min_usd: number; projected_daily_usd: number };
  api_balance: { estimated_usd: number | null; source: string };
}

function prettyUsage(u: UsageShape): string {
  const lines: string[] = [];
  lines.push(`stavr usage   window=${u.window}   as_of=${u.as_of}`);
  lines.push('─'.repeat(70));
  lines.push(`  totals      cost_usd=${u.totals.cost_usd.toFixed(4)}   events=${u.totals.events}   in=${u.totals.input_tokens}  out=${u.totals.output_tokens}`);
  lines.push(`  burn_rate   15m=$${u.burn_rate.last_15_min_usd.toFixed(4)}   projected_daily=$${u.burn_rate.projected_daily_usd.toFixed(2)}`);
  const balance = u.api_balance.estimated_usd;
  lines.push(`  balance     ${balance !== null ? `$${balance.toFixed(2)}` : 'unknown'}   source=${u.api_balance.source}`);
  lines.push('');
  if (Object.keys(u.by_credential).length > 0) {
    lines.push('  by_credential');
    for (const [k, v] of Object.entries(u.by_credential)) {
      lines.push(`    ${k.padEnd(20)} $${v.cost_usd.toFixed(4)}  events=${v.events}`);
    }
  }
  if (Object.keys(u.by_model).length > 0) {
    lines.push('  by_model');
    for (const [k, v] of Object.entries(u.by_model)) {
      lines.push(
        `    ${k.padEnd(30)} $${v.cost_usd.toFixed(4)}  in=${v.input_tokens}  out=${v.output_tokens}`,
      );
    }
  }
  lines.push('');
  return lines.join('\n') + '\n';
}
