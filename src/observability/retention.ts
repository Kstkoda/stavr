/**
 * Kind-aware event retention. Two classes, two policies:
 *
 *  - OPERATIONAL: high-volume telemetry (heap samples, worker progress,
 *    SSE session lifecycle, retention bookkeeping). Aggressive prune —
 *    7 days OR 100k rows total, whichever fires first. No audit value;
 *    deleted rows are gone for good.
 *
 *  - AUDIT: low-volume policy / identity / decision events. Long retention
 *    (90 days, no row cap by default). Preserves what the 2026 agentic-
 *    observability guidance calls out as audit-bearing: policy evaluation
 *    outcomes, identity context, delegation lineage, decision timestamps.
 *
 *  - UNKNOWN: any kind not in either set. Treated conservatively — NOT
 *    deleted; a warning is logged so the operator extends this file. This
 *    is intentional: a forgotten kind is better preserved than vanished.
 *
 * Driven from `EventStore.pruneEvents` (src/persistence.ts). The retention
 * scheduler in src/daemon.ts runs prune at boot + every 60 minutes and
 * emits `retention_swept` events with the deletion counts.
 */

/**
 * High-volume operational kinds. Re-add anything that gets emitted more
 * than ~1/min and has no audit value.
 */
export const OPERATIONAL_KINDS: ReadonlySet<string> = new Set([
  'daemon_memory',
  'daemon_eventloop',
  'daemon_host_headroom',
  'worker_progress',
  'worker_log',
  'sse_session_opened',
  'sse_session_closed',
  'sse_session_force_removed',
  'mcp_session_deleted',
  'mcp_oneshot_cleanup',
  'retention_swept',
  'perf_sample',
]);

/**
 * Low-volume audit-bearing kinds. These outlast operational telemetry —
 * even a stripped-down compliance-grade audit log should keep these for
 * 90 days minimum. Don't move any of these to OPERATIONAL without a
 * separate compliance review.
 */
export const AUDIT_KINDS: ReadonlySet<string> = new Set([
  // Trust scopes — full lineage
  'trust_scope_proposed',
  'trust_scope_granted',
  'trust_scope_progress',
  'trust_scope_action_authorized',
  'trust_scope_revoked',
  'trust_scope_extended',
  'trust_scope_completed',
  // worker-dispatch Phase 4 — grant-scope-aware enforcement audit events.
  // Every grant decision (consumed or denied) is audit-bearing — it's the
  // forensic record of who used what budget when and why anything was
  // refused at the JobOrchestrator gate.
  'grant_consumed',
  'grant_denied',
  // Decisions — every user/operator approval or refusal
  'decision_request',
  'decision_response',
  'decision_late_response',
  // BOMs — plan lifecycle
  'bom_proposed',
  'bom_approved',
  'bom_rejected',
  'bom_cancelled',
  'bom_completed',
  'bom_failed',
  'bom_replanned',
  'bom_edited',
  'bom_step_started',
  'bom_step_completed',
  'bom_step_failed',
  'bom_step_skipped',
  'bom_step_promoted',
  // Workers — spawn/terminate (start/stop) but NOT progress (that's operational)
  'worker_spawned',
  'worker_terminated',
  'worker_error',
  'worker_stuck',
  // Steward — session lifecycle + every prompt/response
  'steward_claimed',
  'steward_released',
  'steward_handoff',
  'steward_pulse',
  'steward_started',
  'steward_stopped',
  'steward_prompt',
  'steward_response',
  'steward_paused_for_budget',
  'steward_resumed',
  'steward_usage',
  // Credentials — audit every grant/use/revoke
  'credential_added',
  'credential_used',
  'credential_revoked',
  'credential_grant_added',
  'credential_grant_revoked',
  'credential_unsafe_storage',
  // No-go matches + outcomes — policy evidence
  'no_go_match',
  'no_go_authorized',
  'no_go_blocked',
  // PR / commit / file artefacts — workspace audit trail
  'pr_opened',
  'commit_pushed',
  'file_written',
  'command_run',
  'verification',
  // Session boundaries
  'session_started',
  'session_ended',
  'phase_started',
  'phase_completed',
  'checkpoint',
  // Pairing tokens, profile mode, resilience
  'device_paired',
  'device_revoked',
  'profile_mode_switched',
  'stale_pid_cleaned',
  // Worker metadata + activity churn — keep for audit, low-volume in practice
  'worker_metadata_changed',
  'worker_activity',
  'worker_dispatch_request',
  // Steward thinking + tool calls — keep with audit so steward decisions
  // can be reconstructed end-to-end.
  'steward_thinking',
  'steward_tool_call',
  // Misc audit-bearing
  'error',
  'progress',
  'bom_step_progress',
  // v0.4 — diagnostic + capture audit kinds
  'runtime_toggle_changed',
  'runtime_toggle_expired',
  'heap_snapshot_taken',
  'cpu_profile_taken',
  'diagnostic_report_taken',
  'capture_filed',
  // host_exec — every started / completed / denied call is audit-bearing
  'host_exec_started',
  'host_exec_completed',
  'host_exec_denied',
  // Federation lineage — peer arrivals / departures and policy mutations
  'peer_joined',
  'peer_left',
  'capability_override_changed',
  'host_ceiling_os_cap',
]);

export type RetentionClass = 'operational' | 'audit' | 'unknown';

/**
 * Classify a kind. Unknown kinds get the 'unknown' bucket — the retention
 * pass logs a warning so the operator extends the sets above instead of
 * silently dropping data on the floor.
 */
export function retentionClass(kind: string): RetentionClass {
  if (OPERATIONAL_KINDS.has(kind)) return 'operational';
  if (AUDIT_KINDS.has(kind)) return 'audit';
  return 'unknown';
}

export interface RetentionOpts {
  /** Days to keep operational events. Env: STAVR_EVENTS_OP_RETENTION_DAYS. Default 7. */
  operationalDays?: number;
  /** Hard cap on operational rows. Env: STAVR_EVENTS_OP_MAX_ROWS. Default 100000. */
  operationalMaxRows?: number;
  /** Days to keep audit events. Env: STAVR_EVENTS_AUDIT_RETENTION_DAYS. Default 90. */
  auditDays?: number;
}

export interface RetentionResult {
  deletedOperational: number;
  deletedAudit: number;
  deletedUnknown: number;
  unknownPreserved: number;
  /**
   * Per-kind counts for the unknown bucket — the operator needs the names to
   * extend OPERATIONAL_KINDS / AUDIT_KINDS. Sorted by count descending. Empty
   * when unknownPreserved === 0.
   */
  unknownKinds: Array<{ kind: string; count: number }>;
  duration_ms: number;
  beforeCount: number;
  afterCount: number;
}

/**
 * Read retention options from env, falling back to BOM-spec defaults. Pure
 * function so the daemon scheduler and tests share one resolution path.
 */
export function resolveRetentionOpts(overrides: RetentionOpts = {}): Required<RetentionOpts> {
  const num = (envKey: string, fallback: number): number => {
    const raw = process.env[envKey];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    operationalDays: overrides.operationalDays ?? num('STAVR_EVENTS_OP_RETENTION_DAYS', 7),
    operationalMaxRows: overrides.operationalMaxRows ?? num('STAVR_EVENTS_OP_MAX_ROWS', 100_000),
    auditDays: overrides.auditDays ?? num('STAVR_EVENTS_AUDIT_RETENTION_DAYS', 90),
  };
}
