import { z } from 'zod';

export const EventKind = z.enum([
  'session_started',
  'phase_started',
  'phase_completed',
  'file_written',
  'command_run',
  'verification',
  'commit_pushed',
  'pr_opened',
  'progress',
  'decision_request',
  'decision_response',
  'decision_late_response',
  'error',
  'checkpoint',
  'session_ended',
  // Worker orchestration (spec 42)
  'worker_spawned',
  'worker_progress',
  'worker_metadata_changed',
  'worker_activity',
  'worker_dispatch_request',
  'worker_terminated',
  'worker_error',
  // Worker visibility (spec 47)
  'worker_log',
  'worker_stuck',
  // Trust scopes (spec 46)
  'trust_scope_proposed',
  'trust_scope_granted',
  'trust_scope_revoked',
  'trust_scope_extended',
  'trust_scope_progress',
  'trust_scope_completed',
  'trust_scope_action_authorized',
  // Spec 51 resilience principles
  'stale_pid_cleaned',
  // Spec 48 Layer 1 — Steward role + claim lifecycle
  'steward_claimed',
  'steward_released',
  'steward_handoff',
  'steward_pulse',
  // Spec 48 Layer 2 — Credential vault
  'credential_added',
  'credential_used',
  'credential_revoked',
  'credential_grant_added',
  'credential_grant_revoked',
  'credential_unsafe_storage',
  // Spec 48 Layer 3 — no-go list
  'no_go_match',
  'no_go_authorized',
  'no_go_blocked',
  // family-mode-phase-1 Phase 2 hardening — the chokepoint decision gate
  // exposes a test-only auto-approve seam (STAVR_CHOKEPOINT_TEST_AUTO_APPROVE)
  // so vitest doesn't hang on CONFIRM-tier tools. Every bypass emits this
  // event so its use is observable in the audit trail; the seam is also
  // structurally blocked from firing in production by a boot-time guard
  // in src/daemon.ts. See src/security/decision-gate.ts.
  'decision_chokepoint_test_bypass',
  // Spec 49 Layer 1 — daemon-hosted Steward
  'steward_started',
  'steward_stopped',
  'steward_prompt',
  'steward_thinking',
  'steward_tool_call',
  'steward_response',
  'steward_usage',
  'steward_paused_for_budget',
  'steward_resumed',
  // Spec 52 A2 — pairing tokens
  'device_paired',
  'device_revoked',
  // v0.2 — BOM planning + executor lifecycle
  'bom_proposed',
  'bom_approved',
  'bom_rejected',
  'bom_cancelled',
  'bom_completed',
  'bom_failed',
  'bom_replanned',
  'bom_edited',
  'bom_step_started',
  'bom_step_progress',
  'bom_step_completed',
  'bom_step_failed',
  'bom_step_skipped',
  'bom_step_promoted',
  'profile_mode_switched',
  // OOM leak-hunt observability (bom-oom-leak-hunt)
  'daemon_memory',
  'daemon_eventloop',
  'sse_session_opened',
  'sse_session_closed',
  'sse_session_force_removed',
  'mcp_session_deleted',
  'mcp_oneshot_cleanup',
  'daemon_rss_watchdog',
  'retention_swept',
  // v0.4 — runtime toggles + capture + diagnostic-capture audit
  'runtime_toggle_changed',
  'runtime_toggle_expired',
  'heap_snapshot_taken',
  'cpu_profile_taken',
  'diagnostic_report_taken',
  'capture_filed',
  // host_exec — scoped + audited shell execution (BOM: host-exec-tool-bom.md)
  'host_exec_started',
  'host_exec_completed',
  'host_exec_denied',
  // v0.6.X — Telegram operator directives (BOM: v0_6_X-telegram-operator-directives-bom.md)
  'operator_directive',
  'operator_scope_request',
  'operator_ask',
  'telegram_directive_rejected',
  'trust_scope_rejected',
  // v0.6.X bonus — outbound notification coverage expansion
  'cc_quota_warning',
  'worker_dispatch_failed',
  // v0.6.7 P3 — worker spawn was blocked by an antivirus / EDR product
  'worker_blocked_by_av',
  // v0.6.7 P4 — worker spawn was rejected because the script sidecar
  //             signature did not verify (tampered script, missing sidecar,
  //             wrong key, etc.).
  'worker_blocked_by_signature',
  // v0.6.9 P9 — Layer 0 capability state changed (operator toggled a
  //             tool between enabled / disabled-temporary / disabled-permanent).
  'capability_override_changed',
  // v0.6.9 P9 — per-actor permission tier changed (matrix row written,
  //             reset, or filled by a named-policy apply).
  'actor_permission_changed',
  // v0.6.11 Phase 3 — periodic per-endpoint perf snapshot
  //             (HTTP routes + MCP methods). Operational; retained briefly.
  'perf_sample',
  // v0.7 Phase 3 — federation roles + peer lifecycle.
  // peer_joined / peer_left fire when the federation subsystem's
  // registry adds or removes a peer (mDNS or peers.yaml change).
  // bom_role_assigned annotates a BOM with its Originator/Participant/
  // Convener attribution at dispatch. federation_handoff_* track
  // explicit cross-peer transfers of Originator role (operator switches
  // machines mid-task).
  'peer_joined',
  'peer_left',
  'bom_role_assigned',
  'federation_handoff_started',
  'federation_handoff_completed',
  // v0.7 Phase 3 — operator passkey assertion audit. Emitted by the
  // WebAuthn coordinator on every successful Tier 3 verification so
  // forensic review can correlate assertions to the actions they gated.
  'tier3_assertion_recorded',
  // Host-resource ceiling (proposed/host-resource-ceiling-bom.md).
  // daemon_host_headroom: per-tick host RAM/CPU sample from the headroom
  //   poller (Phase 2).
  // host_ceiling_refused: a worker_spawn (or other admission-controlled op)
  //   was refused because admitting it would breach the ceiling (Phase 3).
  // host_ceiling_shed: load-shedding terminated a worker because runtime
  //   headroom dropped under the shed thresholds (Phase 5).
  // host_ceiling_os_cap: emitted once at boot describing the OS-level cap
  //   installation result (kind: 'cgroup-v2' | 'job-object' | 'none') (Phase 4).
  'daemon_host_headroom',
  'host_ceiling_refused',
  'host_ceiling_shed',
  'host_ceiling_os_cap',
]);
export type EventKindT = z.infer<typeof EventKind>;

