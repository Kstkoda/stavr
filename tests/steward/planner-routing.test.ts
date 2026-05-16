import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROFILES,
  isLocalModel,
  LOCAL_FRIENDLY_TAGS,
  type CapabilityTag,
  type ProfileMode,
} from '../../src/types/stavr-bom.js';

/**
 * Per-profile routing matrix invariants. The brief defines:
 *   - Turbo:    never routes to a local model.
 *   - Balanced: prefers local for the trivial tags (simple-summary,
 *               cheap-classifier, and the explicit local-* aliases).
 *   - Eco:      prefers local for every tag that has a local entry.
 */

const TURBO_NEVER_LOCAL_TAGS: CapabilityTag[] = [
  'reading',
  'cheap-classifier',
  'code-execution',
  'code-reasoning',
  'long-context',
  'multimodal-vision',
  'tool-use-heavy',
  'simple-summary',
  'local-classifier',
  'local-reasoning',
  'local-summary',
  'local-reading',
];

function firstChoice(profile: ProfileMode, cap: CapabilityTag): string | undefined {
  return DEFAULT_PROFILES[profile].routing[cap][0];
}

describe('isLocalModel', () => {
  it('recognizes claude-* as remote', () => {
    expect(isLocalModel('claude-opus-4-7')).toBe(false);
    expect(isLocalModel('claude-haiku-4-5')).toBe(false);
  });
  it('treats `family:tag` names as local', () => {
    expect(isLocalModel('llama3.2:3b')).toBe(true);
    expect(isLocalModel('phi3:mini')).toBe(true);
    expect(isLocalModel('deepseek-r1:32b')).toBe(true);
  });
  it('treats empty/unknown as remote-safe (false) to avoid surprise local dispatch', () => {
    expect(isLocalModel('')).toBe(false);
  });
});

describe('DEFAULT_PROFILES — turbo never routes to a local model', () => {
  for (const tag of TURBO_NEVER_LOCAL_TAGS) {
    it(`turbo[${tag}].first is a frontier model`, () => {
      const m = firstChoice('turbo', tag);
      expect(m, `turbo routing has no entry for ${tag}`).toBeDefined();
      expect(isLocalModel(m!)).toBe(false);
    });
  }
});

describe('DEFAULT_PROFILES — eco prefers local for every local-friendly tag', () => {
  for (const tag of LOCAL_FRIENDLY_TAGS) {
    it(`eco[${tag}].first is a local model`, () => {
      const m = firstChoice('eco', tag);
      expect(m, `eco routing has no entry for ${tag}`).toBeDefined();
      expect(isLocalModel(m!)).toBe(true);
    });
  }
});

describe('DEFAULT_PROFILES — balanced routes the cheap tags locally', () => {
  it('cheap-classifier → local', () => {
    expect(isLocalModel(firstChoice('balanced', 'cheap-classifier')!)).toBe(true);
  });
  it('simple-summary → local', () => {
    expect(isLocalModel(firstChoice('balanced', 'simple-summary')!)).toBe(true);
  });
  it('code-reasoning → frontier (never local on balanced)', () => {
    expect(isLocalModel(firstChoice('balanced', 'code-reasoning')!)).toBe(false);
  });
  it('every tag has a frontier fallback in the routing list (for Ollama-down cases)', () => {
    const routing = DEFAULT_PROFILES.balanced.routing;
    for (const tag of Object.keys(routing) as CapabilityTag[]) {
      const list = routing[tag];
      if (list.length === 0) continue; // 'no-model' is intentionally empty
      const hasFrontier = list.some((m) => !isLocalModel(m));
      expect(hasFrontier, `balanced[${tag}] has no frontier fallback`).toBe(true);
    }
  });
});

describe('DEFAULT_PROFILES — eco has a frontier escalation path for non-local-friendly tags', () => {
  it('code-execution falls back to claude on eco (no local-eligible runtime yet)', () => {
    const list = DEFAULT_PROFILES.eco.routing['code-execution'];
    expect(list.length).toBeGreaterThan(0);
    expect(isLocalModel(list[0])).toBe(false);
  });
});
