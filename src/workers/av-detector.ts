// v0.6.7 P3 — AV / EDR block detection.
//
// When a worker spawn returns EPERM or similar (and the script DID land
// on disk — verified by the caller), the cause is almost always an
// antivirus product blocking the invocation. This module's job is to ask
// the OS event log "did Defender / CrowdStrike / SentinelOne / Sophos
// just kill a process for me?" and return enough attribution that the
// notify-fabric can tell the operator EXACTLY who to whitelist.
//
// Cross-platform shape:
//   - On Windows, queries the Windows Event Log via `wevtutil qe ... /f:text`
//     against the relevant channels.
//   - On non-Windows, the detector returns null (no event-log query is
//     attempted) — Linux/macOS AV is rare in the operator's setup and
//     the few products that do run there don't expose a standardised
//     event log we can introspect.
//
// The module is pure: it takes a command shape, a clock, and a transport.
// Tests inject all three. Production wires the real `execFile` + Date.now
// + the resolved platform.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Defender event channel + the IDs that indicate a block. */
export const DEFENDER_CHANNEL = 'Microsoft-Windows-Windows Defender/Operational';

/** Defender event IDs that signal a real-time block or quarantine. */
export const DEFENDER_BLOCK_EVENT_IDS = [1116, 1117, 5007] as const;

/** Display name + event channel for each third-party AV the detector
 *  recognises. Order matters — first match wins. Configurable via
 *  STAVR_AV_EXTRA_CHANNELS env (semicolon-separated `Vendor|Channel` pairs). */
export const KNOWN_THIRD_PARTY_AVS = [
  { name: 'CrowdStrike Falcon', channel: 'CrowdStrike-Falcon-Sensor/Operational' },
  { name: 'SentinelOne', channel: 'SentinelOne/Operational' },
  { name: 'Symantec', channel: 'Symantec Endpoint Protection Client/Operational' },
  { name: 'Sophos', channel: 'Sophos Endpoint/Operational' },
] as const;

/** Result of a successful AV-block match. */
export interface AvBlockResult {
  av_product_name: string;
  av_event_id?: number;
  av_event_message?: string;
}

/** Wait this long after the spawn failure before querying — gives the AV
 *  time to actually write its event. */
export const POST_SPAWN_WAIT_MS = 500;

/** Per-channel event-log query window in seconds. Anything older than
 *  this didn't kill the just-attempted spawn. */
export const QUERY_WINDOW_SECONDS = 5;

export interface DetectInput {
  /** Path the spawn tried to invoke (script path or executable). Used
   *  to disambiguate the AV's event from unrelated activity. */
  spawnedPath: string;
  /** Optional override of the channels to query (test-friendly). */
  channels?: ReadonlyArray<{ name: string; channel: string }>;
  /** Test-injected transport for wevtutil. Production uses execFileAsync. */
  transport?: WevtutilTransport;
  /** Test-injected clock. */
  now?: () => number;
  /** Test-injected sleep — production uses setTimeout. */
  sleepMs?: (ms: number) => Promise<void>;
  /** Override the platform check (test-only). */
  platformOverride?: NodeJS.Platform;
}

export type WevtutilTransport = (
  channel: string,
  windowSeconds: number,
) => Promise<string>;

/**
 * Try to attribute a spawn failure to an AV / EDR block. Returns the
 * matching product + (when available) the AV's event id and a truncated
 * message; returns null when no match is found (caller should fall back
 * to a generic `worker_dispatch_failed`).
 *
 * Cross-platform: returns null on non-Windows platforms unconditionally.
 */
