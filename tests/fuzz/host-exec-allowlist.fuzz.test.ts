/**
 * Phase 5 fuzz — host-exec allowlist (validateAllowlistCall).
 *
 * The host-exec allowlist (src/security/host-exec-allowlist.ts) is the
 * ONLY chokepoint between an AI tool and arbitrary code execution on
 * the operator's host. The structural invariants — shell-metachar
 * rejection, no-path commands, unknown-command refusal — are the floor
 * the allowlist's per-command validators sit on top of. If any of
 * those break, every per-command validator above them is moot.
 *
 * Properties asserted:
 *
 *   1. `validateAllowlistCall` is total — never throws — for any
 *      (command, args, platform) input.
 *
 *   2. Shell-metachar invariant: any command string containing
 *      `; & | < > \` $ \n \r` is ALWAYS denied with reason
 *      "command contains shell metacharacters". Holds before any
 *      allowlist lookup.
 *
 *   3. Path-shape invariant: any command string containing `/` or `\`
 *      is ALWAYS denied with reason "command must be a binary name,
 *      not a path".
 *
 *   4. Unknown-command invariant: a command string that's not in the
 *      DEFAULT_ALLOWLIST is ALWAYS denied with reason
 *      "command not in allowlist".
 *
 *   5. Disabled-entry invariant: when an allowlist entry has
 *      enabled=false, any call to that command is denied even with
 *      arbitrary args. (Asserted with the `node` default-disabled
 *      entry.)
 *
 *   6. Per-command banned-pattern invariants (deterministic):
 *      git rebase -i, npm publish, taskkill /im, kill 0 / kill -1 —
 *      all denied for any arg ordering that satisfies their
 *      validator's structure.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  DEFAULT_ALLOWLIST,
  validateAllowlistCall,
} from '../../src/security/host-exec-allowlist.js';
import { fuzzSeed, RUNS } from './seed.js';

const KNOWN_COMMANDS = new Set(DEFAULT_ALLOWLIST.map((e) => e.command));
const SHELL_METACHARS = [';', '&', '|', '<', '>', '`', '$', '\n', '\r'];
const PLATFORMS: NodeJS.Platform[] = ['win32', 'darwin', 'linux'];

describe('Phase 5 fuzz — validateAllowlistCall', () => {
  it('is total for any (command, args, platform) input', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string({ maxLength: 64 }), fc.constant('')),
        fc.array(fc.string({ maxLength: 32 }), { maxLength: 8 }),
        fc.constantFrom(...PLATFORMS),
        (command, args, platform) => {
          const r = validateAllowlistCall(DEFAULT_ALLOWLIST, command, args, platform);
          return typeof r.allowed === 'boolean';
        },
      ),
      { seed: fuzzSeed('allowlist-total'), numRuns: RUNS },
    );
  });

  it('always denies commands containing shell metacharacters', () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.string({ minLength: 0, maxLength: 16 }),
          fc.constantFrom(...SHELL_METACHARS),
          fc.string({ minLength: 0, maxLength: 16 }),
        ).map(([a, m, b]) => a + m + b),
        fc.array(fc.string({ maxLength: 16 }), { maxLength: 4 }),
        (command, args) => {
          const r = validateAllowlistCall(DEFAULT_ALLOWLIST, command, args);
          return r.allowed === false && r.reason === 'command contains shell metacharacters';
        },
      ),
      { seed: fuzzSeed('allowlist-metachar'), numRuns: RUNS },
    );
  });

  it('always denies commands containing path separators', () => {
    fc.assert(
      fc.property(
        // Construct a command that contains a / or \ but does NOT contain
        // shell metacharacters (so the path-shape check, not the metachar
        // check, drives the rejection). Filter strings that happen to
        // collide with a metachar.
        fc
          .tuple(
            fc.string({ minLength: 0, maxLength: 16 }),
            fc.constantFrom('/', '\\'),
            fc.string({ minLength: 0, maxLength: 16 }),
          )
          .map(([a, sep, b]) => a + sep + b)
          .filter((s) => !SHELL_METACHARS.some((m) => s.includes(m)) && s.length > 0),
        (command) => {
          const r = validateAllowlistCall(DEFAULT_ALLOWLIST, command, []);
          return r.allowed === false && r.reason === 'command must be a binary name, not a path';
        },
      ),
      { seed: fuzzSeed('allowlist-path'), numRuns: RUNS },
    );
  });

  it('always denies unknown commands (not in DEFAULT_ALLOWLIST)', () => {
    fc.assert(
      fc.property(
        fc
          .string({ minLength: 1, maxLength: 32 })
          .filter(
            (s) =>
              s.length > 0 &&
              !SHELL_METACHARS.some((m) => s.includes(m)) &&
              !s.includes('/') &&
              !s.includes('\\') &&
              !KNOWN_COMMANDS.has(s),
          ),
        (command) => {
          const r = validateAllowlistCall(DEFAULT_ALLOWLIST, command, []);
          return r.allowed === false && r.reason === 'command not in allowlist';
        },
      ),
      { seed: fuzzSeed('allowlist-unknown'), numRuns: RUNS },
    );
  });

  it('always denies disabled entries (node is default-disabled)', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 16 }), { maxLength: 4 }), (args) => {
        const r = validateAllowlistCall(DEFAULT_ALLOWLIST, 'node', args);
        return r.allowed === false && /disabled in allowlist/.test(r.reason ?? '');
      }),
      { seed: fuzzSeed('allowlist-disabled'), numRuns: 50 },
    );
  });

  it('always denies git rebase -i regardless of surrounding args', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ maxLength: 8 }), { maxLength: 4 }),
        fc.array(fc.string({ maxLength: 8 }), { maxLength: 4 }),
        (pre, post) => {
          const args = ['rebase', ...pre, '-i', ...post];
          const r = validateAllowlistCall(DEFAULT_ALLOWLIST, 'git', args);
          return r.allowed === false && /git rebase -i/.test(r.reason ?? '');
        },
      ),
      { seed: fuzzSeed('allowlist-git-rebase-i'), numRuns: 100 },
    );
  });

  it('always denies kill of process-group targets (-1, 0)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('-1', '0', '-0'),
        fc.integer({ min: 1, max: 1_000_000 }),
        (target, decoy) => {
          // include a positive pid so the validator passes the
          // "positive numeric PID required" check first, exposing the
          // target ban as the failure reason.
          const args = [String(decoy), target];
          const r = validateAllowlistCall(DEFAULT_ALLOWLIST, 'kill', args, 'linux');
          return r.allowed === false && /process groups/.test(r.reason ?? '');
        },
      ),
      { seed: fuzzSeed('allowlist-kill-group'), numRuns: 50 },
    );
  });

  it('always denies taskkill /im (image-name targeting)', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 32 }).filter((s) => !/[\s/\\]/.test(s)),
        fc.integer({ min: 1, max: 1_000_000 }),
        (imageName, pid) => {
          // /pid present so the "requires /pid" check is satisfied first.
          const args = ['/pid', String(pid), '/im', imageName];
          const r = validateAllowlistCall(DEFAULT_ALLOWLIST, 'taskkill', args, 'win32');
          return r.allowed === false && /taskkill \/im/.test(r.reason ?? '');
        },
      ),
      { seed: fuzzSeed('allowlist-taskkill-im'), numRuns: 50 },
    );
  });

  it('always denies curl against non-loopback URLs', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          'http://example.com/x',
          'https://1.1.1.1/',
          'http://internal.corp/api',
          'https://2.2.2.2:8080/foo',
        ),
        (url) => {
          const r = validateAllowlistCall(DEFAULT_ALLOWLIST, 'curl', [url]);
          return r.allowed === false && /loopback/.test(r.reason ?? '');
        },
      ),
      { seed: fuzzSeed('allowlist-curl-nonlocal'), numRuns: 50 },
    );
  });

  it('rejects empty-string command', () => {
    const r = validateAllowlistCall(DEFAULT_ALLOWLIST, '', []);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/non-empty string/);
  });
});
