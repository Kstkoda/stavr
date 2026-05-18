# Worker spawn — operator notes

> **v0.6.7** — the shell-worker spawn path now writes each command to a
> per-worker script file on disk and invokes via `-File <path>` instead of
> `-Command "..."`. This page covers the operator-visible side: where
> scripts land, how to audit them, and the gotchas you'll hit if you try
> to pace workers from inside their own command.

## Where worker scripts live

```
${STAVR_HOME}/worker-scripts/<worker-id>.<ext>
```

Default `STAVR_HOME` is `~/.stavr`. Extensions: `.ps1` (powershell),
`.cmd` (cmd), `.sh` (bash). Files are written with `0o700` permissions
(owner read/write/exec only); NTFS ACLs default to user-only on Windows.

Each script starts with an audit header listing the worker id, creation
timestamp, and shell. The header marks the file `DO NOT EDIT — operator-
visible audit of what stavR executed`. You're free to read it, `grep` it,
or `tail` it; just don't modify it (the worker has likely already
executed by the time you'd be reading).

Cleanup: scripts older than `STAVR_WORKER_SCRIPT_RETENTION_DAYS` days
(default `7`) are eligible for removal. Cleanup runs from a daily cron
(ADR-037 backup job integration) — not from inside the daemon hot path,
so a misbehaving cleanup can't take the worker spawn surface down.

## The -File pattern (and why)

Old:
```powershell
powershell.exe -NoLogo -NonInteractive -Command "<command body…>"
```

New (v0.6.7):
```powershell
powershell.exe -NoLogo -NonInteractive -NoProfile `
  -ExecutionPolicy Bypass `
  -File C:\Users\you\.stavr\worker-scripts\<id>.ps1
```

Windows Defender and most third-party AV products flag the
"PowerShell + -Command + long argv" pattern as a malware signature.
Writing the same body to a real `.ps1` file and invoking via `-File`
bypasses that heuristic without changing what's executed. Same goes for
`cmd /c "<long body>"` → `cmd /c <path>`.

`-NoProfile` is new in v0.6.7 too: the operator's PowerShell profile
might import modules that fail and tank the worker. Cold-starting without
the profile is faster (~300 ms saved) and more deterministic.

## Sleep / pacing — use the params, not `timeout`

**Footgun:** `timeout /t N /nobreak` does NOT sleep in headless mode on
Windows. Verified by the 2026-05-17 stress test: 8 `cmd` workers using
`timeout` all reported done in <1 s instead of the intended 5–60 s.

**Fix:** use the spawn API's `sleepBefore` / `sleepAfter` params. The
script writer translates to the right primitive per shell:

| Shell | Primitive used |
|---|---|
| PowerShell | `Start-Sleep -Seconds N` |
| cmd | `ping 127.0.0.1 -n N+1 >nul` (works headless; sleeps ~N seconds) |
| bash | `sleep N` |

```json
{
  "shell": "cmd",
  "command": "echo hi",
  "sleepBefore": 5,
  "sleepAfter": 30
}
```

→ produces a `.cmd` file that pings for 6 packets, runs the command, then
pings for 31 packets. Effective ~5 s before, ~30 s after.

Bounds: `sleepBefore` and `sleepAfter` are each capped at `3600` seconds
(1 hour). Negative or zero render to a no-op (the line is omitted from
the script entirely).

## Auditing what stavR ran

To see what a worker executed:

```bash
# POSIX
cat ~/.stavr/worker-scripts/<worker-id>.sh
```

```powershell
# Windows
Get-Content $env:USERPROFILE\.stavr\worker-scripts\<worker-id>.ps1
```

The dashboard's worker detail page (post-v0.6.6) surfaces a "View script"
link that opens this file in the OS default text-file handler. For older
scripts already cleaned up by retention, the original command is still
on the worker's `metadata.command` field (the dashboard preserves it
alongside the script_path link).

## AV blocked a worker

When Windows Defender or a third-party AV blocks a spawn (the binary or
the script is quarantined mid-launch), v0.6.7 P3 (forthcoming) will emit
a `worker_blocked_by_av` event with:

- `worker_id`
- `av_product_name`
- `av_event_id` + truncated event message
- the path to the script that was blocked

For now (v0.6.7 P1 + P2 baseline), AV-blocked spawns surface as
`worker_failed` with a generic spawn-denied reason. To diagnose, check:

1. The script file under `~/.stavr/worker-scripts/<id>.<ext>` — did it
   get written? If yes, the AV blocked the *invocation*, not the *write*.
2. Windows Event Viewer → Microsoft → Windows → Windows Defender →
   Operational. Filter for events 1116 (real-time detection) / 1117
   (action taken) in the last 5 minutes.
3. Your third-party AV's quarantine log (Symantec, CrowdStrike,
   SentinelOne, Sophos all expose this somewhere).

If the script body itself is the trigger (rare — usually it's a binary
inside the command), v0.6.7 P4 (Ed25519 script signing) gives you a
whitelist-friendly hook.

## What changed for worker authors

If you're writing a new worker spawner, you don't need to touch any of
this — `createShellSpawner()` handles the script-file pattern internally.
The only public-facing change is:

- `ShellSpawnParams.sleepBefore?: number` (P2)
- `ShellSpawnParams.sleepAfter?: number` (P2)
- `WorkerInstance.metadata.script_path: string` — link to the on-disk
  script, surfaced by the dashboard

If you're integrating from outside the worker subsystem (e.g. an MCP
tool that triggers a worker), just pass `sleepBefore` / `sleepAfter`
through and stop using `timeout` on Windows.

## What we deliberately did NOT change

- **The interactive spawn path** still uses `cmd /c start ...` and
  `powershell -NoExit -Command`. Interactive workers open a visible
  window the operator types into; there's no AV-block risk because the
  operator's keystrokes ARE the input. Script-file pattern would just
  add friction.
- **The script body itself** is preserved verbatim. We don't try to
  rewrite operator commands. `$env:VAR` references still resolve at
  worker-runtime; no inlining of operator env values.

## Related

- [ADR-037 — local backup + retention](../adr/037-local-backup-retention.md)
- BOM `proposed/v0_6_7-worker-spawn-hygiene-bom.md`
- v0.6.6 worker fidelity: `lifecycle_state killed-by-system` will (P3)
  distinguish AV-killed workers from generic crashes.

