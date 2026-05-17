import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ALLOWLIST,
  validateAllowlistCall,
} from '../../src/security/host-exec-allowlist.js';
import { loadHostExecConfig } from '../../src/security/host-exec-config.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('host-exec allowlist — validateAllowlistCall (positive)', () => {
  it('allows git status', () => {
    const r = validateAllowlistCall(DEFAULT_ALLOWLIST, 'git', ['status']);
    expect(r.allowed).toBe(true);
    expect(r.entry?.command).toBe('git');
  });

  it('allows npm install', () => {
    const r = validateAllowlistCall(DEFAULT_ALLOWLIST, 'npm', ['install']);
    expect(r.allowed).toBe(true);
  });

  it('allows pm2 restart stavr', () => {
    const r = validateAllowlistCall(DEFAULT_ALLOWLIST, 'pm2', ['restart', 'stavr']);
    expect(r.allowed).toBe(true);
  });

  it('allows netstat with arbitrary args (read-only)', () => {
    const r = validateAllowlistCall(DEFAULT_ALLOWLIST, 'netstat', ['-an']);
    expect(r.allowed).toBe(true);
  });

  it('allows taskkill /pid <numeric> on win32', () => {
    const r = validateAllowlistCall(DEFAULT_ALLOWLIST, 'taskkill', ['/pid', '4242', '/f'], 'win32');
    expect(r.allowed).toBe(true);
  });

  it('allows kill <numeric-pid> on linux', () => {
    const r = validateAllowlistCall(DEFAULT_ALLOWLIST, 'kill', ['1234'], 'linux');
    expect(r.allowed).toBe(true);
  });
});

describe('host-exec allowlist — validateAllowlistCall (negative)', () => {
  it('rejects command not in allowlist', () => {
    const r = validateAllowlistCall(DEFAULT_ALLOWLIST, 'rm', ['-rf', '/']);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('not in allowlist');
  });

  it('rejects git rebase -i (interactive)', () => {
    const r = validateAllowlistCall(DEFAULT_ALLOWLIST, 'git', ['rebase', '-i', 'HEAD~3']);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/rebase -i|interactive/i);
  });

  it('rejects git config --global', () => {
    const r = validateAllowlistCall(DEFAULT_ALLOWLIST, 'git', [
      'config',
      '--global',
      'user.email',
      'x@y',
    ]);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('--global');
  });

  it('rejects git filter-repo and filter-branch', () => {
    expect(validateAllowlistCall(DEFAULT_ALLOWLIST, 'git', ['filter-repo']).allowed).toBe(false);
    expect(validateAllowlistCall(DEFAULT_ALLOWLIST, 'git', ['filter-branch']).allowed).toBe(false);
  });

  it('rejects npm publish', () => {
    const r = validateAllowlistCall(DEFAULT_ALLOWLIST, 'npm', ['publish']);
    expect(r.allowed).toBe(false);
  });

  it('rejects npm config set //*:_authToken', () => {
    const r = validateAllowlistCall(DEFAULT_ALLOWLIST, 'npm', [
      'config',
      'set',
      '//registry.npmjs.org/:_authToken',
      'xxx',
    ]);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/token/i);
  });

  it('rejects pm2 set', () => {
    const r = validateAllowlistCall(DEFAULT_ALLOWLIST, 'pm2', ['set', 'foo', 'bar']);
    expect(r.allowed).toBe(false);
  });

  it('rejects taskkill /im <name>', () => {
    const r = validateAllowlistCall(
      DEFAULT_ALLOWLIST,
      'taskkill',
      ['/im', 'node.exe', '/f'],
      'win32',
    );
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/\/im/);
  });

  it('rejects taskkill without /pid', () => {
    const r = validateAllowlistCall(DEFAULT_ALLOWLIST, 'taskkill', ['/f'], 'win32');
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/\/pid/);
  });

  it('rejects taskkill /pid with non-numeric', () => {
    const r = validateAllowlistCall(DEFAULT_ALLOWLIST, 'taskkill', ['/pid', 'node'], 'win32');
    expect(r.allowed).toBe(false);
  });

  it('rejects taskkill on non-win32 platforms', () => {
    const r = validateAllowlistCall(DEFAULT_ALLOWLIST, 'taskkill', ['/pid', '1'], 'linux');
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/not available on platform/);
  });

  it('rejects kill -1 / kill 0', () => {
    expect(
      validateAllowlistCall(DEFAULT_ALLOWLIST, 'kill', ['-1'], 'linux').allowed,
    ).toBe(false);
    expect(
      validateAllowlistCall(DEFAULT_ALLOWLIST, 'kill', ['0'], 'linux').allowed,
    ).toBe(false);
  });

  it('rejects kill -9 -1 (process group)', () => {
    const r = validateAllowlistCall(DEFAULT_ALLOWLIST, 'kill', ['-9', '-1'], 'linux');
    expect(r.allowed).toBe(false);
  });

  it('rejects kill on win32', () => {
    const r = validateAllowlistCall(DEFAULT_ALLOWLIST, 'kill', ['1234'], 'win32');
    expect(r.allowed).toBe(false);
  });

  it('rejects node by default (enabled=false)', () => {
    const r = validateAllowlistCall(DEFAULT_ALLOWLIST, 'node', ['-e', 'process.exit(0)']);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/disabled/i);
  });

  it('rejects empty / non-string command', () => {
    expect(validateAllowlistCall(DEFAULT_ALLOWLIST, '', ['x']).allowed).toBe(false);
    expect(
      validateAllowlistCall(DEFAULT_ALLOWLIST, undefined as unknown as string, []).allowed,
    ).toBe(false);
  });

  it('rejects command with shell metacharacters', () => {
    const r = validateAllowlistCall(DEFAULT_ALLOWLIST, 'git ; rm -rf /', ['status']);
    expect(r.allowed).toBe(false);
    // Falls through to metachar check before reaching the lookup.
    expect(r.reason).toMatch(/metachar|not in allowlist/);
  });

  it('rejects command containing a path', () => {
    expect(validateAllowlistCall(DEFAULT_ALLOWLIST, '/usr/bin/git', ['status']).allowed).toBe(false);
    expect(
      validateAllowlistCall(DEFAULT_ALLOWLIST, 'C:\\Windows\\System32\\cmd.exe', []).allowed,
    ).toBe(false);
  });
});

