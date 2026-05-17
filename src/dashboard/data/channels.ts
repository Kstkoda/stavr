// v0.6 P5 — notification channels snapshot for the Settings page.
//
// Pure read fetcher: pulls per-channel state from the Notifier (in-memory
// registry + persisted last_success_at / last_error from notification_channels).
// Adds an `effectiveStatus` field that classifies each channel as:
//
//   'configured'       — env vars present + last success in last 24h
//   'configured_stale' — env vars present + last success older than 24h (or never)
//   'not_set'          — env vars missing
//
// NO secret values surface — only configured: yes/no + last_success timestamp +
// last_error message (channel-side error strings are operator-friendly: "HTTP
// 403", "smtp connection refused" — no tokens leak through them).

import type { ChannelStatus } from '../../notify/types.js';

export type ChannelEffectiveStatus = 'configured' | 'configured_stale' | 'not_set';

export interface ChannelStatusView extends ChannelStatus {
  effectiveStatus: ChannelEffectiveStatus;
  /** Pretty label for the row: "ntfy.sh", "Email (SMTP)", "Telegram". */
  label: string;
  /** Anchor on the docs page operator can click for help. */
  docAnchor: string;
}

const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

const CHANNEL_LABELS: Record<string, { label: string; docAnchor: string }> = {
  ntfy: { label: 'ntfy.sh', docAnchor: '#ntfy' },
  email: { label: 'Email (SMTP)', docAnchor: '#email' },
  telegram: { label: 'Telegram', docAnchor: '#telegram' },
  webhook: { label: 'Webhook', docAnchor: '#webhook' },
};

interface NotifierLike {
  getChannelStatus(): ChannelStatus[];
}

export function loadChannelStatuses(
  notifier: NotifierLike | undefined,
  now: () => number = Date.now,
): ChannelStatusView[] {
  if (!notifier) return [];
  const t = now();
  return notifier.getChannelStatus().map((s) => {
    const labels = CHANNEL_LABELS[s.id] ?? { label: s.id, docAnchor: `#${s.id}` };
    const effectiveStatus: ChannelEffectiveStatus = !s.configured
      ? 'not_set'
      : s.lastSuccessAt && t - s.lastSuccessAt < STALE_AFTER_MS
        ? 'configured'
        : 'configured_stale';
    return { ...s, ...labels, effectiveStatus };
  });
}
