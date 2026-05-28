/**
 * Deprecation log helper for the Phase 3b worker_* → job_* tool rename.
 *
 * Bilateral pattern with the Phase 3a env-var rename: every call to a
 * legacy worker_* MCP tool emits a single console.warn line naming the
 * replacement and citing the shared `DEPRECATION_WINDOW_RELEASES`
 * constant from src/event-types.ts. One line per call — enough for the
 * operator's stderr / daemon log to surface stale callers, not so many
 * lines that the log becomes noise.
 *
 * Pure module-level — no state, no rate-limiting. Daemon-level
 * log scrapers (Telegram, dashboard tail) can grep for `[deprecated]` to
 * surface migration progress.
 *
 * Why console.warn and not the structured logger: the MCP tool registration
 * sites in src/workers/tools.ts don't have a logger handle in scope, and
 * threading one through every handler would muddy the diff. Daemon stderr
 * catches it.
 */
import { DEPRECATION_WINDOW_RELEASES } from '../event-types.js';
import { WORKER_TO_JOB_TOOL_ID_ALIAS } from '../tools/categories.js';

/**
 * Emit the deprecation log line for a legacy worker_* tool call.
 *
 * The replacement is looked up from `WORKER_TO_JOB_TOOL_ID_ALIAS` — the
 * single parity table that also drives security tier classification, so
 * the deprecation message can't drift out of sync with what the runtime
 * gate is actually checking.
 *
 * No-op for tool IDs not in the alias table (defence: a misclassified
 * caller shouldn't get a phantom "use undefined instead" message).
 */
export function logToolDeprecation(legacyToolId: string): void {
  const replacement = WORKER_TO_JOB_TOOL_ID_ALIAS[legacyToolId];
  if (!replacement) return;
  console.warn(
    `[stavr] [deprecated] MCP tool '${legacyToolId}' is deprecated; use '${replacement}' instead. Scheduled for removal in ${DEPRECATION_WINDOW_RELEASES} release. See proposed/worker-dispatch-bom.md Phase 3.`,
  );
}
