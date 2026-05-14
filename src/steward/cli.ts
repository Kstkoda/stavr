import { Command } from 'commander';
import { EventStore } from '../persistence.js';
import { StewardStore } from './store.js';
import { ensureStewardMemoryDir } from './tools.js';
import {
  NoActiveStewardError,
  StewardAlreadyClaimedError,
  StewardTokenInvalidError,
} from './types.js';
import { restartDaemon } from '../daemon.js';
import { loadStewardConfig } from './config.js';

/**
 * `stavr steward` CLI commands (spec 48 Layer 1).
 *
 * Direct DB access (matches the pattern used by `stavr status` / `stavr events`).
 * For the chat-surface claim flow, callers use `mcp__stavr__steward_claim` instead;
 * this CLI is the User\'s authoritative path for token minting, force-release, and
 * audit visibility.
 */
export function registerStewardCli(program: Command, defaultDbPath: () => string): void {
  const steward = program.command('steward').description('Steward role management (spec 48 Layer 1).');

  steward
    .command('mint-token')
    .description('Mint a one-shot claim token (30-minute TTL). Paste into a chat surface to authorize Steward claim.')
    .option('--ttl-min <n>', 'Token TTL in minutes (default 30)', (v) => Number(v), 30)
    .option('--db <path>', 'SQLite path', defaultDbPath())
    .action((opts: { ttlMin: number; db: string }) => {
      const store = new EventStore();
      store.init(opts.db);
      const sStore = new StewardStore(store);
      const tok = sStore.mintClaimToken({ ttlMs: opts.ttlMin * 60 * 1000 });
      console.log(JSON.stringify(tok, null, 2));
      store.close();
    });

  steward
    .command('status')
    .description('Print active Steward (if any) and recent sessions.')
    .option('--limit <n>', 'Number of recent sessions to include', (v) => Number(v), 10)
    .option('--db <path>', 'SQLite path', defaultDbPath())
    .action((opts: { limit: number; db: string }) => {
      const store = new EventStore();
      store.init(opts.db);
      const sStore = new StewardStore(store);
      const active = sStore.getActiveSteward();
      const recent = sStore.listStewards({ limit: opts.limit });
      console.log(JSON.stringify({ active, recent }, null, 2));
      store.close();
    });

  steward
    .command('claim')
    .description('Claim the Steward role directly from the CLI (bypasses the MCP-tool gate). Mostly for testing.')
    .requiredOption('--token <t>', 'Claim token from `stavr steward mint-token`.')
    .requiredOption('--client-id <id>', 'Client identifier (e.g. "cowork-chat").')
    .requiredOption('--user-id <id>', 'User identifier (e.g. "kenneth").')
    .option('--display-name <name>', 'Human-readable Steward name.')
    .option('--model <m>', 'LLM model id, e.g. claude-opus-4-7.')
    .option('--provider <p>', 'Provider id, e.g. anthropic.')
    .option('--db <path>', 'SQLite path', defaultDbPath())
    .action((opts: {
      token: string;
      clientId: string;
      userId: string;
      displayName?: string;
      model?: string;
      provider?: string;
      db: string;
    }) => {
      const store = new EventStore();
      store.init(opts.db);
      const sStore = new StewardStore(store);
      try {
        const rec = sStore.claim(opts.token, {
          client_id: opts.clientId,
          user_id: opts.userId,
          display_name: opts.displayName,
          model: opts.model,
          provider: opts.provider,
        });
        const memory_path = ensureStewardMemoryDir(rec.id);
        console.log(JSON.stringify({ ok: true, steward: rec, memory_path }, null, 2));
      } catch (err) {
        const code =
          err instanceof StewardAlreadyClaimedError
            ? 'STEWARD_ALREADY_CLAIMED'
            : err instanceof StewardTokenInvalidError
              ? 'STEWARD_TOKEN_INVALID'
              : 'STEWARD_CLAIM_FAILED';
        console.error(JSON.stringify({ ok: false, code, message: (err as Error).message }, null, 2));
        process.exit(1);
      } finally {
        store.close();
      }
    });

  steward
    .command('release')
    .description('Force-release the active Steward (User authoritative override).')
    .option('--reason <r>', 'Free-text reason for the release.')
    .option('--db <path>', 'SQLite path', defaultDbPath())
    .action((opts: { reason?: string; db: string }) => {
      const store = new EventStore();
      store.init(opts.db);
      const sStore = new StewardStore(store);
      try {
        const rec = sStore.release(opts.reason);
        console.log(JSON.stringify({ ok: true, steward: rec }, null, 2));
      } catch (err) {
        if (err instanceof NoActiveStewardError) {
          console.error(JSON.stringify({ ok: false, code: 'NO_ACTIVE_STEWARD' }, null, 2));
          process.exit(1);
        }
        throw err;
      } finally {
        store.close();
      }
    });

  steward
    .command('transfer')
    .description('Hand off the active Steward role to a new client_id atomically.')
    .requiredOption('--token <t>', 'Fresh claim token for the new Steward.')
    .requiredOption('--client-id <id>', 'New Steward client identifier.')
    .requiredOption('--user-id <id>', 'User identifier (e.g. "kenneth").')
    .option('--display-name <name>', 'Human-readable new Steward name.')
    .option('--model <m>', 'LLM model id.')
    .option('--provider <p>', 'Provider id.')
    .option('--db <path>', 'SQLite path', defaultDbPath())
    .action((opts: {
      token: string;
      clientId: string;
      userId: string;
      displayName?: string;
      model?: string;
      provider?: string;
      db: string;
    }) => {
      const store = new EventStore();
      store.init(opts.db);
      const sStore = new StewardStore(store);
      try {
        const { from, to } = sStore.transfer(opts.token, {
          client_id: opts.clientId,
          user_id: opts.userId,
          display_name: opts.displayName,
          model: opts.model,
          provider: opts.provider,
        });
        const memory_path = ensureStewardMemoryDir(to.id);
        console.log(JSON.stringify({ ok: true, from, to, memory_path }, null, 2));
      } catch (err) {
        const code =
          err instanceof NoActiveStewardError
            ? 'NO_ACTIVE_STEWARD'
            : err instanceof StewardTokenInvalidError
              ? 'STEWARD_TOKEN_INVALID'
              : 'STEWARD_TRANSFER_FAILED';
        console.error(JSON.stringify({ ok: false, code, message: (err as Error).message }, null, 2));
        process.exit(1);
      } finally {
        store.close();
      }
    });
}

