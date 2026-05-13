import { randomUUID } from 'node:crypto';
import type { Broker } from '../broker.js';
import { DecisionTimeoutError } from '../persistence.js';
import type { Event, EventKindT } from '../event-types.js';
import type { TrustStore } from '../trust/store.js';
import { checkNoGo, noGoTimeoutSec, type NoGoEntry } from '../trust/no-go-list.js';

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
  /**
   * Optional trust-scope check. If a covering active scope exists for
   * (scopeCheck.tool, scopeCheck.args), the action is auto-approved, executed,
   * and recorded under the scope without opening an await_decision. Callers
   * that don't pass scopeCheck (or that omit trustStore in the broker context)
   * always gate via await_decision — preserves the legacy CONFIRM behavior.
   */
  scopeCheck?: {
    tool: string;
    args: unknown;
    trustStore?: TrustStore;
  };
}

export type GatedActionFailure =
  | { ok: false; reason: 'rejected_by_user'; correlation_id: string }
  | { ok: false; reason: 'no_go_blocked'; correlation_id: string; entry_id: string }
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

  // Spec 48 Layer 3 — no-go check. The no-go list is a deny-override floor:
  // even an explicit trust scope cannot auto-approve a no-go action. If a
  // pattern matches, we route the action through a no-go decision_request
  // with a longer timeout, harsher framing, and reject-on-timeout. The
  // existing trust scope is recorded as "active at the time" for audit but
  // does not authorize the action.
  const toolName = opts.scopeCheck?.tool;
  const toolArgs = opts.scopeCheck?.args;
  const noGoMatch =
    toolName !== undefined ? checkNoGo(toolName, toolArgs) : undefined;

  // Trust-scope short-circuit: if an active covering scope exists for this
  // tool+args AND there's no no-go match, auto-approve, record the action,
  // and skip await_decision.
  if (opts.scopeCheck && opts.scopeCheck.trustStore && !noGoMatch) {
    const covering = opts.scopeCheck.trustStore.findActiveScopeFor({
      tool: opts.scopeCheck.tool,
      args: opts.scopeCheck.args,
    });
    if (covering) {
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
      opts.scopeCheck.trustStore.recordScopeAction(
        covering.id,
        opts.scopeCheck.tool,
        opts.scopeCheck.args,
        result,
      );
      await opts.broker.publish({
        kind: 'trust_scope_action_authorized',
        at: new Date().toISOString(),
        correlation_id: correlationId,
        tenant_id: opts.tenantId,
        source_agent: sourceAgent,
        payload: {
          scope_id: covering.id,
          tool: opts.scopeCheck.tool,
          args: opts.scopeCheck.args,
        },
      });
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
  }

  // If a no-go pattern fired, swap in the no-go question + timeout. The active
  // scope (if any) is captured in the no_go_match event so reviewers can see
  // what the User was about to auto-approve before the floor kicked in.
  const usingNoGo = noGoMatch !== undefined;
  let activeScopeId: string | undefined;
  if (usingNoGo && opts.scopeCheck?.trustStore) {
    const covering = opts.scopeCheck.trustStore.findActiveScopeFor({
      tool: opts.scopeCheck.tool,
      args: opts.scopeCheck.args,
    });
    activeScopeId = covering?.id;
  }
  if (usingNoGo) {
    await opts.broker.publish({
      kind: 'no_go_match',
      at: new Date().toISOString(),
      correlation_id: correlationId,
      tenant_id: opts.tenantId,
      source_agent: sourceAgent,
      payload: {
        entry_id: noGoMatch!.id,
        tool: toolName ?? '',
        args: toolArgs,
        severity: noGoMatch!.severity,
        active_scope_id: activeScopeId,
        reason: noGoMatch!.reason,
      },
    });
  }

  const effectiveTimeoutSec = usingNoGo ? noGoTimeoutSec(noGoMatch!.severity) : timeoutSec;
  const question = usingNoGo ? buildNoGoQuestion(noGoMatch!, opts.question) : opts.question;

  const options = [
    { id: APPROVE, label: 'Approve' },
    { id: REJECT, label: 'Reject' },
  ];

  opts.broker.store.createDecision(correlationId, question, options, effectiveTimeoutSec, REJECT);

  await opts.broker.publish({
    kind: 'decision_request',
    at: new Date().toISOString(),
    correlation_id: correlationId,
    tenant_id: opts.tenantId,
    source_agent: sourceAgent,
    payload: {
      question,
      options,
      default_option_id: REJECT,
      deadline_seconds: effectiveTimeoutSec,
    },
  });

  let chosenOptionId: string;
  let responder = 'unknown';
  try {
    const response = await opts.broker.store.awaitDecisionResponse(
      correlationId,
      effectiveTimeoutSec * 1000,
    );
    chosenOptionId = response.chosen_option_id;
    responder = response.responder;
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
      responder = 'switch-default';
    } else {
      const current = opts.broker.store.getDecision(correlationId);
      chosenOptionId = current?.chosen_option_id ?? REJECT;
    }
  }

  if (chosenOptionId !== APPROVE) {
    if (usingNoGo) {
      await opts.broker.publish({
        kind: 'no_go_blocked',
        at: new Date().toISOString(),
        correlation_id: correlationId,
        tenant_id: opts.tenantId,
        source_agent: sourceAgent,
        payload: {
          entry_id: noGoMatch!.id,
          tool: toolName ?? '',
          blocked_reason: responder === 'switch-default' ? 'timeout' : 'rejected_by_user',
          responder,
        },
      });
      return {
        ok: false,
        reason: 'no_go_blocked',
        correlation_id: correlationId,
        entry_id: noGoMatch!.id,
      };
    }
    return { ok: false, reason: 'rejected_by_user', correlation_id: correlationId };
  }

  if (usingNoGo) {
    await opts.broker.publish({
      kind: 'no_go_authorized',
      at: new Date().toISOString(),
      correlation_id: correlationId,
      tenant_id: opts.tenantId,
      source_agent: sourceAgent,
      payload: {
        entry_id: noGoMatch!.id,
        tool: toolName ?? '',
        responder,
        responded_at: new Date().toISOString(),
      },
    });
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

function buildNoGoQuestion(entry: NoGoEntry, originalQuestion: string): string {
  return (
    `⚠ NO-GO MATCH: ${entry.description}\n` +
    `Reason: ${entry.reason}\n` +
    `This kind of action will ALWAYS ask, regardless of any active trust scope.\n\n` +
    `Original request: ${originalQuestion}\n` +
    `Approve this instance? [Approve / Reject]`
  );
}
