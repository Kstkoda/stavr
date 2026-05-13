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
    stale_pid_cleaned: StalePidCleanedPayload,
    steward_claimed: StewardClaimedPayload,
    steward_released: StewardReleasedPayload,
    steward_handoff: StewardHandoffPayload,
    steward_pulse: StewardPulsePayload,
  };
  const schema = map[kind];
  if (schema) schema.parse(payload);
}