export const DecisionOption = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
});
export type DecisionOption = z.infer<typeof DecisionOption>;

export const SessionStartedPayload = z.object({
  handoff_path: z.string(),
  model: z.string(),
  mode: z.enum(['auto-accept', 'normal']),
});

export const PhaseStartedPayload = z.object({
  phase_name: z.string(),
  phase_index: z.number().int().nonnegative(),
  total_phases: z.number().int().positive(),
});

export const PhaseCompletedPayload = z.object({
  phase_name: z.string(),
  commit_sha: z.string().optional(),
  pr_url: z.string().url().optional(),
});

export const FileWrittenPayload = z.object({
  path: z.string(),
  lines_added: z.number().int().nonnegative(),
  lines_removed: z.number().int().nonnegative(),
});

export const CommandRunPayload = z.object({
  command: z.string(),
  exit_code: z.number().int(),
  duration_ms: z.number().nonnegative(),
});

export const VerificationPayload = z.object({
  check: z.string(),
  status: z.enum(['pass', 'fail']),
  detail: z.string().optional(),
});

export const CommitPushedPayload = z.object({
  sha: z.string(),
  message: z.string(),
  branch: z.string(),
});

export const PrOpenedPayload = z.object({
  url: z.string().url(),
  title: z.string(),
});

export const ProgressPayload = z.object({
  message: z.string(),
});

export const DecisionRequestPayload = z.object({
  question: z.string(),
  options: z.array(DecisionOption).min(1).max(8),
  default_option_id: z.string().optional(),
  deadline_seconds: z.number().int().positive().max(1800),
});

export const DecisionResponderEnum = z.enum([
  'cowork-auto',
  'cowork-user',
  'cowork-user-relayed',
  'user-direct',
  'switch-default',
]);

export const DecisionResponsePayload = z.object({
  chosen_option_id: z.string(),
  reason: z.string().optional(),
  responder: DecisionResponderEnum.or(z.string()),
});

export const DecisionLateResponsePayload = z.object({
  chosen_option_id: z.string(),
  reason: z.string().optional(),
  responder: z.string(),
  fallback_was: z.string().optional(),
});

export const ErrorPayload = z.object({
  message: z.string(),
  stack: z.string().optional(),
  recoverable: z.boolean(),
  attempted_recovery: z.string().optional(),
});

export const CheckpointPayload = z.object({
  branch: z.string(),
  last_commit_sha: z.string(),
  files_dirty: z.array(z.string()),
  next_step: z.string(),
});

export const SessionEndedPayload = z.object({
  reason: z.enum(['completed', 'errored', 'killed', 'rate-limited']),
  summary: z.string(),
  pr_urls: z.array(z.string()),
});

// Worker orchestration payloads (spec 42)

export const WorkerSpawnedPayload = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  cwd: z.string(),
  pid: z.number().int().optional(),
  metadata: z.record(z.unknown()).default({}),
});

export const WorkerProgressPayload = z.object({
  id: z.string(),
  message: z.string(),
  detail: z.string().optional(),
});

