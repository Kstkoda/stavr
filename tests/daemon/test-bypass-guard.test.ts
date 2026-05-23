/**
 * Phase 2 hardening — boot-time guard for the chokepoint test bypass.
 *
 * Verifies `assertNoChokepointTestBypassInProduction()` refuses to allow
 * boot when STAVR_CHOKEPOINT_TEST_AUTO_APPROVE is set without the test-
 * run signal (VITEST=true or NODE_ENV=test). The guard runs at the top
 * of `startDaemonForeground` in src/daemon.ts so a stray production
 * `export` of the var is caught loudly at boot rather than silently
 * disabling the per-actor CONFIRM/EXPLICIT enforcement.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertNoChokepointTestBypassInProduction } from '../../src/daemon.js';
import { TEST_AUTO_APPROVE_ENV } from '../../src/security/decision-gate.js';

describe('assertNoChokepointTestBypassInProduction', () => {
  let prevEnv: string | undefined;
  let prevVitest: string | undefined;
  let prevNodeEnv: string | undefined;

  beforeEach(() => {
    prevEnv = process.env[TEST_AUTO_APPROVE_ENV];
    prevVitest = process.env.VITEST;
    prevNodeEnv = process.env.NODE_ENV;
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env[TEST_AUTO_APPROVE_ENV];
    else process.env[TEST_AUTO_APPROVE_ENV] = prevEnv;
    if (prevVitest === undefined) delete process.env.VITEST;
    else process.env.VITEST = prevVitest;
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
  });

  it('throws when env var is set without VITEST or NODE_ENV', () => {
    process.env[TEST_AUTO_APPROVE_ENV] = '1';
    delete process.env.VITEST;
    delete process.env.NODE_ENV;
    expect(() => assertNoChokepointTestBypassInProduction()).toThrow(
      /STAVR_CHOKEPOINT_TEST_AUTO_APPROVE=1 is set but this is not a test run/,
    );
  });

  it('error message instructs the operator how to recover', () => {
    process.env[TEST_AUTO_APPROVE_ENV] = '1';
    delete process.env.VITEST;
    delete process.env.NODE_ENV;
    try {
      assertNoChokepointTestBypassInProduction();
      throw new Error('expected throw');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('Unset the variable or shut down stavR');
      expect(msg).toContain('CONFIRM/EXPLICIT');
    }
  });

  it('passes when env var is set with VITEST=true', () => {
    process.env[TEST_AUTO_APPROVE_ENV] = '1';
    process.env.VITEST = 'true';
    delete process.env.NODE_ENV;
    expect(() => assertNoChokepointTestBypassInProduction()).not.toThrow();
  });

  it('passes when env var is set with NODE_ENV=test', () => {
    process.env[TEST_AUTO_APPROVE_ENV] = '1';
    delete process.env.VITEST;
    process.env.NODE_ENV = 'test';
    expect(() => assertNoChokepointTestBypassInProduction()).not.toThrow();
  });

  it('passes when env var is unset, regardless of test signal', () => {
    delete process.env[TEST_AUTO_APPROVE_ENV];
    delete process.env.VITEST;
    delete process.env.NODE_ENV;
    expect(() => assertNoChokepointTestBypassInProduction()).not.toThrow();
  });
});
