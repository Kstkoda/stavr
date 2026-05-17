import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStewardDbs } from '../../../src/steward-agent/db/init.js';
import { PREF_KEYS } from '../../../src/steward-agent/db/types.js';
import {
  startAutonomy,
  readAutonomyMode,
  writeAutonomyMode,
  startReactiveDispatcher,
  startScheduledDispatcher,
  startProactiveDispatcher,
  parseCron,
  matches,
  startProbation,
} from '../../../src/steward-agent/autonomy/index.js';

describe('v0.5 P4 — autonomy mode selector', () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'stavr-p4-')); });
  afterEach(() => { try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('defaults to reactive when no pref set', () => {
    const b = openStewardDbs(home);
    try {
      expect(readAutonomyMode(b.prefs)).toBe('reactive');
    } finally { b.close(); }
  });

  it('round-trips writeAutonomyMode → readAutonomyMode', () => {
    const b = openStewardDbs(home);
    try {
      writeAutonomyMode(b.prefs, 'proactive');
      expect(readAutonomyMode(b.prefs)).toBe('proactive');
    } finally { b.close(); }
  });

  it('startAutonomy with reactive mode does not start scheduled/proactive', () => {
    const b = openStewardDbs(home);
    try {
      const triggers: string[] = [];
      const handle = startAutonomy({
        prefs: b.prefs,
        memory: b.memory,
        onTrigger: (src, reason) => triggers.push(`${src}:${reason}`),
      });
      expect(handle.mode).toBe('reactive');
      expect(handle.scheduled).toBeUndefined();
      expect(handle.proactive).toBeUndefined();
      handle.reactive.wake('test-event');
      // coalesce: tick fires after 50ms
      return new Promise<void>((resolveFn) => {
        setTimeout(() => {
          expect(triggers).toEqual(['reactive:test-event']);
          handle.stop();
          resolveFn();
        }, 100);
      });
    } finally { b.close(); }
  });

  it('startAutonomy with scheduled mode loads scheduled but not proactive', () => {
    const b = openStewardDbs(home);
    try {
      writeAutonomyMode(b.prefs, 'scheduled');
      const handle = startAutonomy({
        prefs: b.prefs,
        memory: b.memory,
        onTrigger: () => {},
      });
      expect(handle.mode).toBe('scheduled');
      expect(handle.scheduled).toBeDefined();
      expect(handle.proactive).toBeUndefined();
      handle.stop();
    } finally { b.close(); }
  });

  it('startAutonomy with proactive mode loads both scheduled and proactive', () => {
    const b = openStewardDbs(home);
    try {
      writeAutonomyMode(b.prefs, 'proactive');
      const handle = startAutonomy({
        prefs: b.prefs,
        memory: b.memory,
        onTrigger: () => {},
      });
      expect(handle.mode).toBe('proactive');
      expect(handle.scheduled).toBeDefined();
      expect(handle.proactive).toBeDefined();
      handle.stop();
    } finally { b.close(); }
  });
});

describe('v0.5 P4 — reactive dispatcher', () => {
  it('coalesces multiple wakes inside coalesce window to one tick', async () => {
    const wakes: string[] = [];
    const r = startReactiveDispatcher({
      onWake: (reason) => wakes.push(reason),
      coalesceMs: 20,
    });
    r.wake('a');
    r.wake('b');
    r.wake('c');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toBe('c'); // freshest reason wins
    r.stop();
  });

  it('coalesceMs=0 fires synchronously', () => {
    const wakes: string[] = [];
    const r = startReactiveDispatcher({
      onWake: (reason) => wakes.push(reason),
      coalesceMs: 0,
    });
    r.wake('x');
    r.wake('y');
    expect(wakes).toEqual(['x', 'y']);
    r.stop();
  });

  it('stop prevents further wakes', async () => {
    const wakes: string[] = [];
    const r = startReactiveDispatcher({ onWake: (reason) => wakes.push(reason), coalesceMs: 5 });
    r.wake('a');
    r.stop();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(wakes).toHaveLength(0);
  });
});