export const WorkerMetadataChangedPayload = z.object({
  id: z.string(),
  patch: z.record(z.unknown()),
});

export const WorkerActivityPayload = z.object({
  id: z.string(),
  detail: z.string().optional(),
});

export const WorkerDispatchRequestPayload = z.object({
  target_worker_id: z.string(),
  message_id: z.string(),
  body: z.unknown(),
});

export const WorkerTerminatedPayload = z.object({
  id: z.string(),
  reason: z.enum(['completed', 'crashed', 'terminated_by_user']),
  exit_code: z.number().int().optional(),
});

export const WorkerErrorPayload = z.object({
  id: z.string(),
  message: z.string(),
  recoverable: z.boolean(),
});

// Trust-scope payloads (spec 46)

export const ActionMatcherSchema = z.object({
  tool: z.string().min(1),
  param_constraints: z.record(z.unknown()).optional(),
  reason: z.string().optional(),
});

export const ScopeReportingSchema = z.object({
  cadence: z.enum(['every-action', 'every-5-actions', 'every-15-min', 'on-completion-only']),
  channels: z.array(z.enum(['chat', 'event-log', 'dashboard', 'slack', 'email'])).min(1),
});

export const TrustScopeProposedPayload = z.object({
  scope_id: z.string(),
  title: z.string(),
  description: z.string(),
  allowed_actions: z.array(ActionMatcherSchema),
  forbidden_actions: z.array(ActionMatcherSchema).optional(),
  expires_at: z.string(),
  expires_after_actions: z.number().int().positive().optional(),
  reporting: ScopeReportingSchema,
  spec_url: z.string().optional(),
});

export const TrustScopeGrantedPayload = z.object({
  scope_id: z.string(),
  title: z.string(),
  granted_by: z.string(),
  granted_at: z.string(),
  expires_at: z.string(),
  expires_after_actions: z.number().int().positive().optional(),
});

export const TrustScopeRevokedPayload = z.object({
  scope_id: z.string(),
  revoked_by: z.string(),
  reason: z.string().optional(),
});

export const TrustScopeExtendedPayload = z.object({
  scope_id: z.string(),
  new_expires_at: z.string().optional(),
  new_expires_after_actions: z.number().int().positive().optional(),
  extended_by: z.string(),
});

export const TrustScopeProgressPayload = z.object({
  scope_id: z.string(),
  actions_executed: z.number().int().nonnegative(),
  expires_after_actions: z.number().int().positive().optional(),
  expires_at: z.string(),
  cadence: z.enum(['every-action', 'every-5-actions', 'every-15-min', 'on-completion-only']),
  message: z.string().optional(),
});

export const TrustScopeCompletedPayload = z.object({
  scope_id: z.string(),
  reason: z.enum(['action_cap_reached', 'expired', 'revoked']),
  actions_executed: z.number().int().nonnegative(),
  completed_at: z.string(),
});

export const TrustScopeActionAuthorizedPayload = z.object({
  scope_id: z.string(),
  tool: z.string(),
  args: z.unknown(),
});

// Spec 51 resilience principles — stale PID file recovery.
export const StalePidCleanedPayload = z.object({
  dead_pid: z.number().int(),
  port: z.number().int().optional(),
  pid_file_path: z.string(),
});

// Spec 48 Layer 1 — Steward role payloads.

export const StewardClaimedPayload = z.object({
  steward_id: z.string(),
  client_id: z.string(),
  user_id: z.string(),
  display_name: z.string().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  claimed_at: z.string(),
  memory_path: z.string().optional(),
});

export const StewardReleasedPayload = z.object({
  steward_id: z.string(),
  client_id: z.string(),
  released_at: z.string(),
  released_by: z.enum(['steward', 'user-force', 'handoff']),
  reason: z.string().optional(),
});

export const StewardHandoffPayload = z.object({
  from_steward_id: z.string(),
  to_steward_id: z.string(),
  from_client_id: z.string(),
  to_client_id: z.string(),
  at: z.string(),
});

export const StewardPulsePayload = z.object({
  steward_id: z.string(),
  at: z.string(),
  detail: z.string().optional(),
});

// Spec 48 Layer 2 — Credential vault payloads.

export const CredentialAddedPayload = z.object({
  credential_id: z.string(),
  service: z.string(),
  kind: z.enum(['oauth', 'api_key', 'local_ref']),
  user_id: z.string(),
  expires_at: z.string().optional(),
  oauth_scopes: z.array(z.string()).optional(),
});

export const CredentialUsedPayload = z.object({
  credential_id: z.string(),
  service: z.string(),
  request_signature: z.string(),
  status: z.enum(['success', 'error']),
  steward_session_id: z.string().optional(),
  duration_ms: z.number().nonnegative().optional(),
  error_message: z.string().optional(),
});

