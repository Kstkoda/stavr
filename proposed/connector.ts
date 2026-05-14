// connector.ts — proposed extension interface for orange "Connector" bricks
//
// Anything external that isn't already an MCP server (Wiser, Unifi, Roblox, Unity,
// SMTP, webhooks, custom scripts, vendor APIs) implements this interface.
// cowire treats them uniformly: register, authenticate, expose capabilities,
// route through no-go list, log all exec.
//
// Put this in src/connectors/connector.ts. Each concrete connector lives in
// src/connectors/{wiser,unifi,roblox,unity,webhook,...}.ts and exports an
// instance via `register*Connector(registry)`.

import type { RiskClass, CapabilityTag } from './types';

// ============================================================
// CONNECTOR INTERFACE
// ============================================================

/**
 * A Connector is a registered orange brick on the cowire toolkit canvas.
 * It wraps an external service or local capability that doesn't speak MCP.
 *
 * Lifecycle:
 *   register → configure (auth) → testConnection → exposeCapabilities → exec
 *
 * The steward sees connectors as capability-providing components; the user sees
 * them as draggable bricks with editable config.
 */
export interface Connector {
  /** Unique id within cowire, e.g. 'wiser', 'unifi-main', 'webhook-stripe' */
  id: string;

  /** Kind groups instances. Wiser brick + custom Wiser instance share kind='wiser'. */
  kind: string;

  /** Display name on the brick label */
  displayName: string;

  /**
   * Visual position on the toolkit canvas:
   *   'above' = external (cloud, internet-facing)
   *   'below' = internal (LAN, local machine)
   * Carries the trust dimension. The no-go list policy is stricter for 'above'.
   */
  position: 'above' | 'below';

  /**
   * Path to a brand logo or null for the default plug icon.
   * Resolved against the dashboard's static asset directory.
   * Convention: assets/connectors/{kind}.svg
   */
  logoPath: string | null;

  // -------- Configuration --------

  /**
   * JSON schema describing the config fields this connector needs.
   * The inspector renders a form from this. Field types: text, password,
   * select, toggle, headers, schedule, path.
   */
  configSchema(): ConfigFieldSchema[];

  /**
   * Apply a config update. Validates and persists. Encrypted via the
   * existing credentials infrastructure. Returns the new status.
   */
  applyConfig(config: Record<string, unknown>): Promise<ConnectorStatus>;

  // -------- Health --------

  /**
   * Test the configured connection without side effects.
   * Used by the "Test" button in the inspector and periodic health checks.
   */
  testConnection(): Promise<ConnectorStatus>;

  /** Current status — cached, can be stale. Use testConnection() for fresh. */
  status(): ConnectorStatus;

  // -------- Capabilities --------

  /**
   * What this connector exposes to the steward. Each capability becomes a tool
   * the planner can include in a BOM step. Tools can be individually toggled
   * on/off in the connector's edit panel.
   */
  capabilities(): ConnectorCapability[];

  /**
   * Execute one capability call. Risk class, no-go check, and audit logging
   * happen in the framework layer — the connector just does the work.
   * Returns the result payload to be embedded in the worker's response.
   */
  exec(
    capabilityId: string,
    args: Record<string, unknown>,
    ctx: ExecContext
  ): Promise<ExecResult>;
}

// ============================================================
// SUPPORTING TYPES
// ============================================================

export interface ConfigFieldSchema {
  key: string;
  label: string;
  /** Field type drives which form input the inspector renders */
  kind:
    | 'text'
    | 'password'
    | 'url'
    | 'select'
    | 'toggle'
    | 'number'
    | 'headers'        // key-value list
    | 'schedule'       // cron-like with friendly picker
    | 'path'           // filesystem path with browser
    | 'oauth'          // shows "Connect" button, opens OAuth flow
    | 'json';
  /** Help text shown under the input */
  hint?: string;
  /** For 'select' fields */
  options?: { value: string; label: string }[];
  /** Required for save */
  required?: boolean;
  /** Default value */
  default?: unknown;
  /** Marks the field as secret — stored encrypted, never echoed */
  secret?: boolean;
}

export type ConnectorStatusKind = 'ok' | 'needs_setup' | 'error' | 'disabled';

export interface ConnectorStatus {
  kind: ConnectorStatusKind;
  /** Human-readable summary shown on the brick and in the inspector */
  detail: string;
  /** When this status was last verified */
  lastChecked: string; // ISO timestamp
}

export interface ConnectorCapability {
  /** Stable id used in BOM step.brick_id + capabilityId reference */
  id: string;
  /** Plain-English what this capability does — shown in the planner */
  description: string;
  /** Drives default model selection */
  capabilityTag: CapabilityTag;
  /** Drives no-go list checks */
  riskClass: RiskClass;
  /** JSON schema for the args passed to exec() */
  argsSchema: ConfigFieldSchema[];
  /** Whether this specific capability is enabled. Individual tools can be off
   *  even if the connector is on. */
  enabled: boolean;
}

