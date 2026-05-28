# Worker-script writer — operator notes

> **worker-dispatch Phase 3c.2 note:** the bespoke worker subsystem is
> retired (jobs are the substrate now — see [`writing-a-job-binding.md`](./writing-a-job-binding.md)),
> but the script-writer helper that this page documents survives intact
> and lives at `src/jobs/script-writer.ts`. Env-var names
> (`STAVR_WORKER_SCRIPT_DIR`, `STAVR_WORKER_SCRIPT_RETENTION_DAYS`) and
> on-disk paths (`${STAVR_HOME}/worker-scripts/`) keep the "worker"
> spelling deliberately — they're an operator surface; silently
> renaming them would break existing `.env` files and AV whitelist paths.

> **v0.6.7** — the shell-flavored process-spawn binding path writes each
> command to a per-job script file on disk, invokes via `-File <path>`
> instead of `-Command "..."`, and signs every script with an Ed25519
> sidecar that the script-writer re-verifies before the child process
> starts. This page covers the operator-visible side: where scripts land,
> how to audit them, how integrity is enforced, and the per-AV whitelist
> recipes you need if your endpoint protection keeps killing the spawn.

## Where worker scripts live

```
${STAVR_HOME}/worker-scripts/<worker-id>.<ext>
```

Default `STAVR_HOME` is `~/.stavr`. Extensions: `.ps1` (powershell),
`.cmd` (cmd), `.sh` (bash). Files are written with `0o700` permissions
(owner read/write/exec only); NTFS ACLs default to user-only on Windows.

### Overriding the script directory — `STAVR_WORKER_SCRIPT_DIR`

Some AV / EDR products are easier to configure with a path-based
exclusion than an arbitrary `${STAVR_HOME}` subtree. To redirect just
the worker-scripts target without relocating the whole STAVR_HOME, set
the env var before the daemon starts:

```powershell
# Windows — point worker scripts at an EDR-excluded folder.
# Edit bin\winsw\StavrDaemon.xml to add the env entry, then:
.\bin\winsw\StavrDaemon.exe stop
.\bin\winsw\StavrDaemon.exe start
```

```bash
# Linux — edit ~/.config/systemd/user/stavr.service to add the
# Environment=STAVR_WORKER_SCRIPT_DIR=/srv/stavr/trusted-scripts line, then:
systemctl --user daemon-reload
systemctl --user restart stavr.service
```

```bash
# macOS — edit ~/Library/LaunchAgents/com.stavr.daemon.plist to add
# the EnvironmentVariables entry, then:
launchctl bootout   gui/$(id -u) ~/Library/LaunchAgents/com.stavr.daemon.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.stavr.daemon.plist
```

> Legacy PM2 install (deprecated): `$env:STAVR_WORKER_SCRIPT_DIR=... ; pm2 restart stavr --update-env`

stavR creates the directory with `0o700` permissions on first use. The
signing-key file (`spawn-signing.key`) stays under `${STAVR_HOME}/keys/`
regardless — only the script-write target moves.

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

## Script signing — Ed25519 sidecars (v0.6.7 P4)

Every script written by `writeWorkerScript` gets a sibling sidecar:

```
${STAVR_HOME}/worker-scripts/<worker-id>.<ext>          # the script
${STAVR_HOME}/worker-scripts/<worker-id>.<ext>.sig      # the signature
```

The sidecar is a small JSON document:

```json
{
  "alg": "ed25519",
  "script_path": "C:\\Users\\you\\.stavr\\worker-scripts\\<id>.ps1",
  "script_sha256": "<64 hex chars>",
  "worker_id": "<uuid>",
  "created_at": "2026-05-19T05:00:00.000Z",
  "signature": "<base64>",
  "pubkey_fingerprint": "<16 hex chars>"
}
```

The signature is computed over the canonical message
`${script_path}|${sha256(body)}|${worker_id}|${created_at}` using an
Ed25519 keypair stored at `${STAVR_HOME}/keys/spawn-signing.key`
(`0o600` on Unix; NTFS user-only ACL on Windows). The key is generated
lazily on first script write — there is nothing to set up by hand.

