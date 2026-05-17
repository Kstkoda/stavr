// v0.6 P3 — /notify/reply HTTP handler.
//
// GET-based by design (email/ntfy.sh links are clicked from a browser; cid is
// one-shot + HMAC-signed + short-TTL — see BOM Footgun #4).
//
// Flow:
//   1. Verify HMAC sig (verifyCorrelationId)            → 401 on bad sig
//   2. Look up notification row by signed cid           → 404
//   3. Check consumed_at IS NULL                        → 410 Gone "already responded"
//   4. Check expires_at > now                           → 410 Gone "expired"
//   5. Validate action_id is in notification.actions    → 400
//   6. Mark consumed (one-shot)                         → race-safe via SQL
//   7. Dispatch to ReplyRouter
//   8. Return small HTML page

import type { Request, Response } from 'express';
import { verifyCorrelationId } from './correlation.js';
import type { Notifier } from './notifier.js';
import type { ReplyRouter } from './reply-router.js';
import type { NotificationAction, NotificationRecord } from './types.js';
import { getLogger } from '../log.js';

export interface InboundDeps {
  notifier: Notifier;
  router: ReplyRouter;
  secret: string;
  /** Optional rate limiter (set by P4 hardening). */
  rateLimiter?: { check: (ip: string) => boolean };
}

export function createInboundHandler(deps: InboundDeps): (req: Request, res: Response) => Promise<void> {
  return async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', 'null');
    res.setHeader('Cache-Control', 'no-store');

    const ip = clientIp(req);
    if (deps.rateLimiter && !deps.rateLimiter.check(ip)) {
      sendHtml(res, 429, 'Too many requests', 'Slow down.');
      return;
    }

    const cid = String(req.query.cid ?? '');
    const action = String(req.query.action ?? '');
    if (!cid || !action) {
      sendHtml(res, 400, 'Bad request', 'Missing cid or action.');
      return;
    }

    const verify = verifyCorrelationId(cid, deps.secret);
    if (!verify.ok) {
      const status = verify.reason === 'expired' ? 410 : 401;
      sendHtml(res, status, verify.reason === 'expired' ? 'Expired' : 'Invalid', `Reason: ${verify.reason}`);
      return;
    }

    const row = deps.notifier.getNotificationByCorrelationId(cid);
    if (!row) {
      sendHtml(res, 404, 'Not found', 'No matching notification.');
      return;
    }

    if (row.consumed_at) {
      sendHtml(res, 410, 'Already responded', 'This notification was already acted on (possibly from another device).');
      return;
    }
    if (row.expires_at && row.expires_at < Date.now()) {
      sendHtml(res, 410, 'Expired', 'The reply window has closed. Re-trigger from the dashboard if needed.');
      return;
    }

    const actions = parseActions(row);
    const matched = actions.find((a) => a.action_id === action);
    if (!matched) {
      sendHtml(res, 400, 'Bad action', `Action ${action} is not valid for this notification.`);
      return;
    }

    const consumedBy = `webhook:${ip}`;
    const claimed = deps.notifier.markConsumed(cid, consumedBy);
    if (!claimed) {
      // Race lost — another caller consumed between our row read and mark.
      sendHtml(res, 410, 'Already responded', 'Another device responded first.');
      return;
    }

    let routeResult;
    try {
      routeResult = await deps.router.route({
        notificationId: row.id,
        notificationCorrelationId: cid,
        source: 'webhook',
        sourceLabel: ip,
        actionId: action,
        actions,
      });
    } catch (err) {
      getLogger().error('inbound: router threw', { error: (err as Error).message });
      sendHtml(res, 500, 'Server error', 'Reply recorded but dispatch failed. Operator can retry from dashboard.');
      return;
    }

    sendHtml(res, 200, renderTitle(matched, routeResult), renderBody(matched, routeResult));
  };
}

function parseActions(row: NotificationRecord): NotificationAction[] {
  if (!row.actions_json) return [];
  try {
    const parsed = JSON.parse(row.actions_json) as NotificationAction[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function renderTitle(action: NotificationAction, result: { ok: boolean; kind?: string }): string {
  if (!result.ok) return 'Reply received';
  switch (action.kind) {
    case 'approve':
      return 'Approved';
    case 'deny':
      return 'Denied';
    case 'grant_extension':
      return 'Scope extended';
    case 'ignore':
      return 'Dismissed';
    default:
      return 'Reply received';
  }
}

function renderBody(action: NotificationAction, result: unknown): string {
  const r = result as { ok: boolean; kind?: string; outcome?: string };
  if (!r.ok) return `Reply recorded, but the action could not be completed. Check the dashboard.`;
  if (r.kind === 'decision' && r.outcome === 'late') {
    return 'The decision was already responded to. Your reply was logged as a late response.';
  }
  return `Action "${action.label}" recorded. You can close this tab.`;
}

function sendHtml(res: Response, status: number, title: string, body: string): void {
  res.status(status).type('html').send(htmlPage(title, body));
}

function htmlPage(title: string, body: string): string {
  const safeTitle = escapeHtml(title);
  const safeBody = escapeHtml(body);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${safeTitle} · stavR</title>
<style>
  body { font-family: ui-monospace, SFMono-Regular, monospace; background:#0e0f15; color:#d6d6d0; padding:24px; max-width:560px; margin:auto; }
  h1 { font-size:18px; margin-bottom:12px; color:#e5b15a; }
  p  { line-height:1.6; }
  .footer { color:#666; font-size:12px; margin-top:24px; }
</style></head><body>
<h1>${safeTitle}</h1>
<p>${safeBody}</p>
<p class="footer">stavR · v0.6 notification reply</p>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function clientIp(req: Request): string {
  const fwd = req.header('x-forwarded-for');
  if (fwd) return fwd.split(',')[0]!.trim();
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}
