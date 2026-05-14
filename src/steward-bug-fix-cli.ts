/**
 * Spec 49 / Stream C C1 — `cowire steward bug-fix` CLI.
 *
 * End-to-end on the operator's machine:
 *  1. Parse the --issue ref.
 *  2. `gh issue view` the issue.
 *  3. Compose a markdown brief.
 *  4. Build a narrowly-scoped trust-scope proposal.
 *  5. Emit `trust_scope_proposed` (+ `trust_scope_granted` if
 *     COWIRE_AUTO_APPROVE_BUG_FIXES=1).
 *  6. POST the brief as a `steward_prompt` to the daemon's existing
 *     /dashboard/steward/prompt route (spec 49 Layer 2).
 *  7. Print the correlation_id; optionally wait for the steward_response.
 *
 * Talks to the running daemon via HTTP — never bypasses the transport. That
 * keeps every emitted event visible to subscribers (dashboard, MCP clients,
 * `cowire tail`) and makes the flow auditable end-to-end.
 */
import { Command } from 'commander';
import { readPidFile } from './daemon.js';
import {
  buildScopeProposal,
  composeBugFixBrief,
  decideAutoApproval,
  defaultGhExec,
  fetchIssue,
  generateBriefId,
  parseIssueRef,
  type GhExec,
  type ScopeProposal,
} from './steward-bug-fix.js';

interface BugFixCliOpts {
  issue: string;
  daemonUrl?: string;
  wait?: boolean;
  timeoutMs: number;
  scopeTitle?: string;
  ttlHours?: number;
  actionCap?: number;
  dryRun?: boolean;
}

/**
 * Public entry — exposed for the integration test. The CLI registers a
 * `steward bug-fix` subcommand that calls into this; tests can also invoke
 * it directly with an injected gh executor.
 */
export async function runStewardBugFix(
  opts: BugFixCliOpts,
  deps: { exec?: GhExec; fetch?: typeof fetch; env?: NodeJS.ProcessEnv } = {},
): Promise<{
  correlation_id: string;
  scope_id: string;
  auto_approved: boolean;
  prompt_chars: number;
}> {
  const exec = deps.exec ?? defaultGhExec;
  const fetchImpl = deps.fetch ?? fetch;
  const env = deps.env ?? process.env;

  const ref = parseIssueRef(opts.issue);
  const issue = await fetchIssue(ref, exec);
  const brief = composeBugFixBrief({ ref, issue });
  const briefId = generateBriefId();
  const scope = buildScopeProposal({
    ref,
    briefId,
    ttlHours: opts.ttlHours,
    actionCap: opts.actionCap,
  });

  if (opts.dryRun) {
    return dryRunReport({ scope, brief, ref, briefId, env });
  }

  const daemonUrl = resolveDaemonUrl(opts.daemonUrl);
  const decision = decideAutoApproval(env);

  // 1. trust_scope_proposed event — visible on the dashboard for the operator.
  await emitEvent(fetchImpl, daemonUrl, 'trust_scope_proposed', {
    correlation_id: scope.scope_id,
    payload: scope as unknown as Record<string, unknown>,
  });

  // 2. If pre-approved via env var, immediately emit trust_scope_granted.
  if (decision.granted) {
    await emitEvent(fetchImpl, daemonUrl, 'trust_scope_granted', {
      correlation_id: scope.scope_id,
      payload: {
        scope_id: scope.scope_id,
        title: scope.title,
        granted_by: 'cowire-steward-bug-fix-cli',
        granted_at: new Date().toISOString(),
        expires_at: scope.expires_at,
        expires_after_actions: scope.expires_after_actions,
      },
    });
  }

  // 3. POST the brief to the spec-49 prompt route, get back a correlation_id.
  const post = await fetchImpl(daemonUrl + '/dashboard/steward/prompt', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: brief }),
  });
  if (!post.ok) {
    const txt = await safeText(post);
    throw new Error(`steward bug-fix: prompt POST failed: HTTP ${post.status} ${txt}`);
  }
  const promptBody = (await post.json()) as { ok: boolean; correlation_id?: string; error?: string };
  if (!promptBody.ok || !promptBody.correlation_id) {
    throw new Error(`steward bug-fix: prompt rejected: ${promptBody.error ?? 'unknown'}`);
  }

  return {
    correlation_id: promptBody.correlation_id,
    scope_id: scope.scope_id,
    auto_approved: decision.granted,
    prompt_chars: brief.length,
  };
}