export const CredentialRevokedPayload = z.object({
  credential_id: z.string(),
  service: z.string(),
  revoked_by: z.string(),
});

export const CredentialGrantAddedPayload = z.object({
  grant_id: z.string(),
  credential_id: z.string(),
  steward_session_id: z.string().optional(),
  granted_by_user_id: z.string(),
  uses_remaining: z.number().int().positive().optional(),
  expires_at: z.string().optional(),
});

export const CredentialGrantRevokedPayload = z.object({
  grant_id: z.string(),
  credential_id: z.string(),
  revoked_by: z.string(),
});

export const CredentialUnsafeStoragePayload = z.object({
  reason: z.string(),
  fallback_path: z.string(),
});

// Spec 48 Layer 3 — no-go payloads.

export const NoGoMatchPayload = z.object({
  entry_id: z.string(),
  tool: z.string(),
  args: z.unknown(),
  severity: z.enum(['high', 'critical']),
  active_scope_id: z.string().optional(),
  reason: z.string(),
});

export const NoGoAuthorizedPayload = z.object({
  entry_id: z.string(),
  tool: z.string(),
  responder: z.string(),
  responded_at: z.string(),
});

export const NoGoBlockedPayload = z.object({
  entry_id: z.string(),
  tool: z.string(),
  blocked_reason: z.enum(['rejected_by_user', 'timeout']),
  responder: z.string().optional(),
});

// Spec 49 Layer 1 — daemon-hosted Steward payloads.

export const StewardStartedPayload = z.object({
  provider: z.string(),
  model: z.string(),
  display_name: z.string(),
  pid: z.number().int().optional(),
});

export const StewardStoppedPayload = z.object({
  reason: z.enum(['shutdown', 'crashed', 'budget_paused']),
  detail: z.string().optional(),
});

export const StewardPromptPayload = z.object({
  text: z.string(),
  source: z.enum(['cli', 'dashboard', 'mcp', 'scheduled']).optional(),
});

export const StewardThinkingPayload = z.object({
  text: z.string().optional(),
});

export const StewardToolCallPayload = z.object({
  tool: z.string(),
  args: z.unknown(),
  call_id: z.string().optional(),
});

export const StewardResponsePayload = z.object({
  text: z.string(),
});

export const StewardUsagePayload = z.object({
  provider: z.string(),
  model: z.string(),
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_read_tokens: z.number().int().nonnegative().optional(),
  cache_creation_tokens: z.number().int().nonnegative().optional(),
  cost_usd: z.number().nonnegative().optional(),
  credential_id: z.string().optional(),
});

export const StewardPausedForBudgetPayload = z.object({
  period: z.enum(['daily', 'weekly']),
  budget_usd: z.number().nonnegative(),
  spent_usd: z.number().nonnegative(),
});

export const StewardResumedPayload = z.object({
  override_budget: z.boolean(),
});

// Worker visibility payloads (spec 47)

export const WorkerLogPayload = z.object({
  worker_id: z.string(),
  worker_name: z.string(),
  stream: z.enum(['stdout', 'stderr']),
  format: z.enum(['stream-json', 'raw']).optional(),
  event: z.unknown().optional(),
  line: z.string().optional(),
  truncated: z.boolean().optional(),
});

export const WorkerStuckPayload = z.object({
  worker_id: z.string(),
  worker_name: z.string(),
  worker_type: z.string(),
  pid: z.number().int().optional(),
  started_at: z.string(),
  last_activity_at: z.string(),
  idle_seconds: z.number().nonnegative(),
  last_event_id: z.string().optional(),
  last_event_kind: z.string().optional(),
  hint: z.string(),
});

// v0.2 — BOM planning + executor payloads

const RiskClassEnum = z.enum([
  'read-only',
  'write-local',
  'write-remote',
  'execute',
  'external-comm',
  'financial',
  'credential',
  'destructive',
]);

const CapabilityTagEnum = z.enum([
  'reading',
  'cheap-classifier',
  'code-execution',
  'code-reasoning',
  'long-context',
  'multimodal-vision',
  'multimodal-audio',
  'tool-use-heavy',
  'simple-summary',
  'no-model',
]);

const ProfileModeEnum = z.enum(['turbo', 'balanced', 'eco']);

const BomVersionReasonEnum = z.enum([
  'initial',
  'replan_on_failure',
  'manual_edit',
  'capability_escalation',
]);

export const BomProposedPayload = z.object({
  bom_id: z.string(),
  version: z.number().int().positive(),
  goal: z.string(),
  steps_count: z.number().int().nonnegative(),
  cost_estimate: z.number().nonnegative(),
  cost_max: z.number().nonnegative(),
  duration_sec_est: z.number().nonnegative(),
  risk_envelope: z.array(RiskClassEnum),
  profile_mode: ProfileModeEnum,
  planner_model: z.string(),
});

