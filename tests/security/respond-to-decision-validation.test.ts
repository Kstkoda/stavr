/**
 * Phase 4 of family-mode-phase-1 — respond-time validation in
 * `EventStore.respondToDecision`.
 *
 * Two rules ride on the additive `source_agent` + `tier` columns:
 *
 *   1. Self-approval is refused. If a decision was opened with a known
 *      requester (source_agent IS NOT NULL), a response from that same
 *      agent is rejected with `responder_is_requester`. Legacy rows from
 *      before Phase 4 keep NULL source_agent and the validator falls
 *      open on them (cannot-determine ≠ self-approval).
 *
 *   2. EXPLICIT-tier decisions require the operator. A decision opened
 *      at tier=EXPLICIT can only be answered by `user-direct` (dashboard
 *      operator) or `switch-default` (timeout fallback). Any agent-
 *      relayed responder (`cowork-user`, `cowork-auto`, `cc`, `peer:*`)
 *      is refused with `explicit_requires_operator`.
 *
 * The synthetic `switch-default` responder bypasses both checks — the
 * timeout-fallback path must never be blocked by validation, otherwise
 * decisions could hang indefinitely past their deadline.
 *
 * Refusals emit `decision_self_approval_rejected` (via the await/respond
 * MCP tool; covered separately at the tool layer). This file tests the
 * store-level validator directly so the rule is grounded in the lowest
 * authority — the persistence layer — and any future caller picks it up.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventStore } from '../../src/persistence.js';
import { Broker } from '../../src/broker.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerDecisionTools } from '../../src/tools/decisions.js';

describe('respondToDecision validation (Phase 4)', () => {
  let store: EventStore;

  beforeEach(() => {
    store = new EventStore();
    store.init(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  describe('self-approval refusal', () => {
    it('refuses a response whose responder equals the requester (source_agent)', () => {
      store.createDecision(
        'self-1',
        'Approve?',
        [{ id: 'approve', label: 'A' }, { id: 'reject', label: 'R' }],
        60,
        'reject',
        'cc',
      );
      const r = store.respondToDecision('self-1', 'approve', 'I approve myself', 'cc');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('responder_is_requester');

      // Decision remains open — refusal is policy, not destruction.
      const after = store.getDecision('self-1');
      expect(after?.status).toBe('open');
      expect(after?.responded_at).toBeUndefined();
    });

    it('allows a different responder to answer the same decision', () => {
      store.createDecision(
        'self-2',
        'Approve?',
        [{ id: 'approve', label: 'A' }, { id: 'reject', label: 'R' }],
        60,
        'reject',
        'cc',
      );
      const r = store.respondToDecision('self-2', 'approve', 'ok', 'user-direct');
      expect(r.ok).toBe(true);
    });

    it('treats NULL source_agent (legacy rows) as cannot-determine — falls open', () => {
      // Insert a row without going through createDecision so source_agent
      // stays NULL — simulates a decision created before Phase 4 landed.
      const now = new Date();
      const expires = new Date(now.getTime() + 60_000);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (store as any).db
        .prepare(
          `INSERT INTO decisions (correlation_id, question, options_json, default_option_id, timeout_sec, status, requested_at, expires_at)
           VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`,
        )
        .run(
          'legacy-1',
          'legacy q',
          JSON.stringify([{ id: 'approve', label: 'A' }]),
          'approve',
          60,
          now.toISOString(),
          expires.toISOString(),
        );

      const row = store.getDecision('legacy-1');
      expect(row?.source_agent).toBeUndefined();

      // A responder identical to the requester's likely identity ('cc')
      // still passes — there is no source_agent to compare against.
      const r = store.respondToDecision('legacy-1', 'approve', 'legacy', 'cc');
      expect(r.ok).toBe(true);
    });
  });

  describe('EXPLICIT operator-only', () => {
    it('refuses an agent-relayed responder for an EXPLICIT decision', () => {
      store.createDecision(
        'explicit-1',
        'EXPLICIT approve?',
        [{ id: 'approve', label: 'A' }, { id: 'reject', label: 'R' }],
        60,
        'reject',
        'peer:laptop',
        'EXPLICIT',
      );
      const r = store.respondToDecision('explicit-1', 'approve', 'try', 'cowork-user');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('explicit_requires_operator');

      const after = store.getDecision('explicit-1');
      expect(after?.status).toBe('open');
    });

    it('allows user-direct (dashboard operator) to answer an EXPLICIT decision', () => {
      store.createDecision(
        'explicit-2',
        'EXPLICIT approve?',
        [{ id: 'approve', label: 'A' }, { id: 'reject', label: 'R' }],
        60,
        'reject',
        'peer:laptop',
        'EXPLICIT',
      );
      const r = store.respondToDecision('explicit-2', 'approve', 'operator says yes', 'user-direct');
      expect(r.ok).toBe(true);
    });

    it('CONFIRM decisions accept agent-relayed responders (the rule is EXPLICIT-only)', () => {
      store.createDecision(
        'confirm-1',
        'Confirm?',
        [{ id: 'approve', label: 'A' }, { id: 'reject', label: 'R' }],
        60,
        'reject',
        'peer:laptop',
        'CONFIRM',
      );
      const r = store.respondToDecision('confirm-1', 'approve', 'ok', 'cowork-user');
      expect(r.ok).toBe(true);
    });

    it('decisions without a tier (gatedAction / await_decision) accept any non-requester responder', () => {
      // gatedAction-opened decisions stamp source_agent but leave tier NULL —
      // the EXPLICIT operator-only rule does not apply to them.
      store.createDecision(
        'no-tier-1',
        'Approve?',
        [{ id: 'approve', label: 'A' }, { id: 'reject', label: 'R' }],
        60,
        'reject',
        'cc',
      );
      const r = store.respondToDecision('no-tier-1', 'approve', 'ok', 'cowork-user');
      expect(r.ok).toBe(true);
    });
  });

  describe('switch-default timeout fallback bypasses both rules', () => {
    it('switch-default can close a decision even when its source_agent matches', () => {
      store.createDecision(
        'timeout-1',
        'Approve?',
        [{ id: 'approve', label: 'A' }, { id: 'reject', label: 'R' }],
        60,
        'reject',
        'switch-default',
      );
      const r = store.respondToDecision('timeout-1', 'reject', 'timeout fallback', 'switch-default');
      expect(r.ok).toBe(true);
    });

    it('switch-default can close an EXPLICIT decision (timeout fallback must never be blocked)', () => {
      store.createDecision(
        'timeout-explicit',
        'EXPLICIT approve?',
        [{ id: 'approve', label: 'A' }, { id: 'reject', label: 'R' }],
        60,
        'reject',
        'peer:laptop',
        'EXPLICIT',
      );
      const r = store.respondToDecision(
        'timeout-explicit',
        'reject',
        'timeout fallback',
        'switch-default',
      );
      expect(r.ok).toBe(true);
    });
  });

  describe('respond_to_decision tool emits decision_self_approval_rejected', () => {
    // The tool layer wraps respondToDecision and emits the audit event on
    // policy refusals. We exercise the wrapped handler directly (the same
    // function the SDK invokes) to verify the event lands.
    async function callTool(
      broker: Broker,
      args: Record<string, unknown>,
    ): Promise<{ ok?: boolean; error?: string }> {
      // Capture handler via a stub McpServer; the SDK's real registerTool
      // accepts (name, config, handler) — we patch it to intercept.
      let respondHandler:
        | ((args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>)
        | undefined;
      const fakeServer = {
        registerTool(
          name: string,
          _config: unknown,
          handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>,
        ) {
          if (name === 'respond_to_decision') respondHandler = handler;
        },
      } as unknown as McpServer;
      registerDecisionTools(fakeServer, broker);
      if (!respondHandler) throw new Error('respond_to_decision handler not captured');
      const result = await respondHandler(args);
      return JSON.parse(result.content[0].text) as { ok?: boolean; error?: string };
    }

    it('emits decision_self_approval_rejected when responder === source_agent', async () => {
      const broker = new Broker(store);
      store.createDecision(
        'tool-self-1',
        'q',
        [{ id: 'a', label: 'A' }],
        60,
        'a',
        'cc',
      );
      const events: Array<{ kind: string; payload?: unknown }> = [];
      const off = broker.onEvent((ev) => events.push(ev));
      try {
        const r = await callTool(broker, {
          correlation_id: 'tool-self-1',
          chosen_option_id: 'a',
          responder: 'cc',
        });
        expect(r.ok).toBe(false);
        expect(r.error).toBe('responder_is_requester');
      } finally {
        off();
      }
      const audit = events.find((e) => e.kind === 'decision_self_approval_rejected');
      expect(audit).toBeDefined();
      expect((audit?.payload as { error: string }).error).toBe('responder_is_requester');
      expect((audit?.payload as { attempted_responder: string }).attempted_responder).toBe('cc');
      expect((audit?.payload as { decision_source_agent: string }).decision_source_agent).toBe('cc');
    });

    it('emits decision_self_approval_rejected when EXPLICIT decision answered by non-operator', async () => {
      const broker = new Broker(store);
      store.createDecision(
        'tool-explicit-1',
        'q',
        [{ id: 'a', label: 'A' }],
        60,
        'a',
        'peer:laptop',
        'EXPLICIT',
      );
      const events: Array<{ kind: string; payload?: unknown }> = [];
      const off = broker.onEvent((ev) => events.push(ev));
      try {
        const r = await callTool(broker, {
          correlation_id: 'tool-explicit-1',
          chosen_option_id: 'a',
          responder: 'cowork-user',
        });
        expect(r.ok).toBe(false);
        expect(r.error).toBe('explicit_requires_operator');
      } finally {
        off();
      }
      const audit = events.find((e) => e.kind === 'decision_self_approval_rejected');
      expect(audit).toBeDefined();
      expect((audit?.payload as { error: string }).error).toBe('explicit_requires_operator');
      expect((audit?.payload as { decision_tier: string }).decision_tier).toBe('EXPLICIT');
    });
  });

  describe('schema upgrade — additive columns on existing DBs', () => {
    it('persists source_agent and tier when set via createDecision', () => {
      store.createDecision(
        'persist-1',
        'q',
        [{ id: 'a', label: 'A' }],
        60,
        'a',
        'peer:foo',
        'CONFIRM',
      );
      const row = store.getDecision('persist-1');
      expect(row?.source_agent).toBe('peer:foo');
      expect(row?.tier).toBe('CONFIRM');
    });

    it('persists EXPLICIT tier correctly', () => {
      store.createDecision(
        'persist-2',
        'q',
        [{ id: 'a', label: 'A' }],
        60,
        'a',
        'peer:foo',
        'EXPLICIT',
      );
      const row = store.getDecision('persist-2');
      expect(row?.tier).toBe('EXPLICIT');
    });

    it('leaves source_agent and tier undefined when not supplied', () => {
      store.createDecision('no-stamp-1', 'q', [{ id: 'a', label: 'A' }], 60, 'a');
      const row = store.getDecision('no-stamp-1');
      expect(row?.source_agent).toBeUndefined();
      expect(row?.tier).toBeUndefined();
    });
  });
});
