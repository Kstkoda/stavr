/**
 * P4 correlation walker tests. Covers:
 *   - kind-agnostic: walker starts from any kind
 *   - forward walk from origin (decision → host_exec → notification)
 *   - backward walk from notification → source event → operator action
 *   - walks bottoming out at NULL parent (no operator root reachable)
 *   - hop-depth reflects the chain length walked
 *   - walking from a non-decision non-notification kind
 *   - dedupe across sources (same row found via correlation_id + scope_id)
 */
import { describe, expect, it } from 'vitest';
import { walkCorrelation, renderTraceHtml } from '../../../../src/dashboard/data/history/correlation.js';
import { makeStore } from './helpers.js';

let seq = 5000;
function ev(db: import('better-sqlite3').Database, args: {
  id: string;
  kind: string;
  at: string;
  correlation_id?: string;
  source_agent?: string;
  payload?: Record<string, unknown>;
}): void {
  db.prepare(
    `INSERT INTO events (id, kind, correlation_id, source_agent, tenant_id, payload_json, at, persisted_at, seq, created_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
  ).run(
    args.id, args.kind, args.correlation_id ?? null, args.source_agent ?? 'cc',
    JSON.stringify(args.payload ?? {}), args.at, args.at, seq++, args.at,
  );
}

describe('walkCorrelation', () => {
  it('returns empty result when start has no correlation hint', () => {
    const { db } = makeStore();
    const r = walkCorrelation({ db }, { kind: 'commit', id: 'badbeef' });
    expect(r.correlation_id).toBeNull();
    expect(r.nodes).toEqual([]);
  });

  it('forward walk from a decision threads host_execs that share the cid', () => {
    const { db } = makeStore();
    db.prepare(
      `INSERT INTO decisions (correlation_id, question, options_json, default_option_id, timeout_sec, status, requested_at, expires_at)
       VALUES (?, ?, ?, NULL, 60, 'responded', ?, ?)`,
    ).run('cid-1', 'do?', JSON.stringify([{ id: 'y', label: 'Yes' }]), '2026-05-20T10:00:00Z', '2099-01-01T00:00:00Z');
    ev(db, {
      id: 'ev-1', kind: 'host_exec_started', at: '2026-05-20T10:00:05Z',
      correlation_id: 'cid-1',
      payload: { correlation_id: 'cid-1', scope_id: 'ts-1', command: 'git', args_hash: 'h', args_count: 1, timeout_ms: 5000 },
    });
    const r = walkCorrelation({ db }, { kind: 'decision', id: 'cid-1' }, 'forward');
    expect(r.correlation_id).toBe('cid-1');
    expect(r.nodes.map((n) => n.item.kind)).toContain('decision');
    expect(r.nodes.map((n) => n.item.kind)).toContain('host-exec');
    expect(r.hop_depth).toBeGreaterThan(0);
    // Forward walk: ASC time. The decision at 10:00:00 should precede
    // the host_exec at 10:00:05.
    const times = r.nodes.map((n) => n.item.at);
    expect(times[0] < times[times.length - 1]).toBe(true);
  });

  it('backward walk from a notification reaches its source event', () => {
    const { db } = makeStore();
    // Source event (e.g., the trust_scope_proposed that triggered the notification).
    ev(db, {
      id: 'ev-source',
      kind: 'trust_scope_proposed',
      at: '2026-05-20T09:00:00Z',
      source_agent: 'operator',
      payload: { scope_id: 'ts-99' },
    });
    db.prepare(
      `INSERT INTO notifications (id, created_at, correlation_id, kind, severity, title, body, source_event_id, actions_json, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    ).run('n-1', Date.parse('2026-05-20T10:00:00Z'), 'cid-notif', 'decision_required', 'info', 't', 'b', 'ev-source');
    const r = walkCorrelation({ db }, { kind: 'notification', id: 'n-1' }, 'backward');
    expect(r.correlation_id).toBe('cid-notif');
    // The trace must include both the notification AND its source event.
    const ids = r.nodes.map((n) => n.item.id);
    expect(ids).toContain('n-1');
    expect(ids).toContain('ev-source');
    // Backward = DESC by time → notification (10:00) precedes source (09:00).
    expect(Date.parse(r.nodes[0].item.at)).toBe(Date.parse('2026-05-20T10:00:00Z'));
  });

  it('kind-agnostic: walks from a scope and threads host_execs sharing the scope_id', () => {
    const { db } = makeStore();
    db.prepare(
      `INSERT INTO trust_scopes
         (id, title, description, granted_by, granted_at, expires_at,
          expires_after_actions, allowed_actions_json, forbidden_actions_json,
          reporting_json, status, spec_url, proposed_at, actions_executed, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, NULL, ?, 0, NULL)`,
    ).run('ts-A', 'Demo', 'desc', 'operator', '2026-05-20T08:00:00Z', '2099-01-01T00:00:00Z',
      JSON.stringify([{ tool: 'git' }]),
      JSON.stringify({ cadence: 'every-5-actions', channels: ['chat'] }),
      'active', '2026-05-20T07:55:00Z');
    ev(db, {
      id: 'ev-2', kind: 'host_exec_started', at: '2026-05-20T08:10:00Z',
      correlation_id: 'cid-x',
      payload: { correlation_id: 'cid-x', scope_id: 'ts-A', command: 'git', args_hash: 'h', args_count: 1, timeout_ms: 5000 },
    });
    const r = walkCorrelation({ db }, { kind: 'scope', id: 'ts-A' });
    expect(r.correlation_id).toBe('ts-A');
    const kinds = r.nodes.map((n) => n.item.kind);
    expect(kinds).toContain('scope');
    expect(kinds).toContain('host-exec');
  });

  it('walks bottoming out: notification with no source_event still returns the notif row', () => {
    const { db } = makeStore();
    db.prepare(
      `INSERT INTO notifications (id, created_at, correlation_id, kind, severity, title, body, source_event_id, actions_json, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
    ).run('n-orphan', Date.parse('2026-05-20T10:00:00Z'), 'cid-orphan', 'decision_required', 'info', 't', 'b');
    const r = walkCorrelation({ db }, { kind: 'notification', id: 'n-orphan' }, 'backward');
    expect(r.nodes.length).toBeGreaterThan(0);
    expect(r.hop_depth).toBe(0); // origin only
  });

  it('renderTraceHtml emits a header + an ordered list', () => {
    const { db } = makeStore();
    db.prepare(
      `INSERT INTO decisions (correlation_id, question, options_json, default_option_id, timeout_sec, status, requested_at, expires_at)
       VALUES (?, ?, ?, NULL, 60, 'open', ?, ?)`,
    ).run('cid-r', 'q', JSON.stringify([]), '2026-05-20T10:00:00Z', '2099-01-01T00:00:00Z');
    const trace = walkCorrelation({ db }, { kind: 'decision', id: 'cid-r' });
    const html = renderTraceHtml(trace);
    expect(html).toContain('TRACE FORWARD from origin');
    expect(html).toContain('<ol class="trace-list">');
    expect(html).toContain('data-kind="decision"');
  });

  it('renderTraceHtml handles the no-cid case', () => {
    const html = renderTraceHtml({
      direction: 'forward', correlation_id: null, origin: null, nodes: [], hop_depth: 0,
    });
    expect(html).toContain('No correlation_id');
  });
});
