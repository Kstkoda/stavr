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
  startDaemonForeground,
  stopDaemon,
} from './daemon.js';
import { runConnectTest } from './connect-test.js';
import { configureLogger, parseLogFormat } from './log.js';
import {
  installWatchdog,
  uninstallWatchdog,
  watchdogStatus,
} from './watchdog-install.js';
import { registerStewardCli, registerDaemonStewardCli } from './steward/cli.js';
import { registerCredentialsCli } from './credentials/cli.js';
import { registerUsageCli } from './usage-cli.js';
import { registerAskCli } from './steward-ask-cli.js';
import {
  DEFAULT_CONFIG,
  checkBindAuthGate,
  defaultConfigPath,
  loadConfig,
  resolveBind,
  type StavrConfig,
} from './config.js';
import { registerStewardBugFixCli } from './steward-bug-fix-cli.js';
import { ActorPermissionStore } from './security/actor-permissions.js';
import { CapabilityOverrideStore } from './security/capability-overrides.js';
import {
  buildPermissionsYaml,
  defaultPermissionsYamlPath,
  importPermissionsYaml,
  permissionsYamlString,
  writePermissionsYaml,
} from './security/policies-yaml.js';
import { TIERS as PERMISSION_TIERS, type Tier } from './tools/categories.js';
import { readFileSync, writeFileSync } from 'node:fs';

interface ResolvedCliBind {
  bindHost: string;
  requireAuthWhenNonLocal: boolean;
  effectiveConfig: StavrConfig;
  configPath: string;
  configSource: 'file' | 'defaults';
}

function resolveBindFromCli(args: {
  configPath?: string;
  bindHostOverride?: string;
  allowNonLocalWithoutAuth: boolean;
  /** Spec 52 A2: whether any paired devices exist. Defaults to false (A1 behaviour). */
  authConfigured?: boolean;
}): ResolvedCliBind {
  const loaded = loadConfig(args.configPath);
  const requireAuthWhenNonLocal = args.allowNonLocalWithoutAuth
    ? false
    : loaded.config.network.require_auth_when_non_local;
  const spec = args.bindHostOverride ?? loaded.config.network.bind;
  const resolved = resolveBind(spec);
  if (resolved.mode === 'tailscale') {
    throw new Error(
      "network.bind: 'tailscale' is reserved for spec 52 A3 (tailscale transport adapter), " +
        'which is not yet in this build. Pick `localhost`, `lan`, or an explicit address.',
    );
  }
  const refusal = checkBindAuthGate({
    resolved,
    requireAuthWhenNonLocal,
    authConfigured: args.authConfigured ?? false,
  });
  if (refusal) throw new Error(refusal);
  return {
    bindHost: resolved.host,
    requireAuthWhenNonLocal,
    effectiveConfig: { ...loaded.config, network: { ...loaded.config.network, bind: args.bindHostOverride ?? loaded.config.network.bind } },
    configPath: loaded.path,
    configSource: loaded.source,
  };
}

const program = new Command();
program
  .name('stavr')
  .description('Stavr (Switch) — MCP-native broker between Co, CC, and user channels')
  .version('0.1.0');