export const BomApprovedPayload = z.object({
  bom_id: z.string(),
  version: z.number().int().positive(),
  scope_id: z.string(),
  approver: z.string(),
});

export const BomRejectedPayload = z.object({
  bom_id: z.string(),
  version: z.number().int().positive(),
  rejected_by: z.string(),
  reason: z.string().optional(),
});

export const BomCancelledPayload = z.object({
  bom_id: z.string(),
  cancelled_by: z.string(),
  reason: z.string().optional(),
});

export const BomCompletedPayload = z.object({
  bom_id: z.string(),
  version: z.number().int().positive(),
  cost_actual: z.number().nonnegative(),
  steps_done: z.number().int().nonnegative(),
  duration_sec: z.number().nonnegative(),
  ended_at: z.string(),
});

export const BomFailedPayload = z.object({
  bom_id: z.string(),
  version: z.number().int().positive(),
  reason: z.string(),
  last_step_no: z.number().int().nonnegative().optional(),
});

export const BomReplannedPayload = z.object({
  bom_id: z.string(),
  from_version: z.number().int().positive(),
  to_version: z.number().int().positive(),
  reason: BomVersionReasonEnum,
  trigger_step: z.number().int().positive().optional(),
});

export const BomEditedPayload = z.object({
  bom_id: z.string(),
  version: z.number().int().positive(),
  edited_by: z.string(),
});

export const BomStepStartedPayload = z.object({
  bom_id: z.string(),
  version: z.number().int().positive(),
  step_no: z.number().int().positive(),
  worker_id: z.string(),
  model: z.string(),
});

export const BomStepProgressPayload = z.object({
  bom_id: z.string(),
  version: z.number().int().positive(),
  step_no: z.number().int().positive(),
  message: z.string(),
});

export const BomStepCompletedPayload = z.object({
  bom_id: z.string(),
  version: z.number().int().positive(),
  step_no: z.number().int().positive(),
  cost_actual: z.number().nonnegative(),
  tokens_in: z.number().int().nonnegative(),
  tokens_out: z.number().int().nonnegative(),
  duration_sec: z.number().nonnegative(),
});

export const BomStepFailedPayload = z.object({
  bom_id: z.string(),
  version: z.number().int().positive(),
  step_no: z.number().int().positive(),
  error_message: z.string(),
  retry_count: z.number().int().nonnegative(),
  will_replan: z.boolean(),
});

export const BomStepSkippedPayload = z.object({
  bom_id: z.string(),
  version: z.number().int().positive(),
  step_no: z.number().int().positive(),
  reason: z.string(),
});

export const BomStepPromotedPayload = z.object({
  bom_id: z.string(),
  version: z.number().int().positive(),
  step_no: z.number().int().positive(),
  from_model: z.string(),
  to_model: z.string(),
  reason: z.string(),
});

// host_exec audit payloads (BOM: proposed/host-exec-tool-bom.md).

export const HostExecStartedPayload = z.object({
  correlation_id: z.string(),
  scope_id: z.string(),
  command: z.string(),
  args_hash: z.string(),
  args_count: z.number().int().nonnegative(),
  cwd: z.string().optional(),
  timeout_ms: z.number().int().positive(),
  caller: z.string().optional(),
});

export const HostExecCompletedPayload = z.object({
  correlation_id: z.string(),
  scope_id: z.string(),
  command: z.string(),
  exit_code: z.number().int().nullable(),
  duration_ms: z.number().nonnegative(),
  stdout_len: z.number().int().nonnegative(),
  stderr_len: z.number().int().nonnegative(),
  stdout_truncated: z.boolean(),
  stderr_truncated: z.boolean(),
  timed_out: z.boolean(),
});

export const HostExecDeniedPayload = z.object({
  correlation_id: z.string(),
  command: z.string(),
  args_hash: z.string(),
  args_count: z.number().int().nonnegative(),
  reason: z.string(),
  error_code: z.enum(['SCOPE_DENIED', 'ALLOWLIST_DENIED', 'CWD_DENIED']),
  caller: z.string().optional(),
});

export const ProfileModeSwitchedPayload = z.object({
  from_mode: ProfileModeEnum,
  to_mode: ProfileModeEnum,
  switched_by: z.string(),
  reason: z.string().optional(),
});

// v0.6.X — Telegram operator directives (BOM:
// proposed/v0_6_X-telegram-operator-directives-bom.md)

/** Operator-originated free-text directive routed via Telegram. */
export const OperatorDirectivePayload = z.object({
  text: z.string().min(1).max(4000),
  source: z.enum(['telegram', 'dashboard', 'cli']),
  chat_id: z.string().optional(),
});

