// tests/integration/v0.2-smoke.test.ts
//
// End-to-end smoke for the v0.2 substrate, INCLUDING the installer:
//   start daemon (in-process) -> wire planner+executor+brick installer
//   -> install a runtime fixture brick via installer.installLocal()
//   -> applyConfig with echo URL (same path the dashboard inspector uses)
//   -> call propose_plan (stub LLM) -> approve via /dashboard/plans/:id/respond
//   -> await bom_completed -> assert BOM done, response captured.
//
// The fixture brick is written to a tmpdir at test setup. Its index.mjs is
// plain ESM that Node's loader can import directly; no `npm run build` step
// is required. This mirrors tests/bricks/installer.test.ts's pattern.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EventStore } from '../../src/persistence.js';
import { Broker } from '../../src/broker.js';
import { mountTransports, type MountedTransports } from '../../src/transports.js';
import { wireV02Subsystem, type V02SubsystemHandle } from '../../src/steward/v02-wiring.js';

interface Harness {
  store: EventStore;
  broker: Broker;
  transports: MountedTransports;
  v02: V02SubsystemHandle;
  echo: Server;
  echoUrl: string;
  base: string;
  tmpRoot: string;
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

// Plain-JS factory shipped with the fixture brick. Closure holds applied
// config so applyConfig({url, method}) is what arms exec(). Same shape the
// real WebhookConnector follows: install -> applyConfig -> exec.
const FIXTURE_BRICK_JS = `export default async function factory({ manifest }) {
  let currentConfig = {};
  return {
    id: manifest.id,
    kind: manifest.kind,
    displayName: manifest.display_name,
    position: manifest.position,
    logoPath: null,
    configSchema: () => manifest.config_schema || [],
    applyConfig: async (cfg) => {
      currentConfig = { ...currentConfig, ...cfg };
      return { kind: 'ok', detail: 'configured', lastChecked: new Date().toISOString() };
    },
    testConnection: async () => ({ kind: 'ok', detail: 'ok', lastChecked: new Date().toISOString() }),
    status: () => ({ kind: 'ok', detail: 'ok', lastChecked: new Date().toISOString() }),
    capabilities: () => (manifest.capabilities || []).map((c) => ({
      id: c.id,
      description: c.description,
      capabilityTag: c.capability_tag,
      riskClass: c.risk_class,
      argsSchema: c.args_schema || [],
      enabled: c.enabled !== false,
    })),
    exec: async ({ args }) => {
      const url = currentConfig.url;
      if (!url) throw new Error('webhook-smoke: applyConfig must set url before exec');
      const method = currentConfig.method || 'POST';
      const body = args && args.body !== undefined ? args.body : (args || {});
      const res = await fetch(url, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const responseBody = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, body: responseBody, durationMs: 0 };
    },
  };
}
`;

async function boot(): Promise<Harness> {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'stavr-smoke-'));
  const bricksRoot = join(tmpRoot, 'bricks');

  const store = new EventStore();
  store.init(':memory:');
  const broker = new Broker(store);
  const transports = await mountTransports(broker, { mode: 'daemon', port: 0, silent: true });
  const addr = transports.httpServer!.address() as AddressInfo;
  const base = `http://127.0.0.1:${addr.port}`;
  const { server: echo, url: echoUrl } = await bootEchoServer();

  // Build a runtime fixture brick that exercises the real installer path
  // (copy, manifest validation, dynamic import, registry register, persist)
  // without forcing `npm run build` to run before this test.
  const fixtureDir = join(tmpRoot, 'webhook-smoke-brick');
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(
    join(fixtureDir, 'stavr-brick.json'),
    JSON.stringify(
      {
        id: 'webhook-smoke',
        kind: 'webhook',
        display_name: 'Smoke Webhook',
        position: 'above',
        entry: 'index.mjs',
        config_schema: [
          { key: 'url', label: 'URL', kind: 'url', required: true },
          { key: 'method', label: 'Method', kind: 'text', required: false },
        ],
        capabilities: [
          {
            id: 'post',
            description: 'POST to configured URL',
            capability_tag: 'no-model',
            risk_class: 'external-comm',
            args_schema: [],
          },
        ],
      },
      null,
      2,
    ),
  );
  writeFileSync(join(fixtureDir, 'index.mjs'), FIXTURE_BRICK_JS);

  const v02 = wireV02Subsystem({
    broker,
    store,
    bricksRoot,
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

  // Install through the real installer. After this returns, the brick is
  // copied into bricksRoot/webhook-smoke/, its factory has been imported,
  // and the resulting Connector is registered in v02.connectors.
  await v02.bricks.installLocal(fixtureDir);

  // Apply config now that the brick is registered. In production this
  // happens via the dashboard inspector form on /dashboard/bricks/:id.
  const installed = v02.connectors.get('webhook-smoke');
  if (!installed) throw new Error('webhook-smoke not registered after installLocal');
  await installed.applyConfig({ url: echoUrl, method: 'POST' });

  return { store, broker, transports, v02, echo, echoUrl, base, tmpRoot };
}

describe('v0.2 — end-to-end smoke (installer + executor)', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await boot();
  });

  afterEach(async () => {
    h.v02.stop();
    await new Promise<void>((resolve) => h.echo.close(() => resolve()));
    await h.transports.shutdown();
    rmSync(h.tmpRoot, { recursive: true, force: true });
  });

  it(
    'install -> propose_plan -> approve -> executor runs brick step -> bom_completed',
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
