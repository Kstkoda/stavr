import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStewardDbs } from '../../../src/steward-agent/db/init.js';
import { PREF_KEYS } from '../../../src/steward-agent/db/types.js';
import { buildRuntime, runtimeFor } from '../../../src/steward-agent/runtimes/index.js';
import { extractJson, sharpenInstruction } from '../../../src/steward-agent/runtimes/retry.js';

describe('v0.5 P2 — runtime selector + retry helpers', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'stavr-p2-'));
  });
  afterEach(() => {
    try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('runtimeFor honors per-task override, falls back to pinned_runtime', () => {
    const b = openStewardDbs(home);
    try {
      // No prefs set → defaults: pinned_runtime=anthropic-opus
      const rt1 = runtimeFor('plan', b.prefs, { anthropic: { apiKey: 'k' } });
      expect(rt1.name).toBe('anthropic');

      // Set per-task override for summarize → ollama
      b.prefs.set(PREF_KEYS.TASK_RUNTIME_OVERRIDES, { summarize: 'ollama' });
      const rt2 = runtimeFor('summarize', b.prefs, { anthropic: { apiKey: 'k' } });
      expect(rt2.name).toBe('ollama');

      // plan still uses pinned_runtime
      const rt3 = runtimeFor('plan', b.prefs, { anthropic: { apiKey: 'k' } });
      expect(rt3.name).toBe('anthropic');

      // Re-pin to openai
      b.prefs.set(PREF_KEYS.PINNED_RUNTIME, 'openai-gpt5');
      const rt4 = runtimeFor('plan', b.prefs, { openai: { apiKey: 'k' } });
      expect(rt4.name).toBe('openai');
    } finally {
      b.close();
    }
  });

  it('buildRuntime accepts anthropic-<model> form for ad-hoc model names', () => {
    const rt = buildRuntime('anthropic-claude-haiku-4-5', { anthropic: { apiKey: 'k' } });
    expect(rt.name).toBe('anthropic');
  });

  it('buildRuntime accepts ollama:<model> form', () => {
    const rt = buildRuntime('ollama:mistral-nemo:12b', {});
    expect(rt.name).toBe('ollama');
  });

  it('buildRuntime throws on unknown runtime', () => {
    expect(() => buildRuntime('does-not-exist', {})).toThrow();
  });

  it('extractJson strips json fences', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('foo bar {"a":1} baz')).toEqual({ a: 1 });
  });

  it('extractJson throws on empty / malformed input', () => {
    expect(() => extractJson('')).toThrow();
    expect(() => extractJson('no braces here')).toThrow();
  });

  it('sharpenInstruction returns base on first attempt, escalates on second/third', () => {
    expect(sharpenInstruction('base', null, 0)).toBe('base');
    expect(sharpenInstruction('base', 'parse error', 0)).toBe('base'); // first attempt: no sharpen
    const second = sharpenInstruction('base', 'parse error: bad json', 1);
    expect(second).toContain('Your previous output failed');
    expect(second).not.toContain('final attempt');
    const third = sharpenInstruction('base', 'still bad', 2);
    expect(third).toContain('final attempt');
  });
});