/** Operator asks Steward to propose a scope shape; Steward proposes via the
 *  normal trust_scope_proposed event, which the operator then grants on the
 *  dashboard. */
export const OperatorScopeRequestPayload = z.object({
  text: z.string().min(1).max(4000),
  source: z.enum(['telegram', 'dashboard', 'cli']),
  chat_id: z.string().optional(),
});

/** One-shot synchronous question for Steward. The Steward's reply finds its
 *  way back via the existing notifier path, using this event's id as the
 *  correlation_id so the response lands in the right Telegram thread. */
export const OperatorAskPayload = z.object({
  text: z.string().min(1).max(4000),
  source: z.enum(['telegram', 'dashboard', 'cli']),
  chat_id: z.string().optional(),
});

/** Audit trail for a non-operator Telegram chat trying to issue a directive.
 *  The bot never replies to such messages (defense in depth — the bot's
 *  existence shouldn't be confirmable to non-operators). */
export const TelegramDirectiveRejectedPayload = z.object({
  chat_id: z.string(),
  reason: z.enum(['wrong_chat_id', 'rate_limit', 'malformed']),
  text_preview: z.string().max(120).optional(),
});

/** Operator (or Steward, with operator approval) declined a proposed scope.
 *  Audit-equivalent to revoke but happens before a grant ever lands. */
export const TrustScopeRejectedPayload = z.object({
  scope_id: z.string(),
  rejected_by: z.string(),
  reason: z.string().optional(),
});

/** Claude Code quota approaching limit. Emitted by the CC observer; the
 *  notify wiring forwards to operator channels (toast / Telegram) so the
 *  operator can pause or batch before exhausting the quota. */
export const CcQuotaWarningPayload = z.object({
  percent: z.number().int().min(0).max(100),
  remaining: z.number().int().nonnegative().optional(),
  resets_at: z.string().optional(),
  detail: z.string().optional(),
});

/** Worker spawn failed before the worker process became reachable. Port
 *  collision, AV block, missing executable, etc. */
export const WorkerDispatchFailedPayload = z.object({
  /** Intended worker id (assigned before the spawn attempt). */
  target_worker_id: z.string(),
  name: z.string().optional(),
  reason: z.enum(['port_collision', 'av_block', 'missing_binary', 'spawn_error', 'other']),
  detail: z.string().optional(),
});

/** Worker spawn was killed by an antivirus / EDR product. Distinct from
 *  worker_dispatch_failed: this event has rich AV-product attribution
 *  pulled from the Windows Event Log or vendor-specific logs, and is the
 *  signal the operator needs to add a whitelist rule. */
export const WorkerBlockedByAvPayload = z.object({
  /** Intended worker id (assigned before the spawn attempt). */
  worker_id: z.string(),
  /** Worker display name if set. */
  name: z.string().optional(),
  /** Vendor display name (e.g. "Windows Defender", "CrowdStrike Falcon"). */
  av_product_name: z.string(),
  /** Vendor-specific event id (Defender 1116/1117/5007, etc.). */
  av_event_id: z.number().int().nonnegative().optional(),
  /** First ~240 chars of the AV's event message — enough for the operator
   *  to recognise the signature name without ballooning the event log. */
  av_event_message: z.string().max(240).optional(),
  /** Path to the script the AV blocked (when known). */
  script_path: z.string().optional(),
  /** SHA-256 of the script contents — useful for vendor-side rule
   *  authoring and for correlating across multiple AV blocks of the
   *  same generated body. */
  spawned_command_signature: z.string().optional(),
});

/** v0.6.9 P9 — operator toggled a tool's Layer 0 master switch. Every
 *  state change emits one event so the audit log answers "who disabled
 *  github_merge_pr, when, why, for how long". */
export const CapabilityOverrideChangedPayload = z.object({
  tool_id: z.string(),
  set_by: z.string(),
  /** Prior state, `null` when no override row existed (= effectively enabled). */
  from_state: z.enum(['enabled', 'disabled-temporary', 'disabled-permanent']).nullable(),
  to_state: z.enum(['enabled', 'disabled-temporary', 'disabled-permanent']),
  /** Operator-provided rationale — truncated for log hygiene. */
  reason: z.string().max(240).optional(),
  /** Unix-ms expiry when to_state is `disabled-temporary`; absent otherwise. */
  disabled_until: z.number().int().nullable().optional(),
  /** Optional correlation with the named-policy apply that produced this. */
  policy_id: z.string().optional(),
});

/** v0.6.9 P9 — per-actor permission tier changed. Distinguishes between
 *  a single matrix-cell edit and a bulk policy-apply via the `source`
 *  field. */
