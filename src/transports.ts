import express, { type Request, type Response } from 'express';
import type { Server as HttpServer } from 'node:http';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { createSwitchServer } from './server.js';
import type { Broker } from './broker.js';
import { startupDecisionSweep } from './tools/decisions.js';
import { getLogger } from './log.js';

/**
 * Transport modes:
 *  - 'stdio'  : stdio transport only (for direct CC spawn / `cowire run`).
 *  - 'daemon' : HTTP/SSE only; binding the port is required (failure is fatal).
 *  - 'both'   : stdio + optional HTTP/SSE; EADDRINUSE falls back to stdio (back-compat for `cowire start`).
 */
export type TransportMode = 'stdio' | 'daemon' | 'both';

export interface TransportOpts {
  mode?: TransportMode;
  port?: number;
  /** Deprecated: prefer `mode`. Kept for `cowire start --stdio-only`. */
  stdioOnly?: boolean;
  silent?: boolean;
}

export interface MountedTransports {
  httpServer?: HttpServer;
  shutdown: () => Promise<void>;
  /** Live count of connected SSE sessions (daemon mode only). */
  sseSessionCount: () => number;
}

export async function mountTransports(
  broker: Broker,
  opts: TransportOpts,
): Promise<MountedTransports> {
  const logger = getLogger();
  const log = (m: string, metadata?: Record<string, unknown>) => {
    if (!opts.silent) logger.info(m, metadata);
  };

  // Resolve mode from explicit param or legacy `stdioOnly`.
  const mode: TransportMode = opts.mode ?? (opts.stdioOnly ? 'stdio' : 'both');

  const sweptCount = await startupDecisionSweep(broker);
  if (sweptCount > 0) log(`startup sweep expired ${sweptCount} stale decision(s)`);

  if (mode !== 'daemon') {
    const stdioHandle = createSwitchServer(broker);
    await stdioHandle.server.connect(new StdioServerTransport());
    log('stdio transport ready');
  }

  let httpServer: HttpServer | undefined;
  const sseSessions = new Map<string, SSEServerTransport>();

  const wantHttp = mode === 'daemon' || (mode === 'both' && opts.port !== undefined);
  if (wantHttp) {
    if (opts.port === undefined) throw new Error('port is required when mode includes HTTP/SSE');

    const app = express();
    app.use(express.json({ limit: '4mb' }));

    const daemonStartedAt = new Date();
    const version = process.env.COWIRE_VERSION ?? '0.1.0';

    // Deep health endpoint (spec 44 §3). Anything that flips `ok` to false makes
    // the response 503 so the watchdog (ADR-020) catches it and restarts us.
    app.get('/healthz', (_req, res) => {
      const dbReachable = broker.store.isReachable();
      const dbWritable = dbReachable && broker.store.isWritable();
      const reasons: string[] = [];
      if (!dbReachable) reasons.push('db_unreachable');
      else if (!dbWritable) reasons.push('db_readonly');

      const oneHourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
      const ok = reasons.length === 0;
      const body = {
        ok,
        version,
        started_at: daemonStartedAt.toISOString(),
        uptime_sec: Math.floor((Date.now() - daemonStartedAt.getTime()) / 1000),
        db: {
          reachable: dbReachable,
          writable: dbWritable,
        },
        broker: {
          connected_sessions: sseSessions.size,
          active_subscriptions: broker.subscriptionCount(),
        },
        decisions: {
          open_count: dbReachable ? broker.store.pendingDecisionCount() : 0,
          responded_last_hour: dbReachable ? broker.store.decisionsRespondedSince(oneHourAgo) : 0,
        },
        ...(reasons.length ? { reasons } : {}),
      };
      res.status(ok ? 200 : 503).json(body);
    });

    app.get('/status', (_req, res) => {
      res.json({
        ok: true,
        version,
        started_at: daemonStartedAt.toISOString(),
        events: broker.store.eventCount(),
        sse_sessions: sseSessions.size,
        pending_decisions: broker.store.pendingDecisionCount(),
      });
    });

    app.get('/mcp/sse', async (_req: Request, res: Response) => {
      const transport = new SSEServerTransport('/mcp/messages', res);
      const handle = createSwitchServer(broker);
      sseSessions.set(transport.sessionId, transport);
      res.on('close', () => {
        sseSessions.delete(transport.sessionId);
        broker.removeSession(handle.sessionId);
      });
      await handle.server.connect(transport);
      log(`SSE session ${transport.sessionId} connected`);
    });

    app.post('/mcp/messages', async (req: Request, res: Response) => {
      const sessionId = String(req.query.sessionId ?? '');
      const transport = sseSessions.get(sessionId);
      if (!transport) {
        res.status(404).json({ error: 'unknown session' });
        return;
      }
      await transport.handlePostMessage(req, res, req.body);
    });

    httpServer = await new Promise<HttpServer | undefined>((resolve, reject) => {
      const s = app.listen(opts.port!, '127.0.0.1', () => {
        log(`HTTP/SSE listening on 127.0.0.1:${opts.port}`);
        resolve(s);
      });
      s.on('error', (err: NodeJS.ErrnoException) => {
        if (mode === 'daemon') {
          // Daemon mode: bind failure is fatal — there's nothing else for us to do.
          reject(err);
          return;
        }
        // 'both' mode: legacy `cowire start` behaviour — degrade to stdio-only.
        if (err.code === 'EADDRINUSE') {
          log(
            `port ${opts.port} already in use; continuing with stdio-only ` +
              `(another Switch instance is probably holding it — this is expected when ` +
              `Cowork spawns multiple MCP sessions)`,
          );
        } else {
          log(`HTTP/SSE failed to start: ${err.message}; continuing with stdio-only`);
        }
        resolve(undefined);
      });
    });
  }

  const shutdown = async () => {
    if (httpServer) await new Promise<void>((r) => httpServer!.close(() => r()));
    for (const t of sseSessions.values()) await t.close().catch(() => {});
    broker.store.close();
  };

  return { httpServer, shutdown, sseSessionCount: () => sseSessions.size };
}