**This is stavR's own integrity guarantee, not your operator identity.**
The sidecar proves "stavR's spawner wrote this script, and the bytes on
disk now are the bytes it intended to write." It does NOT bind to your
operator key (that's reserved for event-log signing per ADR-036).

Before invoking any child process, the shell spawner re-verifies the
sidecar against the script body, the recorded worker id, and the
in-process key. If the body has been tampered with, the sidecar was
deleted, or the key has rotated since signing, the spawn is rejected
and the daemon emits a `worker_blocked_by_signature` event carrying the
exact failure mode:

| `reason` | Meaning |
|---|---|
| `sidecar_missing` | No `.sig` file next to the script |
| `sidecar_unreadable` / `sidecar_malformed` | `.sig` exists but I/O or JSON failed |
| `script_hash_mismatch` | Script body was modified after signing |
| `worker_id_mismatch` | Sidecar names a different worker than the spawn is intending to run |
| `path_mismatch` | Sidecar's recorded `script_path` differs from the actual file location |
| `unsupported_alg` | Sidecar `alg` is not `ed25519` |
| `pubkey_mismatch` | Sidecar was signed by a different key than the verifier holds |
| `signature_invalid` | Cryptographic verify call returned false |

The Governor escalates `worker_blocked_by_signature` to a crit-severity
desktop notification with a "View worker" deep-link so you can
investigate immediately. If you see one of these and you haven't
manually edited the script directory, treat it as a real tamper signal.

### Rotating the signing key

Two reasons to rotate: you migrated `${STAVR_HOME}` across machines and
want a fresh identity, or you suspect the key file leaked.

```powershell
# Windows
.\bin\winsw\StavrDaemon.exe stop
Remove-Item $env:USERPROFILE\.stavr\keys\spawn-signing.key
Remove-Item $env:USERPROFILE\.stavr\worker-scripts\* -Force   # drop stale sidecars
.\bin\winsw\StavrDaemon.exe start
```

```bash
# Linux (systemd --user)
systemctl --user stop stavr.service
rm ~/.stavr/keys/spawn-signing.key
rm -f ~/.stavr/worker-scripts/*
systemctl --user start stavr.service
```

```bash
# macOS (launchd)
launchctl kill SIGTERM gui/$(id -u)/com.stavr.daemon
rm ~/.stavr/keys/spawn-signing.key
rm -f ~/.stavr/worker-scripts/*
launchctl kickstart gui/$(id -u)/com.stavr.daemon
```

> Legacy PM2 install (deprecated): `pm2 stop stavr && rm ... && pm2 start stavr`

The next worker spawn regenerates the key on disk. Old sidecars sign
against the prior key and would fail with `pubkey_mismatch`; removing
them prevents spurious blocks during the rotation window.

## AV blocked a worker

When Windows Defender or a third-party AV blocks a spawn (the binary or
the script is quarantined mid-launch), v0.6.7 P3 emits a
`worker_blocked_by_av` event with:

- `worker_id`
- `av_product_name`
- `av_event_id` + truncated event message
- the path to the script that was blocked

If the AV-block event doesn't fire, the spawn surfaces as
`worker_failed` with a generic spawn-denied reason. To diagnose:

1. The script file under `~/.stavr/worker-scripts/<id>.<ext>` — did it
   get written? If yes, the AV blocked the *invocation*, not the *write*.
2. Windows Event Viewer → Microsoft → Windows → Windows Defender →
   Operational. Filter for events 1116 (real-time detection) / 1117
   (action taken) in the last 5 minutes.
3. Your third-party AV's quarantine log (Defender, Symantec, CrowdStrike,
   SentinelOne, Sophos, Norton, McAfee, Avast, Kaspersky, and ClamAV all
   expose this somewhere — recipes in the next section).

### Per-AV whitelist recipes

Add an exclusion for the worker-scripts directory (or for the path you
set with `STAVR_WORKER_SCRIPT_DIR`). All commands assume the default
`%USERPROFILE%\.stavr\worker-scripts\` on Windows or `~/.stavr/worker-scripts/`
on Unix; substitute your override path if you set one.

> **Run these from an elevated / root shell.** They modify policy state
> the daemon process itself cannot touch — and per Lex Insculpta the
> operator is the only party with the authority to do so anyway.

#### Microsoft Defender (Windows)

```powershell
# Path exclusion — Defender will not scan files under this folder.
Add-MpPreference -ExclusionPath "$env:USERPROFILE\.stavr\worker-scripts"

# Optional: also exclude the PowerShell + cmd interpreters when invoked
# with our specific -File argument. Use with care — overly broad
# exclusions weaken AV coverage.
Add-MpPreference -ExclusionProcess "powershell.exe","cmd.exe"