export const ActorPermissionChangedPayload = z.object({
  actor_id: z.string(),
  tool_id: z.string(),
  set_by: z.string(),
  /** Prior tier, `null` when no matrix row existed (the registered
   *  default was in force). */
  from_tier: z.enum(['AUTO', 'CONFIRM', 'EXPLICIT', 'NO_GO']).nullable(),
  to_tier: z.enum(['AUTO', 'CONFIRM', 'EXPLICIT', 'NO_GO']),
  /** How the change was triggered. `matrix-cell` = single dropdown
   *  change in the UI; `policy-apply` = bulk preset application; `reset`
   *  = operator returned the cell to default. */
  source: z.enum(['matrix-cell', 'policy-apply', 'reset', 'import']),
  /** Correlated policy preset id when `source === 'policy-apply'`. */
  policy_id: z.string().optional(),
  /** Optional operator note for non-trivial changes. */
  reason: z.string().max(240).optional(),
});

/** Worker spawn was rejected because the script's Ed25519 sidecar
 *  signature failed to verify. Each `reason` corresponds to a specific
 *  failure mode in `src/security/script-signing.ts` so the operator can
 *  distinguish a missing sidecar from a tampered script body. */
export const WorkerBlockedBySignaturePayload = z.object({
  worker_id: z.string(),
  name: z.string().optional(),
  script_path: z.string(),
  reason: z.enum([
    'sidecar_missing',
    'sidecar_unreadable',
    'sidecar_malformed',
    'script_unreadable',
    'script_hash_mismatch',
    'worker_id_mismatch',
    'path_mismatch',
    'unsupported_alg',
    'signature_invalid',
    'pubkey_mismatch',
  ]),
  /** Short diagnostic detail — truncated so the event log doesn't bloat
   *  on long paths or stack messages. */
  detail: z.string().max(240).optional(),
});

/** v0.7 Phase 3 — federation context that rides on every event when the
 *  daemon is part of a multi-peer federation. The originating peer
 *  stamps `origin_peer` so subscribers (local + mirrored) can attribute
 *  the event to a specific instance; `role` carries the per-task role
 *  the origin held at emission time. Absent when federation is off OR
 *  the event is single-machine work. */
export const FederationContextSchema = z.object({
  origin_peer: z.string().min(1),
  role: z.enum(['originator', 'participant', 'convener']),
  convener_peer: z.string().min(1).optional(),
});
export type FederationContextEvent = z.infer<typeof FederationContextSchema>;

export const Event = z.object({
  kind: EventKind,
  at: z.string().datetime(),
  correlation_id: z.string().optional(),
  tenant_id: z.string().optional(),
  source_agent: z.string(),
  payload: z.unknown(),
  federation_context: FederationContextSchema.optional(),
});
export type Event = z.infer<typeof Event>;

// v0.7 Phase 3 payloads.
export const PeerJoinedPayload = z.object({
  peer_id: z.string().min(1),
  display_name: z.string().min(1),
  hostname: z.string().min(1),
  port: z.number().int().positive(),
  trust: z.enum(['local-equivalent', 'verified', 'untrusted']),
  configured: z.boolean(),
  discovered: z.boolean(),
});

export const PeerLeftPayload = z.object({
  peer_id: z.string().min(1),
  reason: z.enum(['mdns_lost', 'unreachable', 'config_removed']),
});

export const BomRoleAssignedPayload = z.object({
  bom_id: z.string().min(1),
  originator_peer: z.string().min(1),
  role: z.enum(['originator', 'participant', 'convener']),
  convener_peer: z.string().min(1).optional(),
});

export const FederationHandoffStartedPayload = z.object({
  bom_id: z.string().min(1),
  from_peer: z.string().min(1),
  to_peer: z.string().min(1),
  reason: z.string().min(1),
});

export const FederationHandoffCompletedPayload = z.object({
  bom_id: z.string().min(1),
  from_peer: z.string().min(1),
  to_peer: z.string().min(1),
  outcome: z.enum(['accepted', 'rejected', 'timed_out']),
});

export const Tier3AssertionRecordedPayload = z.object({
  operator_id: z.string().min(1),
  credential_id: z.string().min(1),
  correlation_id: z.string().optional(),
  scope_label: z.string().optional(),
  expires_at: z.number().int().positive(),
});

export const PERSISTED_EVENT_KINDS: EventKindT[] = EventKind.options;

