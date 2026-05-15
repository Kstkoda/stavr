/**
 * BOM → food-label adapter. Maps the persisted BOM shape onto the
 * visual contract our food-label component renders.
 *
 * Used by Home (mini cards) and Plans (full cards in C3). Centralised
 * so the risk/reversibility rules don't drift between pages.
 */
import type { Bom, RiskClass, ProfileMode } from '../../types/stavr-bom.js';
import type {
  FoodLabelInput,
  FoodLabelRisk,
  FoodLabelReversible,
} from '../components/food-label.js';

/** Highest risk class an envelope can carry, ordered low → high. */
const RISK_RANK: Record<RiskClass, number> = {
  'read-only':     0,
  'write-local':   1,
  'execute':       2,
  'write-remote':  3,
  'external-comm': 4,
  'credential':    5,
  'financial':     6,
  'destructive':   7,
};

const RISK_BUCKET: Record<RiskClass, FoodLabelRisk> = {
  'read-only':     'low',
  'write-local':   'low',
  'execute':       'medium',
  'write-remote':  'medium',
  'external-comm': 'high',
  'credential':    'high',
  'financial':     'high',
  'destructive':   'high',
};

/** Reversibility per risk class — destructive is the only hard "no". */
const REVERSIBLE: Record<RiskClass, FoodLabelReversible> = {
  'read-only':     'yes',
  'write-local':   'yes',
  'execute':       'yes',
  'write-remote':  'partial',
  'external-comm': 'partial',
  'credential':    'partial',
  'financial':     'no',
  'destructive':   'no',
};

const MODEL_MIX: Record<ProfileMode, string> = {
  turbo:    'Opus',
  balanced: 'Sonnet · Opus',
  eco:      'Haiku · Sonnet',
};

/** The highest-ranked risk in the envelope; defaults to read-only when empty. */
export function highestRisk(envelope: RiskClass[]): RiskClass {
  if (envelope.length === 0) return 'read-only';
  let top: RiskClass = envelope[0];
  for (const r of envelope) {
    if (RISK_RANK[r] > RISK_RANK[top]) top = r;
  }
  return top;
}

/** Overall reversibility — worst case across the envelope. */
export function envelopeReversibility(envelope: RiskClass[]): FoodLabelReversible {
  let worst: FoodLabelReversible = 'yes';
  for (const r of envelope) {
    const v = REVERSIBLE[r];
    if (v === 'no') return 'no';
    if (v === 'partial') worst = 'partial';
  }
  return worst;
}

export function bomToFoodLabel(bom: Bom): FoodLabelInput {
  const topRisk = highestRisk(bom.risk_envelope);
  return {
    id: bom.id,
    name: bom.goal,
    what: `${bom.steps_total} step${bom.steps_total === 1 ? '' : 's'} · ${bom.status}`,
    riskClass: RISK_BUCKET[topRisk],
    reversible: envelopeReversibility(bom.risk_envelope),
    costUsd: bom.cost_estimate,
    modelMix: MODEL_MIX[bom.profile_mode],
    href: `/dashboard/plans#${encodeURIComponent(bom.id)}`,
  };
}

/**
 * "Will ask first" set — risk classes that always open a fresh decision
 * even within an approved scope. Destructive / financial / credential /
 * external-comm cross the line where blanket pre-approval is unsafe.
 * Read-only / write-local / execute / write-remote are auto-approved
 * within the BOM's trust scope.
 */
export const WILL_ASK_RISKS: ReadonlySet<RiskClass> = new Set<RiskClass>([
  'destructive',
  'financial',
  'credential',
  'external-comm',
]);

export interface AllowedSplit {
  allowed: RiskClass[];
  willAsk: RiskClass[];
}

/**
 * Split the envelope into classes pre-approved on scope creation vs those
 * that re-prompt on each invocation. Used by the Plans Risk cell so the
 * approver sees the difference between "I'm signing off on a scope" and
 * "I'm pre-approving every action inside it".
 */
export function splitEnvelope(envelope: RiskClass[]): AllowedSplit {
  const allowed: RiskClass[] = [];
  const willAsk: RiskClass[] = [];
  for (const r of envelope) {
    if (WILL_ASK_RISKS.has(r)) willAsk.push(r);
    else allowed.push(r);
  }
  return { allowed, willAsk };
}

export { RISK_BUCKET, MODEL_MIX };
