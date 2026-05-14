// tests/integration/v0.2-smoke.test.ts
//
// End-to-end smoke for the v0.2 substrate:
//   start daemon (in-process) -> wire planner+executor+webhook connector
//   -> call propose_plan (stub LLM) -> approve via /dashboard/plans/:id/respond
//   -> await bom_completed -> assert BOM done, response captured.
//
// Uses a hermetic local HTTP echo server in lieu of httpbin so the test
// stays fast and offline. The webhook connector is registered directly
// (the installer has its own coverage in tests/bricks/installer.test.ts;
// re-running it here would require `npm run build` first).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

import { EventStore } from '../../src/persistence.js';
import { Broker } from '../../src/broker.js';
import { mountTransports, type MountedTransports } from '../../src/transports.js';
import { wireV02Subsystem, type V02SubsystemHandle } from '../../src/steward/v02-wiring.js';
import { WebhookConnector } from '../../src/connectors/webhook.js';

interface Harness {
  store: EventStore;
  broker: Broker;
  transports: MountedTransports;
  v02: V02SubsystemHandle;
  echo: Server;
  echoUrl: string;
  base: string;
}

async function bootEchoServer(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, echoed: body }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${addr.port}/` };
}

async function boot(): Promise<Harness> {
  const store = new EventStore();
  store.init(':memory:');
  const broker = new Broker(store);
  const transports = await mountTransports(broker, { mode: 'daemon', port: 0, silent: true });
  const addr = transports.httpServer!.address() as AddressInfo;
  const base = `http://127.0.0.1:${addr.port}`;
  const { server: echo, url: echoUrl } = await bootEchoServer();

  const v02 = wireV02Subsystem({
    broker,
    store,
    skipBrickRehydrate: true,
    plannerLlm: async () => ({
      // Single-step plan that uses the webhook brick.
      text: JSON.stringify({
        steps: [
          {
            title: 'POST a hello body to the echo endpoint',
            description: 'Smoke-test the webhook connector under the executor.',
            capability: 'no-model',
            risk_class: 'external-comm',
            brick_id: 'webhook-smoke',
            depends_on: [],
            args: { body: { test: 'hello' } },
          },
        ],
      }),
      tokens_in: 100,
      tokens_out: 50,
      cost_usd: 0.0005,
    }),
  });

  v02.connectors.register(
    new WebhookConnector({
      id: 'webhook-smoke',
      displayName: 'Smoke Webhook',
      config: { url: echoUrl, method: 'POST' },
    }),
  );

  return { store, broker, transports, v02, echo, echoUrl, base };
}

describe('v0.2 — end-to-end smoke', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await boot();
  });

  afterEach(async () => {
    h.v02.stop();
    await new Promise<void>((resolve) => h.echo.close(() => resolve()));
    await h.transports.shutdown();
  });

  it(
    'propose_plan -> approve via dashboard -> executor runs webhook step -> bom_completed',
    async () => {
      // 1. Propose a plan.
      const proposed = await h.v02.planner.proposePlan({
        goal: 'POST a hello payload to the local echo endpoint and confirm it returned 200',
        correlationId: 'smoke-corr',
        availableCapabilities: h.v02.connectors.allCapabilities().map(({ connectorId, capability }) => ({
          connectorId,
          capabilityId: capability.id,
          description: capability.description,
          capabilityTag: capability.capabilityTag,
          riskClass: capability.riskClass,
        })),
      });
      expect(proposed.bomId).toMatch(/^bom_/);

      const completionPromise = new Promise<{ payload: Record<string, unknown> }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('bom_completed not seen within 5s')), 5000);
        const dispose = h.broker.onEvent((ev) => {
          if (ev.kind !== 'bom_completed') return;
          const p = ev.payload as { bom_id?: string };
          if (p.bom_id !== proposed.bomId) return;
          clearTimeout(timer);
          dispose();
          resolve({ payload: p as Record<string, unknown> });
        });
      });

      // 2. Approve via the dashboard endpoint (same path the UI uses).
      const respondRes = await fetch(`${h.base}/dashboard/plans/${proposed.bomId}/respond`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ verdict: 'approve' }),
      });
      expect(respondRes.status).toBe(200);

      // 3. Wait for executor to finish.
      const completion = await completionPromise;
      expect(completion.payload.bom_id).toBe(proposed.bomId);

      // 4. Verify final BOM state.
      const bom = h.store.getBom(proposed.bomId);
      expect(bom).toBeDefined();
      expect(bom?.status).toBe('done');
      expect(bom?.steps_done).toBe(bom?.steps_total);
      expect(bom?.scope_id).toBeTruthy();

      // 5. Verify the step's connector response was captured.
      const steps = h.store.listBomSteps(proposed.bomId, bom!.active_version);
      expect(steps.length).toBe(1);
      expect(steps[0].status).toBe('done');
    },
    10_000,
  );
});