describe('host-exec allowlist — curl (loopback-only HTTP)', () => {
  it('allows curl --version (no URL, only flags)', () => {
    const r = validateAllowlistCall(DEFAULT_ALLOWLIST, 'curl', ['--version']);
    expect(r.allowed).toBe(true);
  });

  it('allows curl with explicit loopback URL', () => {
    const r = validateAllowlistCall(DEFAULT_ALLOWLIST, 'curl', ['http://localhost:7777/healthz']);
    expect(r.allowed).toBe(true);
  });

  it('allows curl with 127.0.0.1 URL + flags', () => {
    const r = validateAllowlistCall(DEFAULT_ALLOWLIST, 'curl', [
      '-s', '--max-time', '5', 'http://127.0.0.1:7777/api/pending-actions',
    ]);
    expect(r.allowed).toBe(true);
  });

  it('allows curl with https loopback', () => {
    const r = validateAllowlistCall(DEFAULT_ALLOWLIST, 'curl', [
      '-k', 'https://localhost:8443/metrics',
    ]);
    expect(r.allowed).toBe(true);
  });

  it('LOCK curl-non-loopback — rejects external URL', () => {
    const r = validateAllowlistCall(DEFAULT_ALLOWLIST, 'curl', ['http://google.com']);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/loopback/i);
  });

  it('LOCK curl-non-loopback-https — rejects external https URL', () => {
    const r = validateAllowlistCall(DEFAULT_ALLOWLIST, 'curl', ['https://example.com/api']);
    expect(r.allowed).toBe(false);
  });

  it('LOCK curl-upload-file — rejects -T upload', () => {
    const r = validateAllowlistCall(DEFAULT_ALLOWLIST, 'curl', ['-T', '/etc/passwd', 'http://localhost/x']);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/upload|write/i);
  });

  it('LOCK curl-data-post — rejects -d POST data', () => {
    const r = validateAllowlistCall(DEFAULT_ALLOWLIST, 'curl', ['-d', 'x=1', 'http://localhost/api']);
    expect(r.allowed).toBe(false);
  });

  it('LOCK curl-form-upload — rejects -F multipart', () => {
    const r = validateAllowlistCall(DEFAULT_ALLOWLIST, 'curl', ['-F', 'file=@./secret', 'http://localhost/upload']);
    expect(r.allowed).toBe(false);
  });

  it('LOCK curl-basic-auth — rejects -u user:pass', () => {
    const r = validateAllowlistCall(DEFAULT_ALLOWLIST, 'curl', ['-u', 'admin:secret', 'http://localhost/x']);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/auth/i);
  });

  it('LOCK curl-resolve-smuggle — rejects --resolve (loopback bypass)', () => {
    const r = validateAllowlistCall(DEFAULT_ALLOWLIST, 'curl', ['--resolve', 'localhost:80:1.2.3.4', 'http://localhost/']);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/bypass|resolve/i);
  });

  it('LOCK curl-connect-to — rejects --connect-to (loopback bypass)', () => {
    const r = validateAllowlistCall(DEFAULT_ALLOWLIST, 'curl', ['--connect-to', 'localhost:80:evil.com:80', 'http://localhost/']);
    expect(r.allowed).toBe(false);
  });

  it('LOCK curl-post-verb — rejects -X POST', () => {
    const r = validateAllowlistCall(DEFAULT_ALLOWLIST, 'curl', ['-X', 'POST', 'http://localhost/api']);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/POST/);
  });

  it('LOCK curl-delete-verb — rejects -X DELETE', () => {
    const r = validateAllowlistCall(DEFAULT_ALLOWLIST, 'curl', ['-X', 'DELETE', 'http://localhost/api/1']);
    expect(r.allowed).toBe(false);
  });

  it('LOCK curl-url-without-protocol — rejects non-flag arg without http://', () => {
    const r = validateAllowlistCall(DEFAULT_ALLOWLIST, 'curl', ['example.com']);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/explicit|prefix|loopback/i);
  });
});