describe('v0.5 P4 — scheduled dispatcher (cron parser + tick)', () => {
  it('parses * field as full range', () => {
    const p = parseCron('* * * * *');
    expect(p.minute.size).toBe(60);
    expect(p.hour.size).toBe(24);
    expect(p.dayOfWeek.size).toBe(7);
  });

  it('parses fixed minute + hour', () => {
    const p = parseCron('0 3 * * *');
    expect([...p.minute]).toEqual([0]);
    expect([...p.hour]).toEqual([3]);
  });

  it('parses comma list', () => {
    const p = parseCron('0,15,30,45 * * * *');
    expect([...p.minute].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
  });

  it('parses range and step', () => {
    const p = parseCron('*/10 * * * *');
    expect([...p.minute].sort((a, b) => a - b)).toEqual([0, 10, 20, 30, 40, 50]);
  });

  it('rejects malformed expression', () => {
    expect(() => parseCron('not enough')).toThrow();
    expect(() => parseCron('a b c d e')).toThrow();
  });

  it('matches() returns true at the right moment', () => {
    const p = parseCron('0 3 * * *');
    const at0300 = new Date(2026, 4, 17, 3, 0, 0);
    expect(matches(p, at0300)).toBe(true);
    const at0301 = new Date(2026, 4, 17, 3, 1, 0);
    expect(matches(p, at0301)).toBe(false);
  });

  it('tickNow fires onTick exactly once per minute even when polled twice', () => {
    const ticks: string[] = [];
    const d = startScheduledDispatcher({
      cronExpr: '0 3 * * *',
      onTick: (reason) => ticks.push(reason),
      manualMode: true,
    });
    const at = new Date(2026, 4, 17, 3, 0, 30);
    expect(d.tickNow(at)).toBe(true);
    // Same minute, second poll → no double-fire
    const at2 = new Date(2026, 4, 17, 3, 0, 45);
    expect(d.tickNow(at2)).toBe(false);
    expect(ticks).toHaveLength(1);
    expect(ticks[0]).toContain('cron:0 3 * * *');
    d.stop();
  });

  it('tickNow returns false outside the cron match', () => {
    const d = startScheduledDispatcher({
      cronExpr: '0 3 * * *',
      onTick: () => {},
      manualMode: true,
    });
    expect(d.tickNow(new Date(2026, 4, 17, 4, 30, 0))).toBe(false);
    d.stop();
  });
});

describe('v0.5 P4 — proactive dispatcher (cost cap + dedupe)', () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'stavr-p4-pro-')); });
  afterEach(() => { try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('canPropose true when spend < cap, false at/above cap', () => {
    const b = openStewardDbs(home);
    try {
      const p = startProactiveDispatcher({
        memory: b.memory,
        prefs: b.prefs,
        onPropose: () => {},
      });
      expect(p.canPropose()).toBe(true); // default cap $2.00, spend $0
      expect(p.spendToday()).toBe(0);
      p.recordSpend(1.5);
      expect(p.canPropose()).toBe(true);
      p.recordSpend(1.0); // total $2.50 > $2.00 cap
      expect(p.canPropose()).toBe(false);
      p.stop();
    } finally { b.close(); }
  });

  it('per-pattern dedupe inside 24h window', () => {
    const b = openStewardDbs(home);
    try {
      const p = startProactiveDispatcher({
        memory: b.memory,
        prefs: b.prefs,
        onPropose: () => {},
        patternDedupeMs: 1000,
      });
      const now = new Date('2026-05-17T12:00:00Z');
      expect(p.shouldFire('topology-drift', now)).toBe(true);
      p.markFired('topology-drift', now);
      // Same pattern, 500ms later → blocked
      expect(p.shouldFire('topology-drift', new Date(now.getTime() + 500))).toBe(false);
      // After window → allowed
      expect(p.shouldFire('topology-drift', new Date(now.getTime() + 1500))).toBe(true);
      // Different pattern → independent
      expect(p.shouldFire('mcp-disconnect', now)).toBe(true);
      p.stop();
    } finally { b.close(); }
  });

  it('respects cost cap override from prefs', () => {
    const b = openStewardDbs(home);
    try {
      b.prefs.set(PREF_KEYS.COST_CAP_DAILY_USD, 0.5);
      const p = startProactiveDispatcher({
        memory: b.memory,
        prefs: b.prefs,
        onPropose: () => {},
      });
      p.recordSpend(0.4);
      expect(p.canPropose()).toBe(true);
      p.recordSpend(0.2); // $0.60 > $0.50
      expect(p.canPropose()).toBe(false);
      p.stop();
    } finally { b.close(); }
  });

  it('spend tracked per-day (different day = clean slate)', () => {
    const b = openStewardDbs(home);
    try {
      const p = startProactiveDispatcher({
        memory: b.memory,
        prefs: b.prefs,
        onPropose: () => {},
      });
      const day1 = new Date('2026-05-17T12:00:00Z');
      const day2 = new Date('2026-05-18T12:00:00Z');
      p.recordSpend(1.9, day1);
      expect(p.spendToday(day1)).toBe(1.9);
      expect(p.spendToday(day2)).toBe(0);
      p.stop();
    } finally { b.close(); }
  });
});

