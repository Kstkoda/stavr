import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EventStore, StoredEvent } from './persistence.js';
import type { Event, EventKindT } from './event-types.js';
import { getLogger } from './log.js';
import { recordBrokerEvent } from './observability/metrics.js';
import { runWithCorrelation } from './observability/logger.js';
import { addBrokerSpanEvent } from './observability/spans.js';

interface Subscription {
  sessionId: string;
  server: McpServer;
  kinds: Set<string>;
}

export const EVENT_NOTIFICATION_METHOD = 'notifications/event/published';

export type EventTap = (event: StoredEvent) => void;

export class Broker {
  private subscribers = new Map<string, Subscription>();
  private taps = new Set<EventTap>();
  private rawListeners = new Set<(ev: StoredEvent) => void>();

  constructor(public readonly store: EventStore) {}

  /**
   * Register a non-MCP listener that receives every fanned-out event. Used by
   * the dashboard SSE endpoint (spec 40 Phase 3) so the browser can tail the
   * live event log without going through the MCP handshake. Returns a
   * dispose fn that removes the listener.
   */
  onEvent(tap: EventTap): () => void {
    this.taps.add(tap);
    return () => {
      this.taps.delete(tap);
    };
  }

  onRawEvent(cb: (ev: StoredEvent) => void): () => void {
    this.rawListeners.add(cb);
    return () => this.rawListeners.delete(cb);
  }

  registerSession(sessionId: string, server: McpServer): void {
    if (!this.subscribers.has(sessionId)) {
      this.subscribers.set(sessionId, { sessionId, server, kinds: new Set() });
    }
  }

  /** Distinct sessions that have registered (regardless of whether they subscribed to anything). */
  sessionCount(): number {
    return this.subscribers.size;
  }

  /** Total kind-subscriptions across all sessions (counts each kind once per session). */
  subscriptionCount(): number {
    let n = 0;
    for (const sub of this.subscribers.values()) n += sub.kinds.size;
    return n;
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
    // Graceful degradation (spec 44 invariant 5): if persistence fails we
    // surface an error event back to subscribers but never throw — a broken
    // SQLite write must not kill an in-flight tool call. Callers that need to
    // detect persistence failure can check whether the returned event has an
    // `id` shaped like a UUID.
    let stored: StoredEvent;
    try {
      stored = this.store.appendEvent(event);
    } catch (err) {
      getLogger().error('event store append failed', {
        kind: event.kind,
        source_agent: event.source_agent,
        error: (err as Error).message,
      });
      // Synthesize an in-memory stored event so fanout still happens. Subscribers
      // see the event live; it just won't be in the replay log on next subscribe.
      stored = {
        id: randomUUID(),
        persisted_at: new Date().toISOString(),
        ...event,
      };
    }
    // Record metrics + run downstream fanout under the event's correlation_id
    // so any logger calls inside subscribers auto-tag with it (BOM diagnostics
    // 2026 C1.6).
    try {
      recordBrokerEvent(stored);
    } catch {
      /* metrics must never break fanout */
    }
    // bom-diagnostics-2026 C2.3 — register the emission as an addEvent on
    // the active OTel span (if any) rather than a new span. The event log
    // is the system-of-record; spans only need to know that an emission
    // happened during the active request/operation. No-op when no SDK is
    // configured or no span is active — span explosion is the failure mode
    // we're avoiding.
    try {
      addBrokerSpanEvent(stored.kind, {
        correlationId: stored.correlation_id,
        sourceAgent: stored.source_agent,
      });
    } catch {
      /* spans must never break fanout */
    }
    const cid = stored.correlation_id;
    if (cid) {
      await runWithCorrelation(cid, async () => {
        await this.fanout(stored);
      });
    } else {
      await this.fanout(stored);
    }
    for (const cb of this.rawListeners) {
      try { cb(stored); } catch { /* isolate raw listener failures */ }
    }
    return stored;
  }

  async fanout(stored: StoredEvent): Promise<void> {
    const payload = { ...stored };
    for (const tap of this.taps) {
      try {
        tap(stored);
      } catch {
        // Dashboard listener errors must never break MCP fanout.
      }
    }
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