program
  .command('start')
  .description(
    'Start Stavr. Without --stdio-only this is equivalent to "stavr daemon start" ' +
      '(full daemon wire-up: memory poller, retention scheduler, worker watchdog, steward, v0.2 subsystem). ' +
      'Use --stdio-only for a lightweight stdio MCP transport with no HTTP and no daemon services.',
  )
  .option('-p, --port <port>', 'HTTP/SSE port', (v) => Number(v), 7777)
  .option('--stdio-only', 'Disable HTTP/SSE transport (stdio MCP only, no daemon wire-up).')
  .option('--db <path>', 'SQLite path', defaultDbPath())
  .option('--log-format <fmt>', 'Log format: text (default) or json (newline-delimited JSON to stderr).', 'text')
  .option('--config <path>', 'Stavr config file (default ~/.stavr/stavr.yaml).')
  .option('--bind-host <host>', 'Override network.bind from config (localhost|lan|tailscale|<host>[:port]).')
  .option(
    '--allow-non-local-without-auth',
    'Override network.require_auth_when_non_local from config (escape hatch).',
    false,
  )
  .option('--force', 'Override a stale or running PID file (non-stdio mode only).', false)
  .action(
    async (opts: {
      port: number;
      stdioOnly?: boolean;
      db: string;
      logFormat: string;
      config?: string;
      bindHost?: string;
      allowNonLocalWithoutAuth?: boolean;
      force?: boolean;
    }) => {
      const logFormat = parseLogFormat(opts.logFormat);
      const logger = configureLogger({ format: logFormat });

      // 2026-05-16 — non-stdio `stavr start` now delegates to the same wire-up
      // as `stavr daemon start`. The historical lighter path (mount transports
      // only) silently skipped the memory poller and retention scheduler, which
      // is the bug that hid the OOM leak-hunt fix when invoked via `npm start`.
      // See proposed/bom-cli-start-unify.md and ADR-030.
      if (!opts.stdioOnly) {
        try {
          // Compute authConfigured before binding — spec 52 A2 lets the auth gate
          // open as soon as at least one device is paired. Open the DB just for
          // the count, then close it so startDaemonForeground can open it fresh.
          const probe = new EventStore();
          probe.init(opts.db);
          const authConfigured = probe.countActiveDevices() > 0;
          probe.close();
          const { bindHost, requireAuthWhenNonLocal } = resolveBindFromCli({
            configPath: opts.config,
            bindHostOverride: opts.bindHost,
            allowNonLocalWithoutAuth: !!opts.allowNonLocalWithoutAuth,
            authConfigured,
          });
          await startDaemonForeground({
            port: opts.port,
            db: opts.db,
            detach: false,
            force: !!opts.force,
            logFormat,
            bindHost,
            requireAuthWhenNonLocal,
            authConfigured,
          });
          // startDaemonForeground installs its own SIGINT/SIGTERM handlers and
          // returns once HTTP is listening; block until the signal handler
          // exits the process.
          await new Promise(() => {});
          return;
        } catch (err) {
          console.error(`[stavr] start failed: ${(err as Error).message}`);
          process.exit(1);
        }
      }

      // --stdio-only: legitimately lighter path. No HTTP, no daemon services.
      const store = new EventStore();
      store.init(opts.db);
      const broker = new Broker(store);
      const transports = await mountTransports(broker, {
        mode: 'stdio',
        authConfigured: store.countActiveDevices() > 0,
      });

      const shutdown = async (sig: string) => {
        logger.info('shutting down', { signal: sig });
        await transports.shutdown();
        process.exit(0);
      };
      process.on('SIGINT', () => void shutdown('SIGINT'));
      process.on('SIGTERM', () => void shutdown('SIGTERM'));
    },
  );

const config = program.command('config').description('Stavr configuration utilities.');