# Verify
Get-MpPreference | Select-Object ExclusionPath, ExclusionProcess
```

To remove later:

```powershell
Remove-MpPreference -ExclusionPath "$env:USERPROFILE\.stavr\worker-scripts"
```

#### CrowdStrike Falcon (Windows / Linux / macOS)

Falcon exclusions are policy-driven and live in the Falcon console — not
on the endpoint itself. Path: **Endpoint security → Configuration → Prevention policies → [your policy] → Exclusions → ML Exclusions / IOA Exclusions**.

- Add a *Sensor Visibility Exclusion* for the worker-scripts path
  (Windows: `C:\Users\<you>\.stavr\worker-scripts\*`).
- For shell processes that consistently trigger detections, add an *IOA
  Exclusion* keyed on the process command line containing
  `\.stavr\worker-scripts\` — narrower than a process-name exclusion.
- Wait 5–10 minutes for the policy to propagate to the sensor before
  retrying the spawn.

#### SentinelOne (Windows / Linux / macOS)

Console path: **Sentinels → Policies → [your policy] → Exclusions →
Path**.

- Type: **Folder**, scope **Subfolders**.
- Path: `C:\Users\<you>\.stavr\worker-scripts\` (or your `STAVR_WORKER_SCRIPT_DIR`).
- Mode: **Suppress alerts and prevent further detection** (NOT
  "Interoperability" — that one is too narrow for our use case).
- Save and force a policy refresh on the endpoint
  (`sentinelctl policy refresh` from an elevated shell).

#### Sophos Intercept X (Windows / macOS)

- Sophos Central → **Endpoint Protection → Settings → Global Exclusions**.
- Add an exclusion of type **Process**:
  `%USERPROFILE%\.stavr\worker-scripts\*` (Windows) or
  `$HOME/.stavr/worker-scripts/*` (macOS).
- Tick **Detected exploits**, **Real-time scanning - Files**, and
  **Behaviour detection**. Untick **CryptoGuard** unless your worker
  bodies handle archive contents (rare).

#### Symantec Endpoint Protection / Symantec Endpoint Security

```
Symantec Endpoint Protection Manager
  → Policies → Exceptions → Add → Exception → Folder
    Path:  C:\Users\<you>\.stavr\worker-scripts
    Scan type: Auto-Protect, SONAR, Download Protection (all three)
    Subfolders: yes
```

For SES (cloud) the same lives under **Policies → Exceptions →
Add Exception → Folder Exception**.

#### Norton 360 / Norton Security (consumer)

- Norton main UI → **Settings → Antivirus → Scans and Risks** tab.
- Under **Exclusions / Low Risks**, click **Configure** next to *Items
  to Exclude from Scans*.
- Add folder: `C:\Users\<you>\.stavr\worker-scripts\`.
- Also add the same path under *Items to Exclude from Auto-Protect, SONAR
  and Download Intelligence Detection* — Norton's UI splits these into
  two separate lists; you need both.

#### McAfee Total Protection / McAfee Endpoint Security

McAfee Endpoint Security console (or McAfee ePO if you're enterprise):

- **Threat Prevention → On-Access Scan** → click **Show Advanced**.
- Under **Exclusions**, add:
  - File / folder: `%USERPROFILE%\.stavr\worker-scripts\`
  - Subfolders: yes
  - When to exclude: **On read and write**
- For consumer McAfee Total Protection: **PC Security → Real-Time
  Scanning → Excluded Files** → add the same path.

#### Avast / AVG (same engine)

- Avast UI → **Menu → Settings → General → Exceptions → Add Exception**.
- Path: `C:\Users\<you>\.stavr\worker-scripts\*` (the `*` matters — Avast
  treats a bare folder differently from `folder\*`).
- This covers File Shield, Behavior Shield, and Web Shield in one entry.

#### Kaspersky (Endpoint Security for Business / Total Security)

```
Kaspersky main UI → Settings → Additional → Threats and Exclusions
  → Manage exclusions → Add
    File / folder: %USERPROFILE%\.stavr\worker-scripts
    Subfolders: yes
    Components: File Anti-Virus, System Watcher, Web Anti-Virus
    Object name: leave blank (path is enough)
```

#### ClamAV (Linux)

ClamAV's on-access daemon (clamonacc) uses `clamd.conf`:

```
# /etc/clamav/clamd.conf
OnAccessExcludePath /home/<you>/.stavr/worker-scripts
OnAccessExcludeUname <you>          # exclude scans owned by the daemon user
```

```bash
sudo systemctl restart clamav-daemon clamav-clamonacc
```

For one-off on-demand scans, pass `--exclude-dir` to `clamscan`.

### Verifying the exclusion took effect

After adding the exclusion, restart the worker that was failing. Watch
the daemon log:

```bash
# Linux (systemd):  journalctl --user -u stavr.service | grep -E "..."
# macOS (launchd):  tail -F ~/Library/Logs/stavr/stderr.log | grep -E "..."
# Windows (WinSW):  Get-Content -Wait .\logs\StavrDaemon.err.log | Select-String "..."
# Legacy (PM2, deprecated): pm2 logs stavr | grep -E "..."
```

Filter for: `worker_blocked_by_av|worker_dispatch_failed`.

If `worker_blocked_by_av` stops firing for fresh spawns, the exclusion
is doing its job. If it still fires, the AV is matching the *binary the
worker invokes* (e.g. `curl.exe`, `python.exe`) rather than the script
file — exclude the process, not the path, or whitelist by Ed25519
signature once your AV supports custom integrity rules (most don't yet;
this is what the v0.6.7 P4 sidecar is forward-positioned for).

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

