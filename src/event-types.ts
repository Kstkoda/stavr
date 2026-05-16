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

export const Event = z.object({
  kind: EventKind,
  at: z.string().datetime(),
  correlation_id: z.string().optional(),
  tenant_id: z.string().optional(),
  source_agent: z.string(),
  payload: z.unknown(),
});
export type Event = z.infer<typeof Event>;

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
  };
  const schema = map[kind];
  if (schema) schema.parse(payload);
}
