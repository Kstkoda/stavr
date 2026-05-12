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
  };
  const schema = map[kind];
  if (schema) schema.parse(payload);
}
