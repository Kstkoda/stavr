/**
 * In-memory SQLite helper for history fetcher tests. Spins up an
 * EventStore against `:memory:` and exposes the raw DB so the fetcher
 * can read it directly.
 */
import { EventStore } from '../../../../src/persistence.js';
import type { Database } from '../../../../src/db/index.js';

export function makeStore(): { store: EventStore; db: Database } {
  const store = new EventStore();
  store.init(':memory:');
  return { store, db: store.rawDb };
}