export interface ExecContext {
  /** Calling worker id */
  workerId: string;
  /** BOM correlation, if this exec is part of a planned step */
  bomId?: string;
  stepNo?: number;
  /** Active trust scope */
  scopeId?: string;
  /** Profile mode at exec time (for audit) */
  profileMode: 'turbo' | 'balanced' | 'eco';
}

export interface ExecResult {
  ok: boolean;
  /** Result payload — connector-specific */
  data?: unknown;
  /** Cost in USD this exec consumed (API spend, compute, etc.) */
  cost?: number;
  /** Duration in milliseconds */
  durationMs: number;
  /** Set when ok=false */
  error?: string;
  /** Optional structured events to emit (e.g., 'wiser_climate_changed') */
  emitEvents?: { kind: string; payload: unknown }[];
}

// ============================================================
// REGISTRY
// ============================================================

/**
 * Global registry of installed connectors. Indexed by id.
 * Daemon owns one instance. Persisted (config + status) in the connectors table.
 */
export interface ConnectorRegistry {
  register(connector: Connector): void;
  get(id: string): Connector | undefined;
  list(): Connector[];
  listByKind(kind: string): Connector[];
  /** Capabilities aggregated across all registered, enabled connectors.
   *  This is what the steward sees as "the art of the possible." */
  allCapabilities(): { connectorId: string; capability: ConnectorCapability }[];
}

// ============================================================
// EXAMPLE — Wiser connector skeleton (for reference)
// ============================================================
//
// Drop this in src/connectors/wiser.ts and import it from src/connectors/index.ts.
// Real implementation would use Schneider's API SDK.
//
// export class WiserConnector implements Connector {
//   id = 'wiser';
//   kind = 'wiser';
//   displayName = 'Wiser';
//   position = 'above' as const;
//   logoPath = 'assets/connectors/wiser.svg';
//
//   private config: WiserConfig | null = null;
//   private cachedStatus: ConnectorStatus = { kind: 'needs_setup', detail: 'Not configured', lastChecked: new Date().toISOString() };
//
//   configSchema(): ConfigFieldSchema[] {
//     return [
//       { key: 'home_id', label: 'Home ID', kind: 'text', required: true, hint: 'Find in Wiser app → Settings → Home' },
//       { key: 'access_token', label: 'OAuth', kind: 'oauth', secret: true, required: true },
//       { key: 'devices', label: 'Devices to expose', kind: 'json', hint: 'Leave blank for all' },
//     ];
//   }
//
//   async applyConfig(config: Record<string, unknown>): Promise<ConnectorStatus> { /* ... */ }
//   async testConnection(): Promise<ConnectorStatus> { /* ... */ }
//   status(): ConnectorStatus { return this.cachedStatus; }
//
//   capabilities(): ConnectorCapability[] {
//     return [
//       { id: 'wiser_get_temp', description: 'Read temperature in a room', capabilityTag: 'reading', riskClass: 'read-only', argsSchema: [{ key: 'room', label: 'Room', kind: 'text', required: true }], enabled: true },
//       { id: 'wiser_set_temp', description: 'Set target temperature in a room', capabilityTag: 'code-execution', riskClass: 'write-remote', argsSchema: [{ key: 'room', label: 'Room', kind: 'text', required: true }, { key: 'celsius', label: 'Target °C', kind: 'number', required: true }], enabled: true },
//       { id: 'wiser_schedule', description: 'Read or modify heating schedules', capabilityTag: 'code-execution', riskClass: 'write-remote', argsSchema: [], enabled: false },
//     ];
//   }
//
//   async exec(capabilityId: string, args, ctx): Promise<ExecResult> {
//     // Implement per capability, with the Wiser API client.
//   }
// }

// ============================================================
// FRAMEWORK NOTES
// ============================================================
//
// The daemon enforces these around every connector.exec() call:
//
// 1. Pre-flight: look up the connector's capability definition, derive risk_class.
//    Run no-go list match. If matched, emit decision_request, await user click.
//
// 2. Scope check: if a BOM scope is active, confirm risk_class is within the
//    scope's allowed envelope. If not, escalate via decision_request.
//
// 3. Audit: emit a 'tool_called' event with full args (secrets redacted),
//    connector id, capability id, worker id, scope id.
//
// 4. Budget: if profile mode has a per-job cap and this exec would breach it,
//    block and emit decision_request.
//
// 5. Invoke: call connector.exec(). Wrap in timeout (default 30s, configurable).
//
// 6. Post: persist ExecResult, emit 'tool_result' event with cost + duration.
//    On error, increment retry counter, schedule retry per profile policy.
//
// Connectors themselves don't have to know any of this — they just implement
// the interface. All gating, auditing, and policy lives in the framework layer.
