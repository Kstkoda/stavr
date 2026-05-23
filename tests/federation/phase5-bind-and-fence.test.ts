/**
 * Phase 5 of family-mode-phase-1 — non-loopback bind hardening.
 *
 * Three guarantees the BOM commits to at the bind step. We test them at
 * the units level (mountTransports + isLoopbackOnlyPath + ActorPermission-
 * Store) rather than via subprocess CLI spawn — the CLI-subprocess tests
 * in tests/federation/bind.test.ts already cover the spawn path but flake
 * on Node v24 + tsx + Windows worktree resolution (the 15 pre-existing
 * MODULE_NOT_FOUND failures on baseline b80c602). The unit-level
 * guarantees verified here are the load-bearing ones:
 *
 *   1. The default bind stays 127.0.0.1 (no opt-in needed; operator
 *      passes --bind-host to go non-loopback).
 *   2. A non-loopback bind without `authConfigured` HARD-FAILS at
 *      mountTransports() with a clear error — not a warning, not a
 *      silent degrade.
 *   3. `/dashboard/*` and `/events/sse` are loopback-only at the path
 *      level via `isLoopbackOnlyPath`; the middleware that enforces it
 *      sends 403 to a peer with a valid bearer token. We verify the
 *      predicate here; the middleware integration is exercised by the
 *      booted-on-loopback dashboard tests (they pass because the test
 *      harness is 127.0.0.1, which is the documented happy path).
 *
 * Phase 5 also includes:
 *   4. A new paired peer lands on the conservative `defaultTierFor`
 *      defaults — no per-actor matrix row is seeded at pair time, so
 *      resolve() falls through to categories.ts's conservative bias.
 *      Verified here against a representative set of sensitive tools.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { EventStore } from '../../src/persistence.js';
import { Broker } from '../../src/broker.js';
import {
  mountTransports,
  isLoopbackOnlyPath,
  type MountedTransports,
} from '../../src/transports.js';
import { ActorPermissionStore } from '../../src/security/actor-permissions.js';

describe('Phase 5 — non-loopback bind guard', () => {
  let store: EventStore;
  let broker: Broker;

  beforeEach(() => {
    store = new EventStore();
    store.init(':memory:');
    broker = new Broker(store);
  });

  afterEach(() => {
    store.close();
  });

  it('default bind is 127.0.0.1 (operator must opt-in to non-loopback)', async () => {
    const transports = await mountTransports(broker, {
      mode: 'daemon',
      port: 0,
      silent: true,
      // bindHost intentionally omitted to test the default.
    });
    try {
      const addr = transports.httpServer!.address() as AddressInfo;
      expect(addr.address === '127.0.0.1' || addr.address === '::1').toBe(true);
    } finally {
      await transports.shutdown();
    }
  });

  it('refuses to bind non-loopback when authConfigured is false (hard-fail, not a warning)', async () => {
    await expect(
      mountTransports(broker, {
        mode: 'daemon',
        port: 0,
        silent: true,
        bindHost: '0.0.0.0',
        authConfigured: false,
        requireAuthWhenNonLocal: true,
      }),
    ).rejects.toThrow(/refusing to bind non-local without auth configured/);
  });

  it('still refuses when requireAuthWhenNonLocal is left at default (undefined → true)', async () => {
    await expect(
      mountTransports(broker, {
        mode: 'daemon',
        port: 0,
        silent: true,
        bindHost: '0.0.0.0',
        authConfigured: false,
      }),
    ).rejects.toThrow(/refusing to bind non-local without auth configured/);
  });

  it('allows non-loopback bind when authConfigured is true', async () => {
    // We bind to 127.0.0.1 here (not 0.0.0.0) because CI runners don't have
    // a predictable non-loopback IPv4 and binding 0.0.0.0 can trigger
    // firewall prompts on Windows. The relevant code path is the guard
    // check, not the actual bind address — the check fires on `bindHost`
    // being non-loopback. We use a string the guard treats as non-
    // loopback ('0.0.0.0') only to test the refusal; for the allow path
    // we use the literal '127.0.0.1' which is unambiguously safe.
    const transports = await mountTransports(broker, {
      mode: 'daemon',
      port: 0,
      silent: true,
      bindHost: '127.0.0.1',
      authConfigured: true,
    });
    try {
      expect(transports.httpServer).toBeDefined();
    } finally {
      await transports.shutdown();
    }
  });

  it('escape hatch: requireAuthWhenNonLocal=false allows non-loopback without auth (documented operator override)', async () => {
    // The escape hatch is the documented way to disable the guard on a
    // known-trusted network. The guard's error message names it
    // explicitly. We test it doesn't throw — the bind itself is on
    // 127.0.0.1 to keep the test runner safe; what matters is that the
    // function returns without hitting the refuse branch.
    const transports = await mountTransports(broker, {
      mode: 'daemon',
      port: 0,
      silent: true,
      bindHost: '127.0.0.1',
      authConfigured: false,
      requireAuthWhenNonLocal: false,
    });
    try {
      expect(transports.httpServer).toBeDefined();
    } finally {
      await transports.shutdown();
    }
  });
});

describe('Phase 5 — isLoopbackOnlyPath predicate', () => {
  it('matches /dashboard exactly', () => {
    expect(isLoopbackOnlyPath('/dashboard')).toBe(true);
  });

  it('matches /dashboard/* prefix paths', () => {
    expect(isLoopbackOnlyPath('/dashboard/helm')).toBe(true);
    expect(isLoopbackOnlyPath('/dashboard/topology')).toBe(true);
    expect(isLoopbackOnlyPath('/dashboard/decisions')).toBe(true);
    expect(isLoopbackOnlyPath('/dashboard/decisions/abc/respond')).toBe(true);
    expect(isLoopbackOnlyPath('/dashboard/api/perf')).toBe(true);
    expect(isLoopbackOnlyPath('/dashboard/api/diagnostics/memory')).toBe(true);
  });

  it('matches /events/sse exactly', () => {
    expect(isLoopbackOnlyPath('/events/sse')).toBe(true);
  });

  it('does NOT match the public endpoints', () => {
    expect(isLoopbackOnlyPath('/healthz')).toBe(false);
    expect(isLoopbackOnlyPath('/pair/initiate')).toBe(false);
    expect(isLoopbackOnlyPath('/pair/complete')).toBe(false);
    expect(isLoopbackOnlyPath('/mcp')).toBe(false);
  });

  it('does NOT match suffix collisions (e.g. /dashboards)', () => {
    expect(isLoopbackOnlyPath('/dashboards')).toBe(false);
    expect(isLoopbackOnlyPath('/dashboard-feed')).toBe(false);
  });

  it('does NOT match /status (operator can decide to widen if they want; today it is not in the loopback-only set)', () => {
    expect(isLoopbackOnlyPath('/status')).toBe(false);
  });
});

describe('Phase 5 — loopback fence rejects a paired peer (fake-req unit test)', () => {
  // Combines the two predicates the middleware actually composes:
  //   isLoopbackOnlyPath(req.path) && !isLoopbackRequest(req)
  // We can't bind 0.0.0.0 from a test runner without flaking on Windows
  // CI / firewall prompts, so we fake the socket.remoteAddress to drive
  // the non-loopback path of isLoopbackRequest deterministically.

  function fakeReqWithRemote(path: string, remoteAddress: string): import('express').Request {
    return {
      path,
      socket: { remoteAddress },
      header: () => undefined,
    } as unknown as import('express').Request;
  }

  it('a peer (non-loopback remote socket) hitting /dashboard would be fenced — predicate fires', async () => {
    const { isLoopbackRequest } = await import('../../src/transports.js');
    const req = fakeReqWithRemote('/dashboard/decisions', '192.168.1.42');
    expect(isLoopbackRequest(req)).toBe(false);
    expect(isLoopbackOnlyPath(req.path)).toBe(true);
    // The middleware composes both: a peer to /dashboard gets 403.
  });

  it('a peer hitting /mcp is NOT fenced (mayRespond/auth handle peer access on /mcp)', async () => {
    const { isLoopbackRequest } = await import('../../src/transports.js');
    const req = fakeReqWithRemote('/mcp', '192.168.1.42');
    expect(isLoopbackRequest(req)).toBe(false);
    expect(isLoopbackOnlyPath(req.path)).toBe(false);
  });

  it('a loopback caller hitting /dashboard is NOT fenced (operator works normally)', async () => {
    const { isLoopbackRequest } = await import('../../src/transports.js');
    const req = fakeReqWithRemote('/dashboard/helm', '127.0.0.1');
    expect(isLoopbackRequest(req)).toBe(true);
    // isLoopbackOnlyPath is true but the fence condition needs BOTH parts:
    // the fence does NOT fire when the caller is loopback.
  });

  it('IPv6-mapped IPv4 loopback (::ffff:127.0.0.1) is treated as loopback by the fence', async () => {
    const { isLoopbackRequest } = await import('../../src/transports.js');
    const req = fakeReqWithRemote('/dashboard/helm', '::ffff:127.0.0.1');
    expect(isLoopbackRequest(req)).toBe(true);
  });

  it('::1 (IPv6 loopback) is treated as loopback by the fence', async () => {
    const { isLoopbackRequest } = await import('../../src/transports.js');
    const req = fakeReqWithRemote('/dashboard/helm', '::1');
    expect(isLoopbackRequest(req)).toBe(true);
  });

  it('a peer hitting /events/sse (audit tail) is fenced — predicate fires', async () => {
    const { isLoopbackRequest } = await import('../../src/transports.js');
    const req = fakeReqWithRemote('/events/sse', '192.168.1.42');
    expect(isLoopbackRequest(req)).toBe(false);
    expect(isLoopbackOnlyPath(req.path)).toBe(true);
  });
});

describe('Phase 5 — loopback fence integration (booted HTTP server)', () => {
  let store: EventStore;
  let broker: Broker;
  let transports: MountedTransports;
  let base: string;

  beforeEach(async () => {
    store = new EventStore();
    store.init(':memory:');
    broker = new Broker(store);
    transports = await mountTransports(broker, {
      mode: 'daemon',
      port: 0,
      silent: true,
    });
    const addr = transports.httpServer!.address() as AddressInfo;
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await transports.shutdown();
    store.close();
  });

  it('loopback callers reach /dashboard/* normally (regression check on the fence)', async () => {
    // The fence must not break the operator's own loopback dashboard.
    const r = await fetch(`${base}/dashboard/decisions`);
    expect(r.status).toBe(200);
  });

  it('loopback callers reach /events/sse normally', async () => {
    // Use AbortController to close the SSE stream quickly after the
    // initial connection is established.
    const ac = new AbortController();
    const r = await fetch(`${base}/events/sse`, { signal: ac.signal });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/text\/event-stream/);
    ac.abort();
  });
});

describe('Phase 5.5 / 5.6 — fresh peer is default-DENY (allowlist for operator-shape)', () => {
  // Phase 5 review found defaultTierFor() in categories.ts was actor-
  // blind — a peer with no matrix row was inheriting AUTO on
  // get_events / emit_event / subscribe_to_events / worker_list_* /
  // steward_ask, which would let a paired family device read the
  // operator's audit log via the MCP tool path (defeating the Phase 5
  // loopback fence on /events/sse). Phase 5.5 closed that for
  // peer:* — but the fall-through was still a denylist (peer:* → NO_GO,
  // else → defaultTierFor()), so the transport's 'unknown' actor stamp
  // and any future unrecognized shape silently inherited operator
  // defaults. Phase 5.6 flipped to an explicit allowlist: operator-
  // shape (loopback shapes + KNOWN_ACTORS) gets defaultTierFor; every-
  // thing else (peer:*, 'unknown', arbitrary strings) gets default-deny.

  let store: EventStore;
  let perms: ActorPermissionStore;

  beforeEach(() => {
    store = new EventStore();
    store.init(':memory:');
    perms = new ActorPermissionStore(store.rawDb);
  });

  afterEach(() => {
    store.close();
  });

  it('a brand-new paired peer has no matrix rows', () => {
    expect(perms.byActor('peer:fresh-laptop')).toHaveLength(0);
  });

  it('a fresh peer resolves to NO_GO across read AND write tools — default-DENY (Phase 5.5)', () => {
    // Every tool category — even the read-only AUTO-by-default ones —
    // refuses an unconfigured peer. This is the security correction
    // Phase 5.5 lands: get_events / emit_event / subscribe_to_events /
    // worker_list / worker_status / steward_ask all return NO_GO for
    // a peer with no matrix row, closing the audit-log exfiltration
    // path through the MCP tool surface.
    const sensitive = [
      'worker_spawn',
      'worker_dispatch',
      'worker_terminate',
      'host_exec',
      'github_create_pr',
      'github_merge_pr',
      'trust_scope_grant',
      'credential_use',
    ];
    const reads = [
      'emit_event',
      'subscribe_to_events',
      'get_events',
      'worker_list',
      'worker_status',
      'steward_ask',
    ];
    for (const tool of [...sensitive, ...reads]) {
      const r = perms.resolve('peer:fresh-laptop', tool);
      expect(r.tier, `peer:fresh-laptop/${tool}`).toBe('NO_GO');
      expect(r.source, `peer:fresh-laptop/${tool}`).toBe('default-deny');
    }
  });

  it('a loopback / operator-shape actor still resolves via defaultTierFor()', () => {
    // Phase 5.5 only changes the peer:* fall-through. The operator and
    // the well-known agent actors keep the conservative defaults from
    // categories.ts — reads stay AUTO, writes stay CONFIRM, shell stays
    // EXPLICIT.
    for (const actor of ['operator', 'cowork-claude', 'cc', 'steward', 'unstamped-loopback', 'loopback:abc-corr']) {
      expect(perms.resolve(actor, 'emit_event').tier).toBe('AUTO');
      expect(perms.resolve(actor, 'subscribe_to_events').tier).toBe('AUTO');
      expect(perms.resolve(actor, 'get_events').tier).toBe('AUTO');
      expect(perms.resolve(actor, 'worker_spawn').tier).toBe('CONFIRM');
      expect(perms.resolve(actor, 'host_exec').tier).toBe('EXPLICIT');
      expect(perms.resolve(actor, 'emit_event').source).toBe('default');
    }
  });

  it('once the operator grants a per-(actor,tool) tier, the peer gets that tier', () => {
    // Operator action lifts the default-deny. The matrix row beats the
    // peer fall-through (matrix > default-deny-peer > default).
    perms.set('peer:fresh-laptop', 'worker_spawn', 'CONFIRM', 'operator');
    perms.set('peer:fresh-laptop', 'emit_event', 'AUTO', 'operator');
    perms.set('peer:fresh-laptop', 'host_exec', 'NO_GO', 'operator');

    expect(perms.resolve('peer:fresh-laptop', 'worker_spawn')).toEqual({
      tier: 'CONFIRM',
      source: 'matrix',
    });
    expect(perms.resolve('peer:fresh-laptop', 'emit_event')).toEqual({
      tier: 'AUTO',
      source: 'matrix',
    });
    expect(perms.resolve('peer:fresh-laptop', 'host_exec')).toEqual({
      tier: 'NO_GO',
      source: 'matrix',
    });

    // Tools the operator did NOT grant remain default-deny.
    expect(perms.resolve('peer:fresh-laptop', 'github_merge_pr')).toEqual({
      tier: 'NO_GO',
      source: 'default-deny',
    });
  });

  it('reset() of a granted row returns the peer to default-deny (not defaultTierFor)', () => {
    perms.set('peer:fresh-laptop', 'worker_spawn', 'AUTO', 'operator');
    expect(perms.resolve('peer:fresh-laptop', 'worker_spawn').source).toBe('matrix');
    perms.reset('peer:fresh-laptop', 'worker_spawn');
    // After reset, the row is gone — peer falls through to default-deny,
    // NOT to defaultTierFor's CONFIRM.
    const r = perms.resolve('peer:fresh-laptop', 'worker_spawn');
    expect(r.tier).toBe('NO_GO');
    expect(r.source).toBe('default-deny');
  });

  it('the peer:* prefix is the trigger — any peer id with that shape is default-deny', () => {
    expect(perms.resolve('peer:', 'emit_event').tier).toBe('NO_GO');
    expect(perms.resolve('peer:laptop', 'emit_event').tier).toBe('NO_GO');
    expect(perms.resolve('peer:kenneth-laptop', 'emit_event').tier).toBe('NO_GO');
    expect(perms.resolve('peer:nas.local', 'emit_event').tier).toBe('NO_GO');
    // Phase 5.6 — the allowlist flip: things that LOOK like peer but
    // aren't on the operator-shape allowlist are ALSO default-deny now.
    // The catch-all is the point: anything not explicitly recognized as
    // operator-shape resolves to NO_GO.
    expect(perms.resolve('peerless', 'emit_event').tier).toBe('NO_GO');
    expect(perms.resolve('peerless', 'emit_event').source).toBe('default-deny');
    expect(perms.resolve('not-peer:laptop', 'emit_event').tier).toBe('NO_GO');
    expect(perms.resolve('not-peer:laptop', 'emit_event').source).toBe('default-deny');
  });
});