describe('host-exec config loader — restrict-only semantics', () => {
  it('returns defaults when no config file exists', () => {
    const list = loadHostExecConfig({ configPath: join(tmpdir(), 'definitely-not-there-' + Date.now() + '.json') });
    expect(list.find((e) => e.command === 'git')?.enabled).toBe(true);
    expect(list.find((e) => e.command === 'node')?.enabled).toBe(false);
  });

  it('honors operator-set enabled=false (disable a built-in)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stavr-hostexec-'));
    const cfg = join(dir, 'host-exec.json');
    writeFileSync(cfg, JSON.stringify({ overrides: { git: { enabled: false } } }));
    const list = loadHostExecConfig({ configPath: cfg });
    expect(list.find((e) => e.command === 'git')?.enabled).toBe(false);
  });

  it('honors operator-set enabled=true (re-enable node)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stavr-hostexec-'));
    const cfg = join(dir, 'host-exec.json');
    writeFileSync(cfg, JSON.stringify({ overrides: { node: { enabled: true } } }));
    const list = loadHostExecConfig({ configPath: cfg });
    expect(list.find((e) => e.command === 'node')?.enabled).toBe(true);
  });

  it('ignores attempts to add an unknown command (cannot expand)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stavr-hostexec-'));
    const cfg = join(dir, 'host-exec.json');
    writeFileSync(
      cfg,
      JSON.stringify({ overrides: { wget: { enabled: true }, chmod: { enabled: true } } }),
    );
    const list = loadHostExecConfig({ configPath: cfg });
    expect(list.find((e) => e.command === 'wget')).toBeUndefined();
    expect(list.find((e) => e.command === 'chmod')).toBeUndefined();
  });

  it('only TIGHTENS timeout, never extends', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stavr-hostexec-'));
    const cfg = join(dir, 'host-exec.json');
    writeFileSync(
      cfg,
      JSON.stringify({
        overrides: {
          git: { timeout_default_ms: 1_000 },        // tighter: applied
          npm: { timeout_default_ms: 60 * 60 * 1000 }, // looser: ignored
        },
      }),
    );
    const list = loadHostExecConfig({ configPath: cfg });
    expect(list.find((e) => e.command === 'git')?.timeout_default_ms).toBe(1_000);
    // npm default is 10 min — operator's 60 min should be discarded.
    expect(list.find((e) => e.command === 'npm')?.timeout_default_ms).toBe(10 * 60 * 1000);
  });
});