config
  .command('show')
  .description('Print the effective stavr configuration (defaults merged with overrides).')
  .option('--config <path>', 'Path to config file (default ~/.stavr/stavr.yaml).')
  .option('--bind-host <host>', 'Override network.bind for this preview only.')
  .option('--allow-non-local-without-auth', 'Override network.require_auth_when_non_local.', false)
  .action((opts: { config?: string; bindHost?: string; allowNonLocalWithoutAuth?: boolean }) => {
    try {
      const loaded = loadConfig(opts.config);
      const requireAuth = opts.allowNonLocalWithoutAuth
        ? false
        : loaded.config.network.require_auth_when_non_local;
      const bindSpec = opts.bindHost ?? loaded.config.network.bind;
      const resolved = resolveBind(bindSpec);
      const refusal = checkBindAuthGate({
        resolved,
        requireAuthWhenNonLocal: requireAuth,
        authConfigured: false,
      });
      const out = {
        config_path: loaded.path,
        config_source: loaded.source,
        defaults: DEFAULT_CONFIG,
        effective: {
          network: {
            bind: bindSpec,
            require_auth_when_non_local: requireAuth,
          },
        },
        resolved_bind: {
          host: resolved.host,
          port: resolved.port,
          mode: resolved.mode,
          is_loopback: resolved.is_loopback,
        },
        auth_gate: refusal
          ? { would_refuse: true, reason: refusal }
          : { would_refuse: false },
        default_config_path: defaultConfigPath(),
      };
      console.log(JSON.stringify(out, null, 2));
    } catch (err) {
      console.error(`[stavr] config show failed: ${(err as Error).message}`);
      process.exit(1);
    }
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
  .description('Start the Switch daemon. Bind defaults to 127.0.0.1 (ADR-006); override via ~/.stavr/stavr.yaml or --bind-host.')
  .option('-p, --port <port>', 'HTTP/SSE port', (v) => Number(v), 7777)
  .option('--db <path>', 'SQLite path', defaultDbPath())
  .option('--detach', 'Fork into background and return; otherwise run in foreground.', false)
  .option('--force', 'Override a stale or running PID file.', false)
  .option('--log-format <fmt>', 'Log format: text (default) or json (newline-delimited JSON to stderr).', 'text')
  .option('--config <path>', 'Stavr config file (default ~/.stavr/stavr.yaml).')
  .option('--bind-host <host>', 'Override network.bind from config (localhost|lan|tailscale|<host>[:port]).')
  .option(
    '--allow-non-local-without-auth',
    'Override network.require_auth_when_non_local from config (escape hatch).',
    false,
  )
  .action(
    async (opts: {
      port: number;
      db: string;
      detach: boolean;
      force: boolean;
      logFormat: string;
      config?: string;
      bindHost?: string;
      allowNonLocalWithoutAuth?: boolean;
    }) => {
      const logFormat = parseLogFormat(opts.logFormat);
      configureLogger({ format: logFormat });
      try {
        // Compute authConfigured before binding — spec 52 A2 lets the auth gate
        // open as soon as at least one device is paired. Open the DB just for
        // the count, then close it so the daemon child can open it fresh.
        const probe = new EventStore();
        probe.init(opts.db);
        const authConfigured = probe.countActiveDevices() > 0;
        probe.close();
        const { bindHost, requireAuthWhenNonLocal } = resolveBindFromCli({
          configPath: opts.config,
          bindHostOverride: opts.bindHost,
          allowNonLocalWithoutAuth: !!opts.allowNonLocalWithoutAuth,
          authConfigured,
        });
        const result = await startDaemon({
          port: opts.port,
          db: opts.db,
          detach: opts.detach,
          force: opts.force,
          logFormat,
          bindHost,
          requireAuthWhenNonLocal,
          authConfigured,
        });
        if (result.detached) {
          console.log(
            JSON.stringify(
              { ok: true, detached: true, pid: result.pid, port: opts.port, db: opts.db, bind_host: bindHost },
              null,
              2,
            ),
          );
          process.exit(0);
        }
        // Foreground: startDaemon blocks; we won't reach here unless it returned synthetically.
      } catch (err) {
        console.error(`[stavr] daemon start failed: ${(err as Error).message}`);
        process.exit(1);
      }
    },
  );

daemon
  .command('stop')
  .description('Send SIGTERM to the running daemon, fall back to SIGKILL after 10s.')
  .action(async () => {
    const result = await stopDaemon();
    if (result.pid === 0) {
      console.error('[stavr] no PID file found; nothing to stop');
      process.exit(1);
    }
    if (!result.stopped) {
      console.error(`[stavr] failed to stop daemon (pid ${result.pid})`);
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
      console.error(`[stavr] daemon install failed: ${(err as Error).message}`);
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
      console.error(`[stavr] daemon uninstall failed: ${(err as Error).message}`);
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
      console.error(`[stavr] watchdog-status failed: ${(err as Error).message}`);
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
      console.error(`[stavr] daemon restart failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

registerStewardCli(program, defaultDbPath);
registerCredentialsCli(program, defaultDbPath);
registerDaemonStewardCli(program);
registerUsageCli(program);
registerAskCli(program);
registerStewardBugFixCli(program);

program
  .command('tail')
  .description('Stream live events from the daemon, with optional replay and filtering.')
  .option('-u, --url <url>', 'Daemon base URL', process.env.STAVR_DAEMON_URL?.replace(/\/mcp\/sse.*$/, '') ?? 'http://127.0.0.1:7777')
  .option('--since <duration>', 'Replay events from the last duration (e.g. 5m, 1h, 30s).')
  .option('--since-id <id>', 'Replay events since this event ID.')
  .option('--kind <kinds>', 'Comma-separated event kinds to show (e.g. worker_log,worker_stuck).')
  .option('--worker <name>', 'Filter to events from a specific worker name.')
  .option('--source-agent <name>', 'Filter to events from a specific source agent.')
  .option('--no-color', 'Disable color output.')
  .option('--json', 'Output raw JSON instead of formatted text.')
  .action(async (opts: {
    url: string;
    since?: string;
    sinceId?: string;
    kind?: string;
    worker?: string;
    sourceAgent?: string;
    color: boolean;
    json?: boolean;
  }) => {
    const { runTail } = await import('./tail.js');
    const ac = new AbortController();
    process.on('SIGINT', () => ac.abort());
    process.on('SIGTERM', () => ac.abort());
    try {
      await runTail(
        {
          url: opts.url,
          since: opts.since,
          sinceId: opts.sinceId,
          kinds: opts.kind ? opts.kind.split(',') : undefined,
          worker: opts.worker,
          sourceAgent: opts.sourceAgent,
          noColor: !opts.color,
          json: opts.json,
          signal: ac.signal,
        },
        (line) => console.log(line),
      );
    } catch (err) {
      if (!ac.signal.aborted) {
        console.error(`[stavr] tail: ${(err as Error).message}`);
        process.exit(1);
      }
    }
  });

program
  .command('shim')
  .description('Stdio↔HTTP proxy: speak stdio to an MCP client, Streamable HTTP to the Switch daemon.')
  .option(
    '-u, --url <url>',
    'Daemon MCP URL',
    process.env.STAVR_DAEMON_URL ?? 'http://127.0.0.1:7777/mcp',
  )
  .action(async (opts: { url: string }) => {
    const { runShim } = await import('./shim.js');
    await runShim({ url: opts.url, exitOnClose: true });
  });

program
  .command('connect-test')
  .description('Smoke-test the daemon: connect via Streamable HTTP, emit a test event, subscribe, print received notifications.')
  .option('-u, --url <url>', 'Daemon MCP URL', 'http://127.0.0.1:7777/mcp')
  .option('-w, --wait-ms <n>', 'How long to wait for notifications after emit (ms)', (v) => Number(v), 2000)
  .action(async (opts: { url: string; waitMs: number }) => {
    try {
      const result = await runConnectTest({ url: opts.url, waitMs: opts.waitMs });
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error(`[stavr] connect-test failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

// ---- Spec 52 A2 — pairing + devices ----

const pair = program.command('pair').description('Pair a remote device with this daemon (spec 52 A2).');

pair
  .command('bootstrap')
  .description('On the daemon host: open a pairing window. Prints a 6-digit code valid for 5 minutes.')
  .option('-u, --daemon-url <url>', 'Daemon base URL (loopback-only callable).', 'http://127.0.0.1:7777')
  .action(async (opts: { daemonUrl: string }) => {
    try {
      const res = await fetch(opts.daemonUrl.replace(/\/$/, '') + '/pair/initiate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        console.error(`[stavr] pair bootstrap failed: ${res.status} ${txt}`);
        process.exit(1);
      }
      const body = (await res.json()) as { code: string; expires_at: string };
      console.log(
        JSON.stringify(
          {
            ok: true,
            code: body.code,
            expires_at: body.expires_at,
            instructions:
              'Run `stavr pair remote-host --daemon-url <addr> --code ' +
              body.code +
              ' --name <device-name>` on the new device.',
          },
          null,
          2,
        ),
      );
    } catch (err) {
      console.error(`[stavr] pair bootstrap failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

pair
  .command('remote-host')
  .description('On the new device: exchange the pairing code for a long-term token.')
  .requiredOption('-u, --daemon-url <url>', 'Daemon base URL the new device should reach (e.g. http://nas.local:7777).')
  .requiredOption('-c, --code <code>', '6-digit code printed by `stavr pair bootstrap` on the daemon side.')
  .requiredOption('-n, --name <name>', 'Human-readable name for this device (e.g. kenneth-laptop).')
  .action(async (opts: { daemonUrl: string; code: string; name: string }) => {
    try {
      const { upsertPairing, devicesFilePath } = await import('./devices-storage.js');
      const base = opts.daemonUrl.replace(/\/$/, '');
      const res = await fetch(base + '/pair/complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: opts.code, device_name: opts.name }),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        console.error(`[stavr] pair remote-host failed: ${res.status} ${txt}`);
        process.exit(1);
      }
      const body = (await res.json()) as {
        device_id: string;
        device_name: string;
        paired_at: string;
        token: string;
      };
      upsertPairing({
        daemon_url: base,
        device_id: body.device_id,
        device_name: body.device_name,
        token: body.token,
        paired_at: body.paired_at,
      });
      console.log(
        JSON.stringify(
          {
            ok: true,
            device_id: body.device_id,
            device_name: body.device_name,
            paired_at: body.paired_at,
            saved_to: devicesFilePath(),
          },
          null,
          2,
        ),
      );
    } catch (err) {
      console.error(`[stavr] pair remote-host failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

const devices = program.command('devices').description('Manage paired devices (spec 52 A2).');

devices
  .command('list')
  .description('List paired devices on this daemon.')
  .option('--db <path>', 'SQLite path', defaultDbPath())
  .option('--include-revoked', 'Include revoked devices in the output.', false)
  .action((opts: { db: string; includeRevoked?: boolean }) => {
    const store = new EventStore();
    store.init(opts.db);
    try {
      const all = store.listDevices({ activeOnly: !opts.includeRevoked });
      // Never leak token hashes via the CLI — they're not secret but operators
      // shouldn't get used to seeing them in unrelated terminals.
      const safe = all.map((d) => ({
        id: d.id,
        name: d.name,
        paired_at: d.paired_at,
        paired_from_ip: d.paired_from_ip,
        revoked_at: d.revoked_at,
      }));
      console.log(JSON.stringify({ devices: safe }, null, 2));
    } finally {
      store.close();
    }
  });

devices
  .command('show <id>')
  .description('Show details for one paired device.')
  .option('--db <path>', 'SQLite path', defaultDbPath())
  .action((id: string, opts: { db: string }) => {
    const store = new EventStore();
    store.init(opts.db);
    try {
      const d = store.getDevice(id);
      if (!d) {
        console.error(`[stavr] no device with id ${id}`);
        process.exit(1);
      }
      console.log(
        JSON.stringify(
          {
            id: d.id,
            name: d.name,
            paired_at: d.paired_at,
            paired_from_ip: d.paired_from_ip,
            revoked_at: d.revoked_at,
          },
          null,
          2,
        ),
      );
    } finally {
      store.close();
    }
  });

devices
  .command('revoke <id>')
  .description('Revoke a paired device. Future requests carrying its token return 401.')
  .option('--db <path>', 'SQLite path', defaultDbPath())
  .action(async (id: string, opts: { db: string }) => {
    const store = new EventStore();
    store.init(opts.db);
    try {
      const before = store.getDevice(id);
      if (!before) {
        console.error(`[stavr] no device with id ${id}`);
        process.exit(1);
      }
      if (before.revoked_at) {
        console.error(`[stavr] device ${id} already revoked at ${before.revoked_at}`);
        process.exit(1);
      }
      const revokedAt = new Date().toISOString();
      const changed = store.revokeDevice(id, revokedAt);
      if (!changed) {
        console.error(`[stavr] failed to revoke device ${id}`);
        process.exit(1);
      }
      // Best-effort event emission — the CLI is talking to the DB directly,
      // not through the daemon, so subscribers only see this on next replay.
      try {
        const broker = new Broker(store);
        await broker.publish({
          kind: 'device_revoked',
          at: revokedAt,
          source_agent: 'stavr-cli',
          payload: { device_id: id, device_name: before.name },
        });
      } catch {
        /* DB-only revocation still succeeded */
      }
      console.log(JSON.stringify({ ok: true, device_id: id, revoked_at: revokedAt }, null, 2));
    } finally {
      store.close();
    }
  });

// ---- permissions subcommands (v0.6.9 P7) ----
//
// CLI surface for the permissions matrix + Layer 0 overrides. Reads /
// writes the DB directly — operators should stop the daemon first when
// running `import` / `set` to avoid racing with the dashboard mutator.
// `export` and `show` are safe to run live (read-only).

const permissions = program
  .command('permissions')
  .description('Inspect + manage the per-actor permissions matrix and Layer 0 capability overrides.');

interface PermissionsStores {
  store: EventStore;
  caps: CapabilityOverrideStore;
  perms: ActorPermissionStore;
}

function openPermissionsStores(dbPath: string): PermissionsStores {
  const store = new EventStore();
  store.init(dbPath);
  const db = (store as unknown as { db: import('better-sqlite3').Database }).db;
  if (!db) {
    store.close();
    throw new Error('permissions CLI requires direct DB access — EventStore did not expose .db');
  }
  return {
    store,
    caps: new CapabilityOverrideStore(db),
    perms: new ActorPermissionStore(db),
  };
}

permissions
  .command('export')
  .description('Write the current matrix + Layer 0 overrides to a YAML file.')
  .option('--db <path>', 'SQLite path', defaultDbPath())
  .option('--out <path>', 'Output path (default ~/.stavr/permissions.yaml).')
  .option('--stdout', 'Write YAML to stdout instead of a file.', false)
  .action((opts: { db: string; out?: string; stdout?: boolean }) => {
    const { store, caps, perms } = openPermissionsStores(opts.db);
    try {
      const doc = buildPermissionsYaml({ caps, perms });
      const text = permissionsYamlString(doc);
      if (opts.stdout) {
        process.stdout.write(text);
      } else {
        const path = opts.out ?? defaultPermissionsYamlPath();
        writeFileSync(path, text, { encoding: 'utf8', mode: 0o600 });
        console.log(`[stavr] wrote ${path}`);
      }
    } finally {
      store.close();
    }
  });

permissions
  .command('import')
  .description('Apply a YAML permissions document onto the local DB. Additive — does not delete unmentioned rows.')
  .argument('<path>', 'Path to permissions YAML file.')
  .option('--db <path>', 'SQLite path', defaultDbPath())
  .option('--set-by <name>', 'Operator identifier recorded on every write.', 'cli')
  .action((path: string, opts: { db: string; setBy: string }) => {
    const yaml = readFileSync(path, 'utf8');
    const { store, caps, perms } = openPermissionsStores(opts.db);
    try {
      const result = importPermissionsYaml({ caps, perms, setBy: opts.setBy, yaml });
      console.log(
        JSON.stringify(
          {
            ok: true,
            path,
            capability_rows_written: result.capabilityRowsWritten,
            actor_rows_written: result.actorRowsWritten,
            warnings: result.warnings,
          },
          null,
          2,
        ),
      );
    } finally {
      store.close();
    }
  });

permissions
  .command('show')
  .description('Print the current matrix as YAML (no file written).')
  .option('--db <path>', 'SQLite path', defaultDbPath())
  .action((opts: { db: string }) => {
    const { store, caps, perms } = openPermissionsStores(opts.db);
    try {
      process.stdout.write(permissionsYamlString(buildPermissionsYaml({ caps, perms })));
    } finally {
      store.close();
    }
  });

permissions
  .command('set')
  .description('Set a single (actor, tool) tier in the matrix.')
  .argument('<actor>', 'Actor id (e.g. cowork-claude, steward, operator).')
  .argument('<tool>', 'Tool id (e.g. worker_spawn, host_exec).')
  .argument('<tier>', `Tier — one of: ${PERMISSION_TIERS.join(', ')}`)
  .option('--db <path>', 'SQLite path', defaultDbPath())
  .option('--set-by <name>', 'Operator identifier recorded on the row.', 'cli')
  .action((actor: string, tool: string, tier: string, opts: { db: string; setBy: string }) => {
    if (!(PERMISSION_TIERS as readonly string[]).includes(tier)) {
      console.error(`[stavr] unknown tier "${tier}" — expected one of ${PERMISSION_TIERS.join(', ')}`);
      process.exit(2);
    }
    const { store, perms } = openPermissionsStores(opts.db);
    try {
      perms.set(actor, tool, tier as Tier, opts.setBy);
      console.log(JSON.stringify({ ok: true, actor_id: actor, tool_id: tool, tier }, null, 2));
    } finally {
      store.close();
    }
  });

// Suppress unused-import warning if writePermissionsYaml is otherwise
// only re-exported but not yet used in this file.
void writePermissionsYaml;

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
