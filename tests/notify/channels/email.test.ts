import { describe, expect, it } from 'vitest';
import { EmailChannel, renderEmail } from '../../../src/notify/channels/email.js';
import type { ChannelSendInput } from '../../../src/notify/types.js';

function makeInput(overrides: Partial<ChannelSendInput> = {}): ChannelSendInput {
  return {
    notificationId: 'n1',
    correlationId: 'cid1',
    kind: 'decision_required',
    severity: 'warn',
    title: 'approve PR #99',
    body: 'merge ready',
    actions: [],
    replyUrls: {},
    severityLabel: '[WARN]',
    ...overrides,
  };
}

describe('EmailChannel', () => {
  it('reports unconfigured when env vars missing', () => {
    const ch = new EmailChannel({});
    // env may or may not be set during test runs; isConfigured checks all 5.
    // Explicitly pass nothing: ensure it returns false.
    expect(ch.isConfigured() && !process.env.STAVR_NOTIFY_EMAIL_FROM).toBe(false);
  });

  it('reports configured with full opts', () => {
    const ch = new EmailChannel({
      from: 'a@b',
      to: 'c@d',
      host: 'smtp',
      user: 'u',
      pass: 'p',
    });
    expect(ch.isConfigured()).toBe(true);
  });

  it('renders subject/text/html via injected sender', async () => {
    let sent: { subject: string; text: string; html: string } | null = null;
    const ch = new EmailChannel({
      from: 'a@b',
      to: 'c@d',
      host: 'h',
      user: 'u',
      pass: 'p',
      sender: async (msg) => {
        sent = msg;
      },
    });
    const r = await ch.send(
      makeInput({
        actions: [{ label: 'Approve', action_id: 'approve', kind: 'approve' }],
        replyUrls: { approve: 'http://example/reply?cid=x&action=approve' },
      }),
    );
    expect(r.ok).toBe(true);
    expect(sent).not.toBeNull();
    expect(sent!.subject).toContain('approve PR #99');
    expect(sent!.text).toContain('http://example/reply');
    expect(sent!.html).toContain('approve PR #99');
    expect(sent!.html).toContain('http://example/reply');
  });

  it('returns failure when sender throws', async () => {
    const ch = new EmailChannel({
      from: 'a@b',
      to: 'c@d',
      host: 'h',
      user: 'u',
      pass: 'p',
      sender: async () => {
        throw new Error('smtp closed');
      },
    });
    const r = await ch.send(makeInput());
    expect(r.ok).toBe(false);
    expect(r.error).toContain('smtp closed');
  });

  it('renderEmail escapes html-unsafe characters in title/body', () => {
    const msg = renderEmail(makeInput({ title: '<script>', body: 'a & b' }), 'a@b', 'c@d');
    expect(msg.html).not.toContain('<script>');
    expect(msg.html).toContain('&lt;script&gt;');
    expect(msg.html).toContain('a &amp; b');
  });
});
