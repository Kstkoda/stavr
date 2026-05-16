// src/tools/capture.ts
//
// Capture ⊕ — the "I want to flag this thing" surface. The dashboard's
// floating Capture button POSTs a snapshot + comment to /dashboard/capture;
// this module handles the write path.
//
// v0.4 routing: append to `~/.stavr/captures/<type>.jsonl`. The Steward will
// later route to GitHub Issues / Linear / etc per the Settings → Captures
// config (v0.6+, ADR-035 phase 1). Until then the file is the system of
// record — operators can grep it, attach it to issues, or pipe it through
// `jq`.
//
// The write is also emitted as a `capture_filed` audit event so the trail
// survives the 90-day audit retention window (ADR-030).

import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export type CaptureType = 'bug' | 'feature' | 'investigate' | 'todo';
export type CapturePriority = 'low' | 'normal' | 'high';

export const CAPTURE_TYPES: readonly CaptureType[] = ['bug', 'feature', 'investigate', 'todo'];
export const CAPTURE_PRIORITIES: readonly CapturePriority[] = ['low', 'normal', 'high'];

export function isCaptureType(s: string): s is CaptureType {
  return (CAPTURE_TYPES as readonly string[]).includes(s);
}
export function isCapturePriority(s: string): s is CapturePriority {
  return (CAPTURE_PRIORITIES as readonly string[]).includes(s);
}

export interface CaptureSnapshot {
  /** Page the operator was on when they clicked Capture. */
  page?: string;
  /** Full URL (for deep-link recall). */
  url?: string;
  /** In-flight BOM ids at capture time. */
  in_flight_bom_ids?: string[];
  /** Last N event kinds (compressed snapshot, not the events themselves). */
  recent_event_kinds?: string[];
  /** Daemon health summary (from /healthz + /metrics scrape). */
  daemon_health?: { ok: boolean; rss_mb?: number; eventloop_lag_p99_ms?: number };
}

export interface CaptureInput {
  snapshot: CaptureSnapshot;
  comment: string;
  type: CaptureType;
  priority: CapturePriority;
  /** Optional BOM/worker/decision id this capture references. */
  related_id?: string;
}

export interface CaptureRecord extends CaptureInput {
  id: string;
  filed_at: string;
  /** Destination shorthand — `local` for v0.4, will be `github`/`linear` for v0.6+. */
  destination: 'local';
}

export interface CaptureFileResult {
  id: string;
  destination: 'local';
  file: string;
}

export interface CaptureWriterDeps {
  /** Path of `~/.stavr/captures` — override-able for tests. */
  capturesDir?: string;
  /** Test seam for time. */
  now?: () => Date;
  /** Test seam for id. */
  randomId?: () => string;
}

export function defaultCapturesDir(): string {
  return join(homedir(), '.stavr', 'captures');
}

export function fileCapture(input: CaptureInput, deps: CaptureWriterDeps = {}): CaptureFileResult {
  if (!input.comment || input.comment.trim().length === 0) {
    throw new Error('capture: comment is required');
  }
  if (!isCaptureType(input.type)) {
    throw new Error(`capture: type must be one of ${CAPTURE_TYPES.join(', ')}`);
  }
  if (!isCapturePriority(input.priority)) {
    throw new Error(`capture: priority must be one of ${CAPTURE_PRIORITIES.join(', ')}`);
  }
  const now = (deps.now ?? (() => new Date()))();
  const id = (deps.randomId ?? (() => `cap_${randomUUID().slice(0, 12)}`))();
  const dir = deps.capturesDir ?? defaultCapturesDir();
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${input.type}.jsonl`);
  const record: CaptureRecord = {
    ...input,
    id,
    filed_at: now.toISOString(),
    destination: 'local',
  };
  appendFileSync(file, JSON.stringify(record) + '\n', { encoding: 'utf8' });
  return { id, destination: 'local', file };
}
