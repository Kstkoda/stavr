/**
 * Plain-language tooltip strings for metric labels (v0.6.12 Phase 6).
 *
 * Centralized so each label has ONE definition. Pages should look up the
 * tooltip via `metricTooltip(label)` rather than hard-coding strings.
 *
 * If a label doesn't have an entry here, `metricTooltip` returns `null` —
 * the caller can decide whether to omit the title attribute or fall back
 * to the label itself.
 */

const TOOLTIPS: Record<string, string> = {
  // Throughput
  qps:    'Queries per second — tool calls happening each second.',
  rps:    'Requests per second — incoming HTTP/MCP requests.',
  rate:   'Events per unit time (default: per minute).',

  // Latency
  p50:    'Median latency — half of requests are faster than this, half slower.',
  p95:    '95th-percentile latency — 95% of requests finished within this time.',
  p99:    '99th-percentile latency — long-tail latency. 1% of requests take this long or longer.',

  // Errors
  err:    'Error rate — percentage of requests that returned a non-success status.',
  errors: 'Error rate — percentage of requests that returned a non-success status.',

  // Process metrics
  rss:           'Resident set size — total RAM used by the daemon process.',
  heap:          'V8 heap currently used by JS objects.',
  heap_used:     'V8 heap currently used by JS objects.',
  external:      'Memory tied to external C++ resources (buffers, native bindings).',
  arrayBuffers:  'Memory used by Buffer + ArrayBuffer instances.',
  array_buffers: 'Memory used by Buffer + ArrayBuffer instances.',
  loop:          'Event-loop lag — how long the event loop is blocked per tick. Lower is better.',
  uptime:        'Time since the daemon process started.',

  // Worker counts
  active:   'Workers currently running or starting.',
  crashed:  'Workers that exited with a crash signature (non-zero exit + abnormal termination).',
  lifetime: 'All workers the daemon has ever seen, including completed and terminated.',
  scopes:   'Active trust scopes — operator-granted capability slices.',

  // Decisions / governance
  AUTO:     'Tier 1 — auto-approved actions. Read-only or low-risk; runs without prompt.',
  CONFIRM:  'Tier 2 — operator confirmation gate. Reversible action; one-click approve.',
  EXPLICIT: 'Tier 3 — explicit friction. Irreversible or sensitive; operator types a confirmation string.',
  NO_GO:    'Tier 4 — operator-only. Daemon refuses; the operator must run the action themselves.',
  'NO-GO':  'Tier 4 — operator-only. Daemon refuses; the operator must run the action themselves.',

  // BOM lifecycle
  BOM:           'Bill of Materials — a structured plan the operator can review, edit, and approve.',
  decision_request: 'A pending question the daemon needs the operator to answer.',
  scope:         'Trust scope — an operator-granted bundle of permissions, time-bounded.',

  // Federation
  peers:    'Federated stavR peers reachable via mDNS or peers.yaml.',
  handshake: 'Peer-to-peer handshake — proves shared trust before any tool call crosses.',
};

export function metricTooltip(label: string): string | null {
  return TOOLTIPS[label] ?? null;
}

/** Convenience: returns a `title="..."` attribute string, or empty if no tip. */
export function metricTooltipAttr(label: string): string {
  const tip = metricTooltip(label);
  if (!tip) return '';
  return ` title="${tip.replace(/"/g, '&quot;')}"`;
}

/** Expose the dictionary for tests + the recon doc. */
export const METRIC_TOOLTIPS: Readonly<Record<string, string>> = TOOLTIPS;