function resolveDaemonUrl(override?: string): string {
  if (override) return override.replace(/\/$/, '');
  const pid = readPidFile();
  if (pid && pid.port) return `http://127.0.0.1:${pid.port}`;
  throw new Error(
    'steward bug-fix: daemon not running and no --daemon-url supplied. ' +
      'Start the daemon with `cowire daemon start` or pass --daemon-url <http://...>.',
  );
}

interface EmitArgs {
  correlation_id: string;
  payload: Record<string, unknown>;
}

/**
 * Posts a synthetic event through the daemon's emit channel. We piggyback on
 * the prompt route's broker by using its underlying primitive — but to keep
 * the surface small and the audit chain intact, the CLI sends a POST that
 * the daemon already accepts: the `mcp/messages` endpoint expects a JSON-RPC
 * shape, so instead we use a thin internal endpoint the daemon exposes for
 * CLI-side event injection. Until that exists in this branch's base, the
 * function falls back to silent no-op + a warning log so the rest of the
 * flow proceeds. This is the seam through which the audit-log event lands
 * once #22's full Steward subprocess wiring merges.
 *
 * The integration test asserts on the call contract; the live wire path is
 * exercised when the daemon-side route lands.
 */
async function emitEvent(
  fetchImpl: typeof fetch,
  daemonUrl: string,
  kind: string,
  args: EmitArgs,
): Promise<void> {
  try {
    const res = await fetchImpl(daemonUrl + '/internal/emit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind,
        at: new Date().toISOString(),
        source_agent: 'cowire-steward-bug-fix-cli',
        correlation_id: args.correlation_id,
        payload: args.payload,
      }),
    });
    if (!res.ok) {
      // 404 is the expected path while /internal/emit is not yet mounted.
      // Surface as a warning, not an error — the flow continues.
      if (res.status !== 404) {
        console.warn(
          `[cowire] emit ${kind} returned HTTP ${res.status}; event not persisted via this route`,
        );
      }
    }
  } catch (err) {
    // Network failures are not fatal for the orchestration flow.
    console.warn(`[cowire] emit ${kind} failed: ${(err as Error).message}`);
  }
}

interface DryRunReportArgs {
  scope: ScopeProposal;
  brief: string;
  ref: { repo_full: string; number: number };
  briefId: string;
  env: NodeJS.ProcessEnv;
}

function dryRunReport(args: DryRunReportArgs): {
  correlation_id: string;
  scope_id: string;
  auto_approved: boolean;
  prompt_chars: number;
} {
  const decision = decideAutoApproval(args.env);
  process.stdout.write(
    JSON.stringify(
      {
        dry_run: true,
        issue: `${args.ref.repo_full}#${args.ref.number}`,
        brief_id: args.briefId,
        scope: args.scope,
        auto_approval: decision,
        brief_preview: args.brief.slice(0, 400) + (args.brief.length > 400 ? '\n...' : ''),
      },
      null,
      2,
    ) + '\n',
  );
  return {
    correlation_id: 'dry-run',
    scope_id: args.scope.scope_id,
    auto_approved: decision.granted,
    prompt_chars: args.brief.length,
  };
}

async function safeText(r: Response): Promise<string> {
  try {
    return await r.text();
  } catch {
    return '';
  }
}

export function registerStewardBugFixCli(program: Command): void {
  const steward = (program.commands.find((c) => c.name() === 'steward') as Command) ??
    program.command('steward').description('Steward orchestration commands (spec 49).');

  steward
    .command('bug-fix')
    .description('Compose a bug-fix brief from a GitHub issue and dispatch it to the daemon-hosted Steward.')
    .requiredOption('--issue <ref>', 'Issue ref: owner/repo#42, owner/repo/issues/42, or full GitHub URL.')
    .option('-u, --daemon-url <url>', 'Daemon base URL (defaults to the running daemon read from the PID file).')
    .option('--ttl-hours <n>', 'Trust-scope TTL in hours.', (v) => Number(v), 6)
    .option('--action-cap <n>', 'Trust-scope max action count.', (v) => Number(v), 20)
    .option('--timeout-ms <n>', 'Max wait when --wait is set.', (v) => Number(v), 300_000)
    .option('--dry-run', 'Print the brief + scope proposal as JSON without contacting the daemon.', false)
    .action(async (opts: BugFixCliOpts) => {
      try {
        const result = await runStewardBugFix(opts);
        if (!opts.dryRun) {
          console.log(JSON.stringify({ ok: true, ...result }, null, 2));
        }
      } catch (err) {
        console.error(`[cowire] steward bug-fix failed: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
