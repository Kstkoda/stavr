// src/connectors/index.ts
//
// In-memory ConnectorRegistry implementation. Used as the daemon's default;
// the brick installer (src/bricks/*) augments it with persistence for
// user-installed bricks.

import type {
  Connector,
  ConnectorCapability,
  ConnectorRegistry,
} from './connector.js';

export type {
  Connector,
  ConnectorCapability,
  ConnectorRegistry,
  ConfigFieldSchema,
  ConfigFieldKind,
  ConnectorStatus,
  ConnectorStatusKind,
  ExecContext,
  ExecResult,
} from './connector.js';

export class InMemoryConnectorRegistry implements ConnectorRegistry {
  private byId = new Map<string, Connector>();

  register(connector: Connector): void {
    if (this.byId.has(connector.id)) {
      throw new Error(`connector ${connector.id} already registered`);
    }
    this.byId.set(connector.id, connector);
  }

  unregister(id: string): boolean {
    return this.byId.delete(id);
  }

  get(id: string): Connector | undefined {
    return this.byId.get(id);
  }

  list(): Connector[] {
    return Array.from(this.byId.values());
  }

  listByKind(kind: string): Connector[] {
    return this.list().filter((c) => c.kind === kind);
  }

  allCapabilities(): { connectorId: string; capability: ConnectorCapability }[] {
    const out: { connectorId: string; capability: ConnectorCapability }[] = [];
    for (const c of this.byId.values()) {
      for (const cap of c.capabilities()) {
        if (!cap.enabled) continue;
        out.push({ connectorId: c.id, capability: cap });
      }
    }
    return out;
  }
}
