import express, { type Request, type Response } from 'express';
import type { Server as HttpServer } from 'node:http';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { createSwitchServer } from './server.js';
import type { Broker } from './broker.js';
import { startupDecisionSweep } from './tools/decisions.js';

export interface TransportOpts {
  port?: number;
  stdioOnly?: boolean;
  silent?: boolean;
}

export interface MountedTransports {
  httpServer?: HttpServer;
  shutdown: () => Promise<void>;
}

export async function mountTransports(
  broker: Broker,
  opts: TransportOpts,
): Promise<MountedTransports> {
  const log = (m: string) => {
    if (!opts.silent) console.error(`[cowire] ${m}`);
  };

  const sweptCount = await startupDecisionSweep(broker);
  if (sweptCount > 0) log(`startup sweep expired ${sweptCount} stale decision(s)`);

  const stdioHandle = createSwitchServer(broker);
  await stdioHandle.server.connect(new StdioServerTransport());
  log('stdio transport ready');

  let httpServer: HttpServer | undefined;
  const sseSessions = new Map<string, SSEServerTransport>();

  if (!opts.stdioOnly && opts.port) {
    const app = express();
    app.use(express.json({ limit: '4mb' }));

    app.get('/healthz', (_req, res) => {
      res.json({ ok: true, events: broker.store.eventCount() });
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

    httpServer = await new Promise<HttpServer>((resolve) => {
      const s = app.listen(opts.port!, () => {
        log(`HTTP/SSE listening on :${opts.port}`);
        resolve(s);
      });
    });
  }

  const shutdown = async () => {
    if (httpServer) await new Promise<void>((r) => httpServer!.close(() => r()));
    for (const t of sseSessions.values()) await t.close().catch(() => {});
    broker.store.close();
  };

  return { httpServer, shutdown };
}