/**
 * Spec 49 Layer 1 — `stavr daemon-steward` CLI surface for the daemon-hosted Steward subprocess.
 *
 * Note: registered under `daemon-steward` (not `steward`) to avoid a Commander.js name
 * collision with the spec-48 Layer 1 commands above. v1 only ships `restart` and
 * `daemon-status` (best-effort, reading the config + daemon state). A future
 * follow-up will fold these subcommands into a unified `steward` namespace.
 */
export function registerDaemonStewardCli(program: Command): void {
  const steward = program.command('daemon-steward').description('Manage the daemon-hosted Steward subprocess (spec 49).');

  steward
    .command('restart')
    .description('Restart the daemon, which respawns the Steward subprocess from steward-config.yaml.')
    .action(async () => {
      try {
        const result = await restartDaemon();
        console.log(JSON.stringify({ ok: true, ...result }, null, 2));
      } catch (err) {
        console.error(`[stavr] daemon-steward restart failed: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  steward
    .command('status')
    .description('Show the steward-config.yaml resolution and whether the Steward subprocess should be running.')
    .action(() => {
      const cfg = loadStewardConfig();
      console.log(
        JSON.stringify(
          {
            config_path: cfg.path,
            enabled: cfg.config?.steward.enabled ?? false,
            provider: cfg.config?.steward.provider,
            model: cfg.config?.steward.model,
            display_name: cfg.config?.steward.display_name,
            credential_id: cfg.config?.steward.credential_id,
            daily_budget_usd: cfg.config?.steward.budget.daily_usd,
            error: cfg.error,
          },
          null,
          2,
        ),
      );
    });
}
