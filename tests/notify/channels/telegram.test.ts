import { describe, expect, it } from 'vitest';
import { TelegramChannel } from '../../../src/notify/channels/telegram.js';
import type { ChannelSendInput } from '../../../src/notify/types.js';

function makeInput(overrides: Partial<ChannelSendInput> = {}): ChannelSendInput {
  return {
    notificationId: 'n1',
    correlationId: 'a'.repeat(40),
    kind: 'decision_required',
    severity: 'warn',
    title: 'approve?',
    body: 'continue?',
    actions: [],
    replyUrls: {},
    severityLabel: '[WARN]',
    ...overrides,
  };
}

describe('TelegramChannel', () => {
  it('reports unconfigured when token or chat_id missing', () => {
    const a = new TelegramChannel({ botToken: undefined, chatId: 'x' });
    expect(a.isConfigured()).toBe(false);
    const b = new TelegramChannel({ botToken: 'x', chatId: undefined });
    expect(b.isConfigured()).toBe(false);
  });

  it('POSTs sendMessage with chat_id + text', async () => {
    const calls: Array<{ path: string; body: string }> = [];
    const ch = new TelegramChannel({
      botToken: '123:abc',
      chatId: 'chat42',
      transport: async (path, body) => {
        calls.push({ path, body });
        return { status: 200, body: '{"ok":true}' };
      },
    });
    const result = await ch.send(makeInput());
    expect(result.ok).toBe(true);
    expect(calls[0].path).toBe('/bot123:abc/sendMessage');
    const parsed = JSON.parse(calls[0].body);
    expect(parsed.chat_id).toBe('chat42');
    expect(parsed.text).toContain('approve?');
    expect(parsed.text).toContain('continue?');
  });

  it('builds inline_keyboard with callback_data for non-link actions', async () => {
    let payload: { reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>> } } = {};
    const ch = new TelegramChannel({
      botToken: 't',
      chatId: 'c',
      transport: async (_p, body) => {
        payload = JSON.parse(body);
        return { status: 200, body: '' };
      },
    });
    await ch.send(
      makeInput({
        actions: [
          { label: 'Approve', action_id: 'approve', kind: 'approve' },
          { label: 'Deny', action_id: 'deny', kind: 'deny' },
          { label: 'Open', action_id: 'open', kind: 'link', url: 'http://example' },
        ],
      }),
    );
    const buttons = payload.reply_markup!.inline_keyboard.flat();
    expect(buttons.find((b) => b.text === 'Approve')!.callback_data).toContain(':approve');
    expect(buttons.find((b) => b.text === 'Deny')!.callback_data).toContain(':deny');
    expect(buttons.find((b) => b.text === 'Open')!.url).toBe('http://example');
  });

  it('returns failure on non-2xx', async () => {
    const ch = new TelegramChannel({
      botToken: 't',
      chatId: 'c',
      transport: async () => ({ status: 403, body: 'Forbidden' }),
    });
    const r = await ch.send(makeInput());
    expect(r.ok).toBe(false);
    expect(r.error).toContain('403');
  });

  it('returns failure on transport throw', async () => {
    const ch = new TelegramChannel({
      botToken: 't',
      chatId: 'c',
      transport: async () => {
        throw new Error('offline');
      },
    });
    const r = await ch.send(makeInput());
    expect(r.ok).toBe(false);
    expect(r.error).toContain('offline');
  });
});
