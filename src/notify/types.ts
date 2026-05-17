// v0.6 notifications — type contracts.
//
// All notification kinds + severities the daemon emits. Channels are
// orthogonal: any kind can go through any channel (ntfy/email/telegram/webhook).

export type NotificationKind =
  | 'decision_required'
  | 'scope_expired'
  | 'scope_expiring'
  | 'health_alert'
  | 'work_complete'
  | 'digest';

export type NotificationSeverity = 'info' | 'warn' | 'crit';

export type NotificationActionKind = 'approve' | 'deny' | 'ignore' | 'link' | 'grant_extension';

export interface NotificationAction {
  /** Label shown on the button. */
  label: string;
  /** Stable identifier used by the reply-router to dispatch the action. */
  action_id: string;
  kind: NotificationActionKind;
  /** Optional URL for `kind: 'link'` actions (open-dashboard etc.). */
  url?: string;
  /** Identifier the reply-router uses to find the underlying object
   *  (decision_id, scope_id, etc.). Opaque to the notifier. */
  target_id?: string;
}

export interface Notification {
  kind: NotificationKind;
  severity: NotificationSeverity;
  title: string;
  body: string;
  actions?: NotificationAction[];
  /** Originating event id if emitted in response to one. */
  sourceEventId?: string;
  /** Reply window in ms. Defaults: 5 min for decisions, none for info. */
  ttlMs?: number;
  /** Optional: federation/spawn id (per ADR-035). Reserved for v0.7+. */
  originSpawnId?: string;
}

export interface NotificationDispatch {
  /** ntfy / email / telegram / webhook */
  channelId: string;
  ok: boolean;
  error?: string;
}

export interface NotificationResult {
  /** Notification row id (UUID). */
  id: string;
  /** Signed correlation id used by reply links. */
  correlationId: string;
  dispatchedChannels: string[];
  failedChannels: string[];
  /** True if at least one channel returned 2xx. */
  delivered: boolean;
}

export interface NotificationChannel {
  /** Stable id: 'ntfy', 'email', 'telegram', 'webhook'. */
  readonly id: string;
  /** True if the channel has the env vars it needs to publish. */
  isConfigured(): boolean;
  /** Send the notification. Must not throw; return ok=false on error. */
  send(opts: ChannelSendInput): Promise<NotificationDispatch>;
}

export interface ChannelSendInput {
  notificationId: string;
  correlationId: string;
  kind: NotificationKind;
  severity: NotificationSeverity;
  title: string;
  body: string;
  actions: NotificationAction[];
  /** Base URL the daemon publishes on (used to build reply links).
   *  Channels that don't need it (telegram inline buttons) ignore it. */
  replyBaseUrl?: string;
  /** Pre-signed reply links keyed by action_id. */
  replyUrls: Record<string, string>;
  /** Operator-friendly chip the channel can prepend to the body. */
  severityLabel: string;
}

export interface ChannelStatus {
  id: string;
  configured: boolean;
  enabled: boolean;
  lastSuccessAt?: number;
  lastError?: string;
  lastErrorAt?: number;
}

export interface NotificationRecord {
  id: string;
  created_at: number;
  correlation_id: string;
  kind: NotificationKind;
  severity: NotificationSeverity;
  title: string;
  body: string;
  source_event_id?: string;
  actions_json?: string;
  expires_at?: number;
  delivered_channels?: string;
  failed_channels?: string;
  consumed_at?: number;
  consumed_by?: string;
}
