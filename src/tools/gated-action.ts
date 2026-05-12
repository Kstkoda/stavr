import { randomUUID } from 'node:crypto';
import type { Broker } from '../broker.js';
import { DecisionTimeoutError } from '../persistence.js';
import type { Event, EventKindT } from '../event-types.js';

export const APPROVE = 'approve';
export const REJECT = 'reject';

const DEFAULT_TIMEOUT_SEC = 1800;

export interface SuccessEventSpec {
  kind: EventKindT;
  payload: unknown;
}

export interface GatedActionOpts<T> {
  broker: Broker;
  question: string;
  performAction: () => Promise<T>;
  successEvent?: (result: T) => SuccessEventSpec | undefined;
  timeoutSec?: number;
  sourceAgent?: string;
  tenantId?: string;
  correlationId?: string;
}

export type GatedActionFailure =
  | { ok: false; reason: 'rejected_by_user'; correlation_id: string }
  | { ok: false; reason: 'gh_failed'; correlation_id: string; message: string; exit_code?: number; stderr?: string };

export type GatedActionSuccess<T> = { ok: true; correlation_id: string; result: T };

export type GatedActionResult<T> = GatedActionSuccess<T> | GatedActionFailure;

interface GhLikeError {
  exitCode?: number;
  stderr?: string;
  message: string;
}

function isGhLikeError(err: unknown): err is GhLikeError {
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as { message?: unknown }).message === 'string'
  );
}

export async function gatedAction<T>(opts: GatedActionOpts<T>): Promise<GatedActionResult<T>> {
  const correlationId = opts.correlationId ?? randomUUID();
  const timeoutSec = opts.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
  const sourceAgent = opts.sourceAgent ?? 'cc';
  const options = [
    { id: APPROVE, label: 'Approve' },
    { id: REJECT, label: 'Reject' },
  ];

  opts.broker.store.createDecision(correlationId, opts.question, options, timeoutSec, REJECT);

  await opts.broker.publish({
    kind: 'decision_request',
    at: new Date().toISOString(),
    correlation_id: correlationId,
    tenant_id: opts.tenantId,
    source_agent: sourceAgent,
    payload: {
      question: opts.question,
      options,
      default_option_id: REJECT,
      deadline_seconds: timeoutSec,
    },
  });

  let chosenOptionId: string;
  try {
    const response = await opts.broker.store.awaitDecisionResponse(
      correlationId,
      timeoutSec * 1000,
    );
    chosenOptionId = response.chosen_option_id;
  } catch (err) {
    if (!(err instanceof DecisionTimeoutError)) throw err;
    const fallback = opts.broker.store.respondToDecision(
      correlationId,
      REJECT,
      'timeout fallback',
      'switch-default',
    );
    if (fallback.ok) {
      await opts.broker.publish({
        kind: 'decision_response',
        at: fallback.result.responded_at,
        correlation_id: correlationId,
        tenant_id: opts.tenantId,
        source_agent: 'switch-default',
        payload: {
          chosen_option_id: fallback.result.chosen_option_id,
          reason: fallback.result.reason,
          responder: fallback.result.responder,
        },
      });
      chosenOptionId = REJECT;
    } else {
      const current = opts.broker.store.getDecision(correlationId);
      chosenOptionId = current?.chosen_option_id ?? REJECT;
    }
  }

  if (chosenOptionId !== APPROVE) {
    return { ok: false, reason: 'rejected_by_user', correlation_id: correlationId };
  }

  let result: T;
  try {
    result = await opts.performAction();
  } catch (err) {
    const ghErr = isGhLikeError(err) ? err : { message: String(err) };
    return {
      ok: false,
      reason: 'gh_failed',
      correlation_id: correlationId,
      message: ghErr.message,
      exit_code: ghErr.exitCode,
      stderr: ghErr.stderr,
    };
  }

  if (opts.successEvent) {
    const spec = opts.successEvent(result);
    if (spec) {
      const event: Event = {
        kind: spec.kind,
        at: new Date().toISOString(),
        correlation_id: correlationId,
        tenant_id: opts.tenantId,
        source_agent: sourceAgent,
        payload: spec.payload,
      };
      await opts.broker.publish(event);
    }
  }

  return { ok: true, correlation_id: correlationId, result };
}
