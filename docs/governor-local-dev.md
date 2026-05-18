# Governor local-dev signing

> Why local dev builds of `stavr-governor` need a signature — and how to
> add one without disabling Smart App Control (SAC) or Gatekeeper.

This is operator-only documentation. **Dev signatures are NOT release
signatures.** Release distribution goes through the Sigstore keyless
pipeline in `.github/workflows/governor-release.yml` (per ADR-038 §2
and BOM v0.6.5.1 P1). Never share a dev-signed binary; the signature
embeds *your* identity, not the project's.

## Why this exists

On 2026-05-17 ~21:00 GST, Windows 11 Smart App Control (SAC) killed the
freshly-compiled `stavr-governor.exe` on first launch. SAC is stricter
than Defender: it blocks **any** unsigned executable without Microsoft
cloud reputation. Once SAC is on, it can only be turned off (which is
irreversible without an OS reinstall) — so the right answer is to
**sign** the binary, not weaken the OS.

Sigstore keyless signing (the release flow) requires GitHub Actions
OIDC. That's not available when you're iterating on `cargo build` on
your own machine. The gap: a one-command path to a locally-signed
binary that runs through your normal dev loop.

## Windows (PowerShell)

```powershell
cd C:\dev\cowire\governor

# 1. Build the binary
cargo build --release

# 2. Sign with a self-issued dev cert (created on first run, reused after)
.\scripts\dev-sign.ps1

# 3. Run it
.\target\release\stavr-governor.exe
```

By default the script:

* Looks for an existing cert in `Cert:\CurrentUser\My` with subject
  `CN=stavR Governor Dev - <user>@<machine>`. Reuses it if found.
* Otherwise creates a self-signed code-signing cert (RSA-3072, 1 year
  validity) and stores it in `CurrentUser\My`.
* Signs the binary with SignTool using the dev cert and a public RFC 3161
  timestamp authority.
* Does NOT install the cert into Trusted Root unless you pass
  `-InstallToTrustedRoot` (and even then, prompts for confirmation per
  BOM open question §3).

### Will SAC accept it?

Maybe. SAC trust is primarily Microsoft cloud reputation; a self-signed
local cert isn't reputation. Your three options for dev:

1. Install the dev cert to Trusted Root on your dev machine. Some SAC
   profiles will then permit binaries signed by that cert; others won't.
   Run `.\scripts\dev-sign.ps1 -InstallToTrustedRoot` and confirm at the
   prompt.
2. Use a Sigstore-signed release binary instead of a `cargo build`
   output. Push a tag, let `governor-release.yml` build + sign, download.
3. As a last resort, develop on a Win11 machine without SAC enabled, or
   on macOS/Linux. (Not great, but documented for completeness.)

### Cleaning up

```powershell
# Remove the dev cert when you're done with this machine
Get-ChildItem Cert:\CurrentUser\My |
  Where-Object { $_.Subject -like "*stavR Governor Dev*" } |
  Remove-Item

# Also remove from Trusted Root if installed
Get-ChildItem Cert:\CurrentUser\Root |
  Where-Object { $_.Subject -like "*stavR Governor Dev*" } |
  Remove-Item
```

## macOS

```bash
cd ~/dev/cowire/governor
cargo build --release
./scripts/dev-sign.sh
./target/release/stavr-governor
```

* If you have a Developer ID Application identity in keychain, the
  script will use it.
* Otherwise it falls back to ad-hoc signing (`codesign --sign -`),
  which is enough for Gatekeeper on a local-only binary you built
  yourself.
* For binaries **downloaded** from the release page, you'll also need:
  `xattr -d com.apple.quarantine /path/to/stavr-governor`
  This is normal macOS quarantine; release notarization (Gatekeeper-
  level trust without `xattr`) is a v0.6.5.2+ concern.

## Linux

```bash
cd ~/dev/cowire/governor
cargo build --release
./scripts/dev-sign.sh
./target/release/stavr-governor
```

* Linux has no SAC/Gatekeeper analogue; unsigned dev builds run fine.
* If you have a GPG signing key, the script emits a detached signature
  (`stavr-governor.gpg.sig`) — useful for sharing with a colleague who
  trusts your GPG key (still NOT a release-quality signature).

## Verifying a release binary (the opposite direction)

When you've downloaded a release artifact (not a dev build), use the
**release verify** helper instead of dev-sign:

```powershell
# Windows
.\scripts\verify-release.ps1 -BinaryPath .\stavr-governor.exe
```

```bash
# macOS/Linux
./scripts/verify-release.sh ./stavr-governor
```

Those wrap `cosign verify-blob` against the public Sigstore Rekor log.
They prove the binary came from this repo's GitHub Actions workflow —
no operator trust state required.

## Footguns

1. **Dev cert subjects collide if you rebuild on a different machine.**
   The subject includes `${USERNAME}@${COMPUTERNAME}`, so each machine
   gets its own cert. Don't try to share a dev cert across machines.
2. **`signtool.exe` requires Windows SDK.** Bundled with VS Build Tools
   — already installed by the Governor MVP setup. If you reinstalled
   Windows, install VS Build Tools first.
3. **Timestamp authority must be reachable.** `dev-sign.ps1` uses
   `http://timestamp.digicert.com`. If you're offline, signing still
   works but the signature has no countersigned timestamp — Windows
   may reject it once the cert expires.
4. **Trusted Root is a global trust gesture.** Be especially careful
   if you share this machine with anyone else; a cert in Trusted Root
   trusts ANYTHING signed with it.
5. **Dev signatures don't satisfy release expectations.** If you ship
   a dev-signed binary to a colleague, their machine has no reason to
   trust your cert. Always link them to a real release.
