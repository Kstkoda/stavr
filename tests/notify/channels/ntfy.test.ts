import { describe, expect, it } from 'vitest';
import { NtfyChannel } from '../../../src/notify/channels/ntfy.js';
import type { ChannelSendInput } from '../../../src/notify/types.js';

function makeInput(overrides: Partial<ChannelSendInput> = {}): ChannelSendInput {
  return {
    notificationId: 'n1',
    correlationId: 'cid1',
    kind: 'health_alert',
    severity: 'warn',
    title: 'test title',
    body: 'test body',
    actions: [],
    replyUrls: {},
    severityLabel: '[WARN]',
    ...overrides,
  };
}

describe('NtfyChannel', () => {
  it('reports unconfigured when topic is missing', () => {
    const ch = new NtfyChannel({ topic: undefined });
    expect(ch.isConfigured()).toBe(false);
  });

  it('reports configured with a topic', () => {
    const ch = new NtfyChannel({ topic: 'stavr-kst-test-abcd1234' });
    expect(ch.isConfigured()).toBe(true);
  });

  it('returns ok on 200 + sends correct headers', async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const ch = new NtfyChannel({
      topic: 'stavr-kst-test-abcd1234',
      transport: async (url, headers, body) => {
        calls.push({ url, headers, body });
        return { status: 200, body: '{"id":"x"}' };
      },
    });
    const result = await ch.send(makeInput());
    expect(result.ok).toBe(true);
    expect(calls[0].url).toContain('stavr-kst-test-abcd1234');
    expect(calls[0].headers.Title).toContain('[WARN]');
    expect(calls[0].headers.Title).toContain('test title');
    expect(calls[0].headers.Priority).toBe('4');
    expect(calls[0].headers.Tags).toBe('health_alert');
    expect(calls[0].body).toBe('test body');
  });

  it('encodes Actions header for reply buttons', async () => {
    let captured: Record<string, string> = {};
    const ch = new NtfyChannel({
      topic: 'stavr-kst-test-abcd1234',
      transport: async (_url, headers) => {
        captured = headers;
        return { status: 200, body: '' };
      },
    });
    await ch.send(
      makeInput({
        actions: [
          { label: 'Approve', action_id: 'approve', kind: 'approve' },
          { label: 'Deny', action_id: 'deny', kind: 'deny' },
        ],
        replyUrls: {
          approve: 'http://example/notify/reply?cid=X&action=approve',
          deny: 'http://example/notify/reply?cid=X&action=deny',
        },
      }),
    );
    expect(captured.Actions).toContain('Approve');
    expect(captured.Actions).toContain('Deny');
    expect(captured.Actions).toContain('http://example/notify/reply');
  });

  it('returns failure on non-2xx', async () => {
    const ch = new NtfyChannel({
      topic: 'stavr-kst-test-abcd1234',
      transport: async () => ({ status: 500, body: 'boom' }),
    });
    const result = await ch.send(makeInput());
    expect(result.ok).toBe(false);
    expect(result.error).toContain('500');
  });

  it('returns failure when transport throws', async () => {
    const ch = new NtfyChannel({
      topic: 'stavr-kst-test-abcd1234',
      transport: async () => {
        throw new Error('network down');
      },
    });
    const result = await ch.send(makeInput());
    expect(result.ok).toBe(false);
    expect(result.error).toContain('network down');
  });

  it('crit severity maps to priority 5', async () => {
    let captured: Record<string, string> = {};
    const ch = new NtfyChannel({
      topic: 'stavr-kst-test-abcd1234',
      transport: async (_u, h) => {
        captured = h;
        return { status: 200, body: '' };
      },
    });
    await ch.send(makeInput({ severity: 'crit', severityLabel: '[CRIT]' }));
    expect(captured.Priority).toBe('5');
  });
});
