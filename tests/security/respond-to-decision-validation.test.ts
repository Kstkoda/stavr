/**
 * Phase 4 / 4.5 / 4.6 of family-mode-phase-1 — respond-time validation.
 *
 * Two rules ride on the additive `source_agent` + `tier` columns (Phase 4)
 * and on the verified-identity discipline (Phase 4.5):
 *
 *   1. Self-approval is refused. If a decision was opened with a known
 *      requester (source_agent IS NOT NULL), a response from that same
 *      VERIFIED caller is rejected with `responder_is_requester`. Legacy
 *      rows from before Phase 4 keep NULL source_agent and the validator
 *      falls open on them (cannot-determine ≠ self-approval). Phase 4.5
 *      moved "verified caller" from the spoofable arg to the
 *      logContext.actor_id stamped by the HTTP transport — so the rule
 *      now holds against lying actors too.
 *
 *   2. Operator-only at every tier. A decision (any tier) can only be
 *      answered by a verified operator identity: loopback shapes
 *      (`unstamped-loopback`, `loopback:*`) or notify-verified-remote
 *      (`notify:*`, produced only by the HMAC-verified reply-router).
 *      Anything else (`cc`, `cowork-user`, `peer:*`, arbitrary strings)
 *      is refused with `operator_required`. Phase 4 had this rule only
 *      for EXPLICIT decisions (and called it `explicit_requires_operator`);
 *      Phase 4.5 widened it to every tier because the responder arg
 *      could no longer be trusted to identify the caller. Phase 4.6
 *      folded the notify channel in as a first-class case via
 *      `mayRespond` so the store-level check is now a thin alignment
 *      backstop, not a parallel looser policy.
 *
 * The synthetic `switch-default` responder bypasses both checks — the
 * timeout-fallback path must never be blocked by validation, otherwise
 * decisions could hang indefinitely past their deadline.
 *
 * Refusals emit `decision_self_approval_rejected` (via the tool layer
 * and the dashboard endpoint and the notify reply-router). This file
 * tests the store-level validator directly so the rule is grounded in
 * the lowest authority — the persistence layer — and any future caller
 * picks it up via the canonical `isOperatorAuthorized` predicate.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventStore } from '../../src/persistence.js';
import { Broker } from '../../src/broker.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerDecisionTools } from '../../src/tools/decisions.js';
import { logContext } from '../../src/observability/logger.js';

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
      const r = store.respondToDecision('self-2', 'approve', 'ok', 'unstamped-loopback');
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

      // Phase 4.5 — the operator-shape check still applies to legacy rows;
      // a non-operator-shaped responder ('cc') is rejected with
      // operator_required. The PURPOSE of this case is to show the
      // self-approval check falls open on NULL source_agent — we prove
      // that by using a recognised operator-shaped responder and seeing
      // it succeed even though it equals 'cc' would have been self-approval
      // on a stamped row.
      const r = store.respondToDecision('legacy-1', 'approve', 'legacy', 'unstamped-loopback');
      expect(r.ok).toBe(true);
    });
  });

  describe('operator-only at every tier (Phase 4.5 — was EXPLICIT-only in Phase 4)', () => {
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
      // Phase 4.5 — the error code is now 'operator_required' (was
      // 'explicit_requires_operator' in Phase 4); the rule has widened
      // from EXPLICIT-only to operator-only at every tier.
      const r = store.respondToDecision('explicit-1', 'approve', 'try', 'cowork-user');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('operator_required');

      const after = store.getDecision('explicit-1');
      expect(after?.status).toBe('open');
    });

    it('allows an unstamped-loopback caller (canonical stdio operator) to answer an EXPLICIT decision', () => {
      store.createDecision(
        'explicit-2',
        'EXPLICIT approve?',
        [{ id: 'approve', label: 'A' }, { id: 'reject', label: 'R' }],
        60,
        'reject',
        'peer:laptop',
        'EXPLICIT',
      );
      const r = store.respondToDecision('explicit-2', 'approve', 'operator says yes', 'unstamped-loopback');
      expect(r.ok).toBe(true);
    });

    it('allows a notify-verified-remote responder (Phase 4.6 — notify is first-class via mayRespond)', () => {
      // Phase 4.5 had `notify:*` as a store-level carve-out only; Phase 4.6
      // folded it into mayRespond so the store-level fence and the primary
      // policy accept the same set.
      store.createDecision(
        'explicit-notify',
        'EXPLICIT approve via notify?',
        [{ id: 'approve', label: 'A' }, { id: 'reject', label: 'R' }],
        60,
        'reject',
        'peer:laptop',
        'EXPLICIT',
      );
      const r = store.respondToDecision('explicit-notify', 'approve', 'operator via telegram', 'notify:telegram');
      expect(r.ok).toBe(true);
    });

    it('refuses agent-relayed responders for CONFIRM decisions too (Phase 4.5 widened the rule)', () => {
      // Phase 4 allowed 'cowork-user' at the CONFIRM tier; Phase 4.5 closes
      // that — operator-only applies to EVERY tier, since the responder
      // string can no longer be trusted to identify the actual caller
      // (Phase 4.5 derives verified identity in the tool layer).
      store.createDecision(
        'confirm-1',
        'Confirm?',
        [{ id: 'approve', label: 'A' }, { id: 'reject', label: 'R' }],
        60,
        'reject',
        'peer:laptop',
        'CONFIRM',
      );
      const r = store.respondToDecision('confirm-1', 'approve', 'try', 'cowork-user');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('operator_required');
    });

    it('refuses agent-relayed responders for tier-less (gatedAction) decisions too', () => {
      // Phase 4 allowed any non-requester for NULL-tier decisions; Phase
      // 4.5 closes that as part of the operator-only-at-every-tier
      // widening. gatedAction-opened decisions still stamp source_agent
      // for the self-approval check but no longer have a tier-based escape.
      store.createDecision(
        'no-tier-1',
        'Approve?',
        [{ id: 'approve', label: 'A' }, { id: 'reject', label: 'R' }],
        60,
        'reject',
        'cc',
      );
      const r = store.respondToDecision('no-tier-1', 'approve', 'try', 'cowork-user');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('operator_required');
    });

    it('CONFIRM decisions accept operator-shaped responders', () => {
      store.createDecision(
        'confirm-ok',
        'Confirm?',
        [{ id: 'approve', label: 'A' }, { id: 'reject', label: 'R' }],
        60,
        'reject',
        'peer:laptop',
        'CONFIRM',
      );
      const r = store.respondToDecision('confirm-ok', 'approve', 'ok', 'unstamped-loopback');
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

    it('refuses self-approval based on VERIFIED identity (not the responder arg)', async () => {
      // Phase 4.5 — the tool ignores `args.responder` for authorization;
      // verified identity comes from logContext.actor_id. We simulate a
      // paired peer whose verified identity (`peer:laptop`) equals the
      // decision's source_agent — that's the self-approval the BOM exists
      // to refuse. The peer can pass any string they want in the
      // `responder` arg (here 'user-direct' — spoofing the operator
      // label); the gate refuses anyway.
      const broker = new Broker(store);
      store.createDecision(
        'tool-self-1',
        'q',
        [{ id: 'a', label: 'A' }],
        60,
        'a',
        'peer:laptop',
      );
      const events: Array<{ kind: string; payload?: unknown }> = [];
      const off = broker.onEvent((ev) => events.push(ev));
      try {
        const r = await logContext.run({ actor_id: 'peer:laptop' }, () =>
          callTool(broker, {
            correlation_id: 'tool-self-1',
            chosen_option_id: 'a',
            responder: 'user-direct',
          }),
        );
        expect(r.ok).toBe(false);
        expect(r.error).toBe('responder_is_requester');
      } finally {
        off();
      }
      const audit = events.find((e) => e.kind === 'decision_self_approval_rejected');
      expect(audit).toBeDefined();
      expect((audit?.payload as { error: string }).error).toBe('responder_is_requester');
      // The advisory string the caller passed is recorded for forensics —
      // but it did NOT drive the policy. Verified identity did.
      expect((audit?.payload as { attempted_responder: string }).attempted_responder).toBe('user-direct');
      expect((audit?.payload as { verified_caller: string }).verified_caller).toBe('peer:laptop');
      expect((audit?.payload as { decision_source_agent: string }).decision_source_agent).toBe('peer:laptop');
    });

    it('refuses a paired peer trying to answer an EXPLICIT decision by claiming user-direct', async () => {
      // Phase 4.5 — the exact spoof the BOM cites: a paired peer passes
      // `responder: 'user-direct'` to satisfy the EXPLICIT operator-only
      // check. Verified identity is `peer:laptop` (paired remote); the
      // gate refuses with operator_required regardless of the arg.
      const broker = new Broker(store);
      store.createDecision(
        'tool-explicit-1',
        'q',
        [{ id: 'a', label: 'A' }],
        60,
        'a',
        'peer:other',
        'EXPLICIT',
      );
      const events: Array<{ kind: string; payload?: unknown }> = [];
      const off = broker.onEvent((ev) => events.push(ev));
      try {
        const r = await logContext.run({ actor_id: 'peer:laptop' }, () =>
          callTool(broker, {
            correlation_id: 'tool-explicit-1',
            chosen_option_id: 'a',
            responder: 'user-direct',
          }),
        );
        expect(r.ok).toBe(false);
        expect(r.error).toBe('operator_required');
      } finally {
        off();
      }
      const audit = events.find((e) => e.kind === 'decision_self_approval_rejected');
      expect(audit).toBeDefined();
      expect((audit?.payload as { error: string }).error).toBe('operator_required');
      expect((audit?.payload as { verified_caller: string }).verified_caller).toBe('peer:laptop');
      expect((audit?.payload as { attempted_responder: string }).attempted_responder).toBe('user-direct');
      expect((audit?.payload as { decision_tier: string }).decision_tier).toBe('EXPLICIT');
    });

    it('allows a loopback operator (verified caller starts with loopback:) to respond', async () => {
      // The verified caller is `loopback:corr-1` — operator-shape per the
      // HTTP transport's actor_id stamping; mayRespond approves.
      const broker = new Broker(store);
      store.createDecision(
        'tool-loopback-ok',
        'q',
        [{ id: 'a', label: 'A' }],
        60,
        'a',
        'peer:requester',
        'EXPLICIT',
      );
      const r = await logContext.run({ actor_id: 'loopback:test-corr-1' }, () =>
        callTool(broker, {
          correlation_id: 'tool-loopback-ok',
          chosen_option_id: 'a',
          responder: 'whatever',  // advisory; ignored
        }),
      );
      expect(r.ok).toBe(true);
      const after = broker.store.getDecision('tool-loopback-ok');
      expect(after?.status).toBe('responded');
      // The stored responder is the verified identity, NOT the arg.
      expect(after?.responded_by).toBe('loopback:test-corr-1');
    });

    it('allows an unstamped-loopback caller (stdio / no HTTP middleware) to respond', async () => {
      // No logContext.run wrapper — the verified caller falls through to
      // `unstamped-loopback`, which is operator-shape (stdio is local).
      const broker = new Broker(store);
      store.createDecision(
        'tool-stdio-ok',
        'q',
        [{ id: 'a', label: 'A' }],
        60,
        'a',
        'peer:requester',
        'CONFIRM',
      );
      const r = await callTool(broker, {
        correlation_id: 'tool-stdio-ok',
        chosen_option_id: 'a',
        responder: 'something',
      });
      expect(r.ok).toBe(true);
      const after = broker.store.getDecision('tool-stdio-ok');
      expect(after?.responded_by).toBe('unstamped-loopback');
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
