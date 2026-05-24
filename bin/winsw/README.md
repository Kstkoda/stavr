# WinSW binary placement — operator step

stavR's Windows Service supervision uses [WinSW](https://github.com/winsw/winsw)
(the Windows Service Wrapper). WinSW is a single .NET 4.6.1+ executable that
turns any program into a Windows Service.

We do **not** commit binary blobs to the stavR repository. The operator
places the WinSW exe at `bin/winsw/StavrDaemon.exe` once, then the install
script (`bin/install-windows-service.ps1`) renders the matching XML config
alongside it.

## Pinned version

| Field | Value |
|---|---|
| WinSW version | **v2.12.0** |
| Filename | `WinSW-x64.exe` (rename to `StavrDaemon.exe` when placing) |
| Upstream URL | https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe |
| SHA256 | `05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da` |

> **Verify the SHA256 before placing.** If the hash you compute does not
> match the one above, do NOT place the binary — open an issue. The hash
> above is pinned at the time of the BOM; future operators may update it
> in this README when they audit a newer WinSW release.

## Placement (operator steps)

Run from an elevated PowerShell at the stavR repo root:

```powershell
# 1. Download the pinned WinSW release.
Invoke-WebRequest `
    -Uri 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe' `
    -OutFile $env:TEMP\WinSW-x64.exe

# 2. Verify the SHA256 against the pinned value above.
$expected = '05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da'
$actual   = (Get-FileHash $env:TEMP\WinSW-x64.exe -Algorithm SHA256).Hash.ToLower()
if ($actual -ne $expected) {
    Write-Error "SHA256 mismatch! expected=$expected actual=$actual"
} else {
    Write-Host "[OK] SHA256 matches."
}

# 3. Place the binary at bin\winsw\StavrDaemon.exe.
#    Renaming is required — WinSW reads the XML config from a sibling
#    file with the SAME basename as the exe.
Copy-Item -LiteralPath $env:TEMP\WinSW-x64.exe `
          -Destination .\bin\winsw\StavrDaemon.exe -Force

# 4. Render the XML config + print operator install steps.
.\bin\install-windows-service.ps1

# 5. Register + start the service (per the install script's output).
.\bin\winsw\StavrDaemon.exe install
.\bin\winsw\StavrDaemon.exe start
```

## Why not bundle the binary in the repo?

Three reasons:

1. **Supply-chain integrity.** The SHA256 pin above means the operator
   can audit the WinSW binary before it touches their machine, and the
   stavR repo carries no third-party binary content.
2. **Repo size.** Even a ~2 MB exe in git history grows pack sizes
   unnecessarily.
3. **WinSW updates.** When upstream WinSW releases a new version with a
   security fix, the operator updates the SHA256 in this README and
   replaces the binary — no stavR release cycle needed.

The `.gitkeep` in this directory exists so `bin/winsw/` is part of the
repo even before the operator places the binary.

## Manual fallback (no WinSW)

If the operator can't or won't use WinSW, alternative paths:

- **NSSM** (Non-Sucking Service Manager) — same idea as WinSW, different
  config format. Not supported by `bin/install-windows-service.ps1`;
  operator would configure NSSM manually with the same node arguments
  the XML template uses.
- **Task Scheduler** — boot-start via `schtasks /SC ONSTART`. Available
  but lacks WinSW's structured crash-loop guard.
- **Native sc.exe + a service-account password** — Windows Service Control
  Manager can register a script directly, but escalating-failure delays
  are clunky to configure via `sc.exe failure`.

The supported path is WinSW. The alternatives are operator-DIY.
