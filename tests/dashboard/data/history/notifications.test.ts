import { describe, expect, it } from 'vitest';
import { fetchNotificationsHistory } from '../../../../src/dashboard/data/history/notifications.js';
import { makeStore } from './helpers.js';
import type { Database } from '../../../../src/db/index.js';

let seq = 1000;
function seedSourceEvent(db: Database, sourceAgent: string, eventId: string): void {
  db.prepare(
    `INSERT INTO events (id, kind, correlation_id, source_agent, tenant_id, payload_json, at, persisted_at, seq, created_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
  ).run(eventId, 'notification_requested', null, sourceAgent, '{}', '2026-05-20T10:00:00Z', '2026-05-20T10:00:00Z', seq++, '2026-05-20T10:00:00Z');
}

function seedNotification(db: Database, args: {
  id: string;
  correlation_id: string;
  severity?: string;
  source_event_id?: string;
  created_at?: number;
  failed_channels?: string;
}): void {
  db.prepare(
    `INSERT INTO notifications (id, created_at, correlation_id, kind, severity, title, body,
        source_event_id, actions_json, expires_at, delivered_channels, failed_channels)
     VALUES (?, ?, ?, 'decision_required', ?, ?, 'body', ?, NULL, NULL, NULL, ?)`,
  ).run(
    args.id,
    args.created_at ?? Date.parse('2026-05-20T10:00:00Z'),
    args.correlation_id,
    args.severity ?? 'info',
    `title-${args.id}`,
    args.source_event_id ?? null,
    args.failed_channels ?? null,
  );
}

describe('fetchNotificationsHistory', () => {
  it('returns rows sorted by created_at DESC', () => {
    const { db } = makeStore();
    seedNotification(db, { id: 'n1', correlation_id: 'c1', created_at: Date.parse('2026-05-20T08:00:00Z') });
    seedNotification(db, { id: 'n2', correlation_id: 'c2', created_at: Date.parse('2026-05-20T10:00:00Z') });
    seedNotification(db, { id: 'n3', correlation_id: 'c3', created_at: Date.parse('2026-05-20T09:00:00Z') });
    const page = fetchNotificationsHistory({ db });
    expect(page.items.map((i) => i.id)).toEqual(['n2', 'n3', 'n1']);
  });

  it('returns empty page when notifications table is empty', () => {
    const { db } = makeStore();
    expect(fetchNotificationsHistory({ db }).items).toEqual([]);
  });

  it('attributes source_agent via the joined event + supports filters', () => {
    const { db } = makeStore();
    seedSourceEvent(db, 'steward-agent', 'ev-1');
    seedSourceEvent(db, 'cowork-claude', 'ev-2');
    seedNotification(db, { id: 'n1', correlation_id: 'c1', source_event_id: 'ev-1', severity: 'crit' });
    seedNotification(db, { id: 'n2', correlation_id: 'c2', source_event_id: 'ev-2', severity: 'info', created_at: Date.parse('2026-05-20T11:00:00Z') });
    const all = fetchNotificationsHistory({ db });
    const byId = new Map(all.items.map((i) => [i.id, i]));
    expect(byId.get('n1')?.actor).toBe('steward-agent');
    expect(byId.get('n2')?.actor).toBe('cowork-claude');
    expect(byId.get('n1')?.status).toBe('failure');

    const onlySteward = fetchNotificationsHistory({ db }, { sourceAgent: 'steward-agent' });
    expect(onlySteward.items.map((i) => i.id)).toEqual(['n1']);
    const onlyInfo = fetchNotificationsHistory({ db }, { severity: 'info' });
    expect(onlyInfo.items.map((i) => i.id)).toEqual(['n2']);
  });

  it('marks failed dispatch as failure regardless of severity', () => {
    const { db } = makeStore();
    seedNotification(db, { id: 'n1', correlation_id: 'c1', severity: 'info', failed_channels: 'telegram' });
    const page = fetchNotificationsHistory({ db });
    expect(page.items[0].status).toBe('failure');
  });
});
