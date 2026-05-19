/**
 * Federation event reporter — wires PeerRegistry changes onto the broker
 * as `peer_joined` / `peer_left` events so dashboard subscribers (the
 * family-mode page in Phase 5) and federation-audit consumers see the
 * same fact pattern they see for every other broker event.
 *
 * Kept separate from `peer-registry.ts` so the registry remains pure /
 * easily unit-testable and free of broker coupling.
 */
import type { Broker } from '../broker.js';
import type { PeerRegistry } from './peer-registry.js';
import type { PeerRecord } from '../types/federation.js';

export interface ReporterOptions {
  /** The reporter records which peer ids it has ever published a
   *  peer_joined for; the first `changed` event for a new peer fires
   *  peer_joined, subsequent ones are silent. Tests can inject a
   *  pre-seeded set if they want to verify "already-joined" behavior. */
  alreadyJoined?: Set<string>;
}

export function attachFederationReporter(
  registry: PeerRegistry,
  broker: Broker,
  opts: ReporterOptions = {},
): () => void {
  const joined = opts.alreadyJoined ?? new Set<string>();

  const onChanged = (rec: PeerRecord): void => {
    if (joined.has(rec.id)) return;
    joined.add(rec.id);
    void broker.publish({
      kind: 'peer_joined',
      at: new Date().toISOString(),
      source_agent: 'stavr-federation',
      payload: {
        peer_id: rec.id,
        display_name: rec.display_name,
        hostname: rec.hostname,
        port: rec.port,
        trust: rec.trust,
        configured: rec.configured,
        discovered: rec.discovered,
      },
    });
  };

  const onRemoved = (peerId: string): void => {
    if (!joined.has(peerId)) return;
    joined.delete(peerId);
    void broker.publish({
      kind: 'peer_left',
      at: new Date().toISOString(),
      source_agent: 'stavr-federation',
      payload: {
        peer_id: peerId,
        reason: 'config_removed',
      },
    });
  };

  registry.on('changed', onChanged);
  registry.on('removed', onRemoved);

  return () => {
    registry.off('changed', onChanged);
    registry.off('removed', onRemoved);
  };
}