describe('v0.5 P4 — probation harness', () => {
  it('records and returns recent records (newest first)', () => {
    const p = startProbation({ candidateRuntimeName: 'grok-3' });
    const bom = {
      goal: 'g',
      steps: [{ step_no: 1, title: 't', capability: 'reading', risk_class: 'read-only',
        brick_id: 'b', model: 'm', cost_estimate: 0, duration_sec_est: 1, depends_on: [] }],
      cost_estimate: 0, cost_max: 1, duration_sec_est: 1, risk_envelope: ['read-only'],
      usage: { input_tokens: 1, output_tokens: 1, cost_usd: 0 },
    } as unknown as Parameters<typeof p.record>[0]['active_bom'];
    p.record({ bom_id: 'b1', active_runtime: 'opus', candidate_runtime: 'grok-3', active_bom: bom, candidate_bom: bom });
    p.record({ bom_id: 'b2', active_runtime: 'opus', candidate_runtime: 'grok-3', active_bom: bom, candidate_bom: bom });
    expect(p.count()).toBe(2);
    expect(p.recent(2).map((r) => r.bom_id)).toEqual(['b2', 'b1']);
  });

  it('correlation=1.0 when active and candidate BOMs are structurally identical', () => {
    const p = startProbation({ candidateRuntimeName: 'grok-3' });
    const bom = {
      goal: 'g',
      steps: [{ step_no: 1, title: 't', capability: 'reading', risk_class: 'read-only',
        brick_id: 'b', model: 'm', cost_estimate: 0, duration_sec_est: 1, depends_on: [] }],
      cost_estimate: 0, cost_max: 1, duration_sec_est: 1, risk_envelope: ['read-only'],
      usage: { input_tokens: 1, output_tokens: 1, cost_usd: 0 },
    } as unknown as Parameters<typeof p.record>[0]['active_bom'];
    for (let i = 0; i < 5; i++) {
      p.record({ bom_id: `b${i}`, active_runtime: 'opus', candidate_runtime: 'grok-3', active_bom: bom, candidate_bom: bom });
    }
    expect(p.correlation()).toBe(1.0);
  });

  it('correlation drops when candidate has different step count', () => {
    const p = startProbation({ candidateRuntimeName: 'grok-3' });
    const make = (steps: number) => ({
      goal: 'g',
      steps: Array.from({ length: steps }).map((_, i) => ({
        step_no: i + 1, title: 't', capability: 'reading', risk_class: 'read-only',
        brick_id: 'b', model: 'm', cost_estimate: 0, duration_sec_est: 1, depends_on: [],
      })),
      cost_estimate: 0, cost_max: 1, duration_sec_est: 1, risk_envelope: ['read-only'],
      usage: { input_tokens: 1, output_tokens: 1, cost_usd: 0 },
    }) as unknown as Parameters<typeof p.record>[0]['active_bom'];
    const active = make(2);
    const candidate = make(3);
    p.record({ bom_id: 'b1', active_runtime: 'opus', candidate_runtime: 'grok-3', active_bom: active, candidate_bom: candidate });
    expect(p.correlation()).toBeLessThan(0.5);
  });

  it('correlation skips errored candidate BOMs', () => {
    const p = startProbation({ candidateRuntimeName: 'grok-3' });
    const bom = {
      goal: 'g',
      steps: [{ step_no: 1, title: 't', capability: 'reading', risk_class: 'read-only',
        brick_id: 'b', model: 'm', cost_estimate: 0, duration_sec_est: 1, depends_on: [] }],
      cost_estimate: 0, cost_max: 1, duration_sec_est: 1, risk_envelope: ['read-only'],
      usage: { input_tokens: 1, output_tokens: 1, cost_usd: 0 },
    } as unknown as Parameters<typeof p.record>[0]['active_bom'];
    p.record({ bom_id: 'b1', active_runtime: 'opus', candidate_runtime: 'grok-3', active_bom: bom, candidate_bom: { __error: 'boom' } });
    expect(p.correlation()).toBe(0);
  });
});