export function validatePayloadForKind(kind: EventKindT, payload: unknown): void {
  const map: Partial<Record<EventKindT, z.ZodTypeAny>> = {
    session_started: SessionStartedPayload,
    phase_started: PhaseStartedPayload,
    phase_completed: PhaseCompletedPayload,
    file_written: FileWrittenPayload,
    command_run: CommandRunPayload,
    verification: VerificationPayload,
    commit_pushed: CommitPushedPayload,
    pr_opened: PrOpenedPayload,
    progress: ProgressPayload,
    decision_request: DecisionRequestPayload,
    decision_response: DecisionResponsePayload,
    decision_late_response: DecisionLateResponsePayload,
    error: ErrorPayload,
    checkpoint: CheckpointPayload,
    session_ended: SessionEndedPayload,
    worker_spawned: WorkerSpawnedPayload,
    worker_progress: WorkerProgressPayload,
    worker_metadata_changed: WorkerMetadataChangedPayload,
    worker_activity: WorkerActivityPayload,
    worker_dispatch_request: WorkerDispatchRequestPayload,
    worker_terminated: WorkerTerminatedPayload,
    worker_error: WorkerErrorPayload,
    trust_scope_proposed: TrustScopeProposedPayload,
    trust_scope_granted: TrustScopeGrantedPayload,
    trust_scope_revoked: TrustScopeRevokedPayload,
    trust_scope_extended: TrustScopeExtendedPayload,
    trust_scope_progress: TrustScopeProgressPayload,
    trust_scope_completed: TrustScopeCompletedPayload,
    trust_scope_action_authorized: TrustScopeActionAuthorizedPayload,
    credential_added: CredentialAddedPayload,
    credential_grant_added: CredentialGrantAddedPayload,
    credential_grant_revoked: CredentialGrantRevokedPayload,
    credential_revoked: CredentialRevokedPayload,
    credential_unsafe_storage: CredentialUnsafeStoragePayload,
    credential_used: CredentialUsedPayload,
    no_go_authorized: NoGoAuthorizedPayload,
    no_go_blocked: NoGoBlockedPayload,
    no_go_match: NoGoMatchPayload,
    stale_pid_cleaned: StalePidCleanedPayload,
    steward_claimed: StewardClaimedPayload,
    steward_handoff: StewardHandoffPayload,
    steward_paused_for_budget: StewardPausedForBudgetPayload,
    steward_prompt: StewardPromptPayload,
    steward_pulse: StewardPulsePayload,
    steward_released: StewardReleasedPayload,
    steward_response: StewardResponsePayload,
    steward_resumed: StewardResumedPayload,
    steward_started: StewardStartedPayload,
    steward_stopped: StewardStoppedPayload,
    steward_thinking: StewardThinkingPayload,
    steward_tool_call: StewardToolCallPayload,
    steward_usage: StewardUsagePayload,
    worker_log: WorkerLogPayload,
    worker_stuck: WorkerStuckPayload,
    bom_proposed: BomProposedPayload,
    bom_approved: BomApprovedPayload,
    bom_rejected: BomRejectedPayload,
    bom_cancelled: BomCancelledPayload,
    bom_completed: BomCompletedPayload,
    bom_failed: BomFailedPayload,
    bom_replanned: BomReplannedPayload,
    bom_edited: BomEditedPayload,
    bom_step_started: BomStepStartedPayload,
    bom_step_progress: BomStepProgressPayload,
    bom_step_completed: BomStepCompletedPayload,
    bom_step_failed: BomStepFailedPayload,
    bom_step_skipped: BomStepSkippedPayload,
    bom_step_promoted: BomStepPromotedPayload,
    profile_mode_switched: ProfileModeSwitchedPayload,
    host_exec_started: HostExecStartedPayload,
    host_exec_completed: HostExecCompletedPayload,
    host_exec_denied: HostExecDeniedPayload,
    operator_directive: OperatorDirectivePayload,
    operator_scope_request: OperatorScopeRequestPayload,
    operator_ask: OperatorAskPayload,
    telegram_directive_rejected: TelegramDirectiveRejectedPayload,
    trust_scope_rejected: TrustScopeRejectedPayload,
    cc_quota_warning: CcQuotaWarningPayload,
    worker_dispatch_failed: WorkerDispatchFailedPayload,
    worker_blocked_by_av: WorkerBlockedByAvPayload,
    worker_blocked_by_signature: WorkerBlockedBySignaturePayload,
    capability_override_changed: CapabilityOverrideChangedPayload,
    actor_permission_changed: ActorPermissionChangedPayload,
    // v0.7 Phase 3 — federation roles + lifecycle.
    peer_joined: PeerJoinedPayload,
    peer_left: PeerLeftPayload,
    bom_role_assigned: BomRoleAssignedPayload,
    federation_handoff_started: FederationHandoffStartedPayload,
    federation_handoff_completed: FederationHandoffCompletedPayload,
    tier3_assertion_recorded: Tier3AssertionRecordedPayload,
  };
  const schema = map[kind];
  if (schema) schema.parse(payload);
}
