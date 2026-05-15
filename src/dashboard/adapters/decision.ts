/**
 * DecisionRecord → food-label adapter for Home page mini cards.
 *
 * Full Decide page (C4) will render decisions as their own card style
 * with countdown + options; here we want the four-cell shape so Home
 * stays visually uniform across BOMs and decisions.
 */
import type { DecisionRecord } from '../../persistence.js';
import type { FoodLabelInput, FoodLabelRisk } from '../components/food-label.js';

function shorten(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function riskBucket(d: DecisionRecord): FoodLabelRisk {
  if (d.status === 'open') return 'high';
  if (d.status === 'expired') return 'medium';
  return 'low';
}

function costEstimate(d: DecisionRecord): number {
  // Decisions don't carry a USD cost — surface the timeout window in seconds
  // by sneaking it through cost (rendered as $N.NN works; we instead emit
  // 0 and rely on the timer in C4). Keeping 0 here avoids misleading dollars.
  void d;
  return 0;
}

export function decisionToFoodLabel(d: DecisionRecord): FoodLabelInput {
  const what =
    d.status === 'open'
      ? `${d.options.length} option${d.options.length === 1 ? '' : 's'}`
      : `${d.status}${d.chosen_option_id ? ` · ${d.chosen_option_id}` : ''}`;
  return {
    id: d.correlation_id,
    name: shorten(d.question, 80),
    what,
    riskClass: riskBucket(d),
    reversible: d.status === 'open' ? 'partial' : 'yes',
    costUsd: costEstimate(d),
    href: `/dashboard/decide#${encodeURIComponent(d.correlation_id)}`,
  };
}
