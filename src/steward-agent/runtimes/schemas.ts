// v0.5 P2 — Zod schemas for ModelRuntime outputs.
//
// ADR-032 §Decision 5 mandates schema validation on every model output before
// dispatch. Schemas tighten the loose stavr-bom.ts types where the LLM has a
// known tendency to misfire — notably cost magnitude (off-by-1000 has bitten
// us twice; see PlannedStepZ.cost_estimate ceiling).

import { z } from 'zod';
import { CAPABILITY_TAGS, RISK_CLASSES, type CapabilityTag, type RiskClass } from '../../types/stavr-bom.js';

export const CapabilityTagZ = z.enum(CAPABILITY_TAGS as unknown as [CapabilityTag, ...CapabilityTag[]]);
export const RiskClassZ = z.enum(RISK_CLASSES as unknown as [RiskClass, ...RiskClass[]]);

export const PlannedStepZ = z.object({
  step_no: z.number().int().positive(),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  capability: CapabilityTagZ,
  risk_class: RiskClassZ,
  brick_id: z.string().min(1),
  model: z.string().min(1),
  // Cap per-step cost at $50 — catches the off-by-1000 mistake (LLM emitting
  // 1500 instead of 1.5). Real production steps are sub-$1.
  cost_estimate: z.number().nonnegative().max(50),
  duration_sec_est: z.number().nonnegative().max(86_400),
  depends_on: z.array(z.number().int().nonnegative()),
});

export const UsageZ = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cost_usd: z.number().nonnegative(),
});

export const ValidatedBOMZ = z.object({
  goal: z.string().min(1),
  steps: z.array(PlannedStepZ).min(1).max(50),
  cost_estimate: z.number().nonnegative().max(100),
  // Same off-by-1000 guard at BOM scope; if the planner intended $100, $100k
  // is almost certainly wrong.
  cost_max: z.number().positive().max(100),
  duration_sec_est: z.number().nonnegative().max(86_400 * 7),
  risk_envelope: z.array(RiskClassZ).min(0).max(8),
  planner_notes: z.string().max(2000).optional(),
  usage: UsageZ,
});

export const DecideOptionZ = z.object({
  id: z.string().min(1),
  label: z.string().min(1).max(200),
  rationale: z.string().max(1000).optional(),
});

export const ValidatedChoiceZ = z.object({
  chosen_option_id: z.string().min(1),
  reason: z.string().min(1).max(2000),
  confidence: z.number().min(0).max(1),
  usage: UsageZ,
});

export const ValidatedDigestZ = z.object({
  summary: z.string().min(1).max(4000),
  highlights: z.array(z.string().max(500)).max(20),
  recommendations: z.array(z.string().max(500)).max(20),
  usage: UsageZ,
});

/**
 * The prompt instruction appended to every plan/decide/summarize call. Models
 * see this in the system prompt; on retry we sharpen it with the schema error
 * (see retry.ts).
 */
export function planSystemPrompt(): string {
  return [
    'You are Steward, the planning brain of a personal MCP agent gateway.',
    'You MUST respond with a single JSON object matching the ValidatedBOM schema.',
    'No prose, no markdown fences, no commentary outside the JSON.',
    'Cost estimates are in US dollars (decimal). Per-step ≤ $50. Per-BOM ≤ $100.',
  ].join('\n');
}

export function decideSystemPrompt(): string {
  return [
    'You are Steward, choosing between the provided options.',
    'You MUST respond with a single JSON object matching the ValidatedChoice schema.',
    'chosen_option_id must exactly match one of the provided option ids.',
    'confidence is a probability in [0, 1].',
  ].join('\n');
}

export function summarizeSystemPrompt(): string {
  return [
    'You are Steward, condensing a window of episodic events.',
    'You MUST respond with a single JSON object matching the ValidatedDigest schema.',
    'highlights are factual observations. recommendations are actionable next steps.',
  ].join('\n');
}
