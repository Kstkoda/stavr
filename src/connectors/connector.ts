// src/connectors/connector.ts
//
// Extension interface for "orange brick" connectors. Anything external that
// isn't already an MCP server (Wiser, Unifi, Roblox, Unity, SMTP, webhooks,
// custom scripts, vendor APIs) implements this interface. cowire treats them
// uniformly: register, configure, expose capabilities, route through the
// no-go list, audit every exec.
//
// Each concrete connector lives in src/connectors/{name}.ts.

import type { CapabilityTag, RiskClass } from '../types/cowire-bom.js';

// ============================================================
// CONNECTOR INTERFACE
// ============================================================

export interface Connector {
  /** Unique id within cowire, e.g. 'wiser', 'unifi-main', 'webhook-stripe'. */
  id: string;

  /** Kind groups instances. Two wiser homes share kind='wiser'. */
  kind: string;

  /** Display name shown on the brick label in the toolkit. */
  displayName: string;

  /**
   * Visual position on the toolkit canvas:
   *   'above' = external (cloud, internet-facing)
   *   'below' = internal (LAN, local machine)
   * Carries a trust dimension — `above` connectors are gated more strictly.
   */
  position: 'above' | 'below';

  /** Path to a brand logo or null for the default plug icon. */
  logoPath: string | null;

  // -------- Configuration --------

  /** JSON-schema-ish field list the inspector uses to render a form. */
  configSchema(): ConfigFieldSchema[];

  /**
   * Apply a config update. Validates and persists (via the credentials
   * vault for secrets). Returns the new status.
   */
  applyConfig(config: Record<string, unknown>): Promise<ConnectorStatus>;

  // -------- Health --------

  /** Test the configured connection without side effects. */
  testConnection(): Promise<ConnectorStatus>;

  /** Current cached status. Use testConnection() for a fresh probe. */
  status(): ConnectorStatus;

  // -------- Capabilities --------

  /**
   * What this connector exposes to the steward. Each capability is a tool
   * the planner can include in a BOM step. Individual capabilities can be
   * disabled via `enabled: false` without disabling the connector.
   */
  capabilities(): ConnectorCapability[];

  /**
   * Execute one capability call. Risk-class check, no-go list, audit, and
   * budget enforcement happen in the framework layer — the connector just
   * does the work.
   */
  exec(
    capabilityId: string,
    args: Record<string, unknown>,
    ctx: ExecContext,
  ): Promise<ExecResult>;
}

// ============================================================
// SUPPORTING TYPES
// ============================================================

export type ConfigFieldKind =
  | 'text'
  | 'password'
  | 'url'
  | 'select'
  | 'toggle'
  | 'number'
  | 'headers'
  | 'schedule'
  | 'path'
  | 'oauth'
  | 'json';

export interface ConfigFieldSchema {
  key: string;
  label: string;
  kind: ConfigFieldKind;
  hint?: string;
  options?: { value: string; label: string }[];
  required?: boolean;
  default?: unknown;
  /** Stored encrypted, never echoed back in API responses. */
  secret?: boolean;
}

export type ConnectorStatusKind = 'ok' | 'needs_setup' | 'error' | 'disabled';

export interface ConnectorStatus {
  kind: ConnectorStatusKind;
  /** Human-readable summary shown on the brick and inspector. */
  detail: string;
  /** When this status was last verified. ISO timestamp. */
  lastChecked: string;
}

export interface ConnectorCapability {
  /** Stable id used in BOM step.brick_id + capabilityId reference. */
  id: string;
  description: string;
  capabilityTag: CapabilityTag;
  riskClass: RiskClass;
  argsSchema: ConfigFieldSchema[];
  enabled: boolean;
}

export interface ExecContext {
  workerId: string;
  bomId?: string;
  stepNo?: number;
  scopeId?: string;
  profileMode: 'turbo' | 'balanced' | 'eco';
}

export interface ExecResult {
  ok: boolean;
  data?: unknown;
  /** Cost in USD this exec consumed (API spend, paid quota, etc.). */
  cost?: number;
  durationMs: number;
  error?: string;
  /** Optional structured events to emit (e.g., 'wiser_climate_changed'). */
  emitEvents?: { kind: string; payload: unknown }[];
}

// ============================================================
// REGISTRY INTERFACE
// ============================================================

/**
 * Global registry of installed connectors. Indexed by id. The daemon owns
 * one instance. Implementations may be in-memory only (stub) or DB-backed
 * (production, persists across daemon restarts via the connectors / bricks
 * tables).
 */
export interface ConnectorRegistry {
  register(connector: Connector): void;
  unregister(id: string): boolean;
  get(id: string): Connector | undefined;
  list(): Connector[];
  listByKind(kind: string): Connector[];
  /**
   * Capabilities aggregated across all registered, enabled connectors.
   * The "art of the possible" — fed to the planner.
   */
  allCapabilities(): { connectorId: string; capability: ConnectorCapability }[];
}