export async function detectAvBlock(input: DetectInput): Promise<AvBlockResult | null> {
  const platform = input.platformOverride ?? process.platform;
  if (platform !== 'win32') return null;

  const sleep = input.sleepMs ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  await sleep(POST_SPAWN_WAIT_MS);

  const transport = input.transport ?? defaultTransport;
  const channels: Array<{ name: string; channel: string }> = [
    { name: 'Windows Defender', channel: DEFENDER_CHANNEL },
    ...KNOWN_THIRD_PARTY_AVS,
    ...parseExtraChannels(process.env.STAVR_AV_EXTRA_CHANNELS),
  ];
  const overrideChannels = input.channels;
  const list: ReadonlyArray<{ name: string; channel: string }> = overrideChannels ?? channels;

  for (const { name, channel } of list) {
    let output: string;
    try {
      output = await transport(channel, QUERY_WINDOW_SECONDS);
    } catch {
      // Channel doesn't exist on this machine (third-party AV not
      // installed), or wevtutil errored. Either way, skip cleanly.
      continue;
    }
    const match = matchAvEvent(output, input.spawnedPath);
    if (match) {
      return { av_product_name: name, ...match };
    }
  }

  return null;
}

/** Parse an env-supplied semicolon-separated channel-list like
 *  `Vendor1|Channel1;Vendor2|Channel2`. Empty / malformed entries silently
 *  drop — never crashes on bad env.   */
export function parseExtraChannels(raw: string | undefined): Array<{ name: string; channel: string }> {
  if (!raw) return [];
  return raw
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const sep = entry.indexOf('|');
      if (sep === -1) return null;
      const name = entry.slice(0, sep).trim();
      const channel = entry.slice(sep + 1).trim();
      if (!name || !channel) return null;
      return { name, channel };
    })
    .filter((x): x is { name: string; channel: string } => !!x);
}

/**
 * Try to extract event id + message from a wevtutil text-format chunk.
 * Looks for the `Event ID:` line and the `Description:` or message
 * block, and verifies the spawned path appears anywhere in the chunk
 * (so we don't falsely attribute unrelated Defender activity).
 *
 * The wevtutil text format is line-oriented and stable across Windows
 * versions; parsing by regex is acceptable here. We deliberately do NOT
 * use the XML format (`/f:xml`) because the channels we query don't
 * always populate the XML payload uniformly.
 */
export function matchAvEvent(output: string, spawnedPath: string): {
  av_event_id?: number;
  av_event_message?: string;
} | null {
  if (!output.includes(spawnedPath)) {
    // The spawned path appearing in the event is what proves the event
    // is about us, not about some other process. Without it we can't
    // attribute confidently and we'd rather under-detect than emit a
    // false `worker_blocked_by_av`.
    return null;
  }
  const idMatch = output.match(/Event ID:\s*(\d+)/i);
  const av_event_id = idMatch ? Number.parseInt(idMatch[1], 10) : undefined;

  // Pull the first "Description" or "Message" body — wevtutil prints
  // them as a header followed by indented text. We take everything from
  // the header until the next blank line or end-of-output, then trim.
  const descMatch = output.match(/(?:Description|Message):\s*([\s\S]*?)(?:\n\s*\n|$)/i);
  let av_event_message: string | undefined = descMatch
    ? descMatch[1].trim().replace(/\s+/g, ' ')
    : undefined;
  if (av_event_message && av_event_message.length > 240) {
    av_event_message = av_event_message.slice(0, 237) + '…';
  }

  return { av_event_id, av_event_message };
}

/**
 * Default wevtutil transport — calls `wevtutil qe <channel> /q:<xpath>
 * /f:text /c:5`. The XPath query is keyed by `*[System[TimeCreated[
 * timediff(@SystemTime) <= <ms>]]]` so only events from the recent
 * window are returned.
 *
 * Errors propagate via the rejected promise so the caller can `try/catch`
 * the absence of a channel (a non-installed third-party AV) the same way
 * it handles other transport failures.
 */
async function defaultTransport(channel: string, windowSeconds: number): Promise<string> {
  const ms = windowSeconds * 1000;
  // Defender + most third-party channels use the standard System metadata
  // schema for TimeCreated; timediff(@SystemTime) returns milliseconds
  // since the event time. Limit to 5 records to keep stdout bounded.
  const xpath = `*[System[TimeCreated[timediff(@SystemTime) <= ${ms}]]]`;
  const { stdout } = await execFileAsync(
    'wevtutil.exe',
    ['qe', channel, `/q:${xpath}`, '/f:text', '/c:5'],
    { maxBuffer: 1_000_000, windowsHide: true },
  );
  return stdout;
}
