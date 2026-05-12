import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EventStore, StoredEvent } from './persistence.js';
import type { Event, EventKindT } from './event-types.js';

interface Subscription {
  sessionId: string;
  server: McpServer;
  kinds: Set<string>;
}

export const EVENT_NOTIFICATION_METHOD = 'notifications/event/published';

export class Broker {
  private subscribers = new Map<string, Subscription>();

  constructor(public readonly store: EventStore) {}

  registerSession(sessionId: string, server: McpServer): void {
    if (!this.subscribers.has(sessionId)) {
      this.subscribers.set(sessionId, { sessionId, server, kinds: new Set() });
    }
  }

  removeSession(sessionId: string): void {
    this.subscribers.delete(sessionId);
  }

  subscribe(sessionId: string, kinds: string[]): { subscription_id: string; kinds: string[] } {
    const sub = this.subscribers.get(sessionId);
    if (!sub) throw new Error(`Unknown session ${sessionId}`);
    for (const k of kinds) sub.kinds.add(k);
    return { subscription_id: sessionId, kinds: Array.from(sub.kinds) };
  }

  unsubscribe(sessionId: string, kinds?: string[]): void {
    const sub = this.subscribers.get(sessionId);
    if (!sub) return;
    if (!kinds || kinds.length === 0) {
      sub.kinds.clear();
      return;
    }
    for (const k of kinds) sub.kinds.delete(k);
  }

  hasSubscription(sessionId: string, kind: string): boolean {
    const sub = this.subscribers.get(sessionId);
    if (!sub) return false;
    return sub.kinds.has(kind) || sub.kinds.has('*');
  }

  async publish(event: Event): Promise<StoredEvent> {
    const stored = this.store.appendEvent(event);
    await this.fanout(stored);
    return stored;
  }

  async fanout(stored: StoredEvent): Promise<void> {
    const payload = { ...stored };
    for (const sub of this.subscribers.values()) {
      if (sub.kinds.has(stored.kind) || sub.kinds.has('*')) {
        try {
          await sub.server.server.notification({
            method: EVENT_NOTIFICATION_METHOD,
            params: payload as unknown as Record<string, unknown>,
          });
        } catch {
          // Connection probably gone; clean up on next emit.
          this.subscribers.delete(sub.sessionId);
        }
      }
    }
  }

  async replayTo(sessionId: string, sinceEventId: string, kinds?: string[]): Promise<number> {
    const sub = this.subscribers.get(sessionId);
    if (!sub) return 0;
    const filter: Parameters<EventStore['getEvents']>[0] = { sinceEventId };
    if (kinds && kinds.length > 0 && !kinds.includes('*')) filter.kinds = kinds;
    const { events } = this.store.getEvents(filter);
    for (const ev of events) {
      try {
        await sub.server.server.notification({
          method: EVENT_NOTIFICATION_METHOD,
          params: ev as unknown as Record<string, unknown>,
        });
      } catch {
        this.subscribers.delete(sessionId);
        break;
      }
    }
    return events.length;
  }
}

export function newSessionId(): string {
  return randomUUID();
}

export function isKnownKind(kind: string, knownKinds: readonly EventKindT[]): boolean {
  return (knownKinds as readonly string[]).includes(kind);
}
