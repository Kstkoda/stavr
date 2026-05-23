# Findings — wincred / OS keychain in installed (SEA) mode

**Phase 4 fold-in for `proposed/family-mode-phase-2-bom.md`.**
**Status:** investigation report. No decision taken — this is operator input.
**Date:** 2026-05-23.

---

## TL;DR

The current `wincred`-based OS-keychain path in `src/credentials/vault.ts`
is **already non-functional in production** — even with `wincred@1.0.2`
installed, the adapter falls through to the file fallback (`master.key`
under `~/.stavr/`) and emits `credential_unsafe_storage`. The
standalone SEA install does not make this worse; it just removes a
dead-code branch.

Five concrete paths exist for restoring real OS-keychain storage in
installed mode. They differ on:

- Who owns the secret (daemon vs Tauri Governor).
- Whether the keychain reach extends to macOS / Linux or stays Windows-only.
- How invasive the change is for the daemon code.
- Whether it depends on an external native addon or only on what the
  OS ships with.

The operator picks. This document does not.

---

## Discovery — the current `wincred` path is already broken

`src/credentials/vault.ts` lines 55-95 dynamically import `wincred` and
expect a `{get, set, list}` API. The published `wincred@1.0.2` exposes
**only** `getCredential` (a Python-shell-out wrapper that returns a
`{username, password}` pair).

```
$ npm view wincred@1.0.2
wincred@1.0.2 | MIT | deps: none
size: 6.8 kB unpacked
$ tar -tzf wincred-1.0.2.tgz
package/index.js
package/wincred.py       ← Python script invoked via `exec("python ...")`
package/package.json
```

Reading `package/index.js`:

```js
function getCredential(target, pythonLancher = 'python') {
  const script = `${pythonLancher} ${appRoot}\\wincred.py ${target}`;
  return exec(script)
    .then(result => result.stdout.trim())
    .then(buildCredential);
}
exports.getCredential = getCredential;
```

So the keychain "integration" is actually a Python subprocess wrapper,
not a native module, and the API surface does not match what vault.ts
calls. The check on line 72 (`if (!mod.get || !mod.set) return null;`)
fails immediately — `mod.get` is undefined — and every Windows install
takes the file fallback path. The `credential_unsafe_storage` event has
been firing on every Windows install since this code shipped.

**Implication for Phase 4.** The SEA install is not introducing a
regression; it is making explicit a regression that already existed.
That changes the urgency calculus: this isn't "we broke a feature when
we removed npm install" — it's "the feature was never on; now is a
good time to either build it for real or stop pretending we have it."

The remainder of this doc presents the options as if we wanted to build
it for real.

---

## Constraint: SEA has no `node_modules`

The daemon's runtime `import('wincred')` (vault.ts:67) is dynamic with a
runtime-computed string id. esbuild leaves it as a literal
`require('wincred')` in the CJS bundle — marked as an external import.
At runtime inside the SEA there is no `node_modules` on disk; Node's
require resolver has no candidate to load.

Any keychain integration that goes through an npm-style import in the
daemon code must therefore either:

1. Ship the addon as a separate file the SEA can resolve via a
   `require()` against an absolute path (placed there by the installer).
2. Move the keychain-touching code out of the daemon and into a process
   that can carry its own deps (e.g. the Tauri Governor).
3. Avoid native deps entirely and shell out to OS-shipped binaries
   (PowerShell on Windows, `security` on macOS, `secret-tool` on Linux).

Options A, B, C, D below correspond roughly to those three buckets;
Option E is the status-quo / explicit-degradation path.

---

## Option A — Ship a native addon next to the SEA, resolve via absolute path

**Idea.** The Tauri installer places a native addon file (e.g.
`stavr-keyring.node`, built against the embedded Node version) into the
same `binaries/` directory as the SEA. Daemon code is patched to call
`createRequire(import.meta.url)('<install-dir>/binaries/stavr-keyring.node')`
or `process.dlopen(...)` against an absolute path, bypassing
`node_modules` resolution entirely.

**Concrete addon candidates:**
- `@napi-rs/keyring` — modern N-API, cross-platform (Windows DPAPI /
  macOS Keychain / Linux Secret Service), maintained, MIT.
- `keytar` — the historical default; deprecated by GitHub in 2023 but
  still functional. Not a great long-term choice.
- A custom Rust addon via `napi-rs` calling `keyring-rs` — gives the
  most control but also the most maintenance.

**Pros**
- Daemon owns the secret; no IPC needed.
- Cross-platform with a single API.
- Existing vault.ts logic is essentially preserved; only the import
  mechanism changes.

**Cons**
- Brings back a native addon — exactly what we just took out by
  switching to node:sqlite. Every Node major bump now requires
  rebuilding the addon for that version's ABI.
- Per-target prebuilds: 5 binaries (linux-x64, mac-x64, mac-arm64,
  win-x64, win-arm64), same matrix as the SEA.
- Installer payload grows by ~1-3 MB per platform.
- Tauri sidecar config needs additional `resources` entries; not just
  the daemon SEA.

---

## Option B — Tauri Governor owns the keychain, exposes via local IPC

**Idea.** The keychain code lives in the Rust Governor (already an
installed component, can use `keyring-rs` natively). The daemon asks
the Governor for the master key over a localhost-loopback HTTP endpoint
(or a Unix domain socket / Windows named pipe — Tauri has primitives
for both). The Governor reads/writes the OS keychain on the daemon's
behalf.

**Pros**
- No new daemon-side native deps. SEA stays clean.
- `keyring-rs` is a stable, well-known Rust crate that covers Windows
  Credential Manager, macOS Keychain, and Linux Secret Service from one
  API.
- Centralises secret access — useful for audit (Governor can log every
  keychain hit before returning).
- Aligns with the BOM Phase 4.5 / ADR-033 amendment direction
  (Governor is the local privilege boundary; daemon talks to it).

**Cons**
- Introduces a new IPC contract that has to be designed, versioned, and
  authenticated. Without auth, any local process can ask the Governor
  for the master key — a regression vs file mode + 0600.
- Requires the Governor to be running and reachable for the daemon to
  start; the daemon's `loadMasterKey` would now have a dependency on
  another process.
- Bootstrap problem: the daemon needs the key before the Governor's
  tray is fully up. Either the Governor preloads on its own startup
  (works) or the daemon polls/retries (adds latency).
- Cross-cutting code change in vault.ts (significant) plus a new IPC
  module in the Governor (Rust + Tauri command).

---

## Option C — Avoid native deps; shell out to OS-shipped commands

**Idea.** No native module, no addon. Per platform, shell out to the
binary the OS ships with:

- **Windows:** PowerShell + DPAPI. `[System.Security.Cryptography.ProtectedData]::Protect(...)`.
  Available on every supported Windows; no Python; no addon.
- **macOS:** `security` CLI. `security add-generic-password -a stavr -s
  master-key ...` and `security find-generic-password -w ...`.
- **Linux:** `secret-tool` (from libsecret). Present on most modern
  desktop installs; absent on minimal servers (Raspberry Pi headless,
  certain VPS images).

**Pros**
- No native dependency; no Node version coupling.
- The SEA stays a single file. Installer payload doesn't grow.
- Each platform's tool is well-documented and audited.

**Cons**
- Shelling out adds latency (~50-200 ms per call). vault.ts already
  caches the loaded key in process memory, so this is a one-shot cost
  at startup — acceptable.
- PowerShell invocation needs careful argument escaping; the secret
  travels through stdin (never argv) to avoid showing up in process
  listings.
- Linux coverage is uneven. Headless installs without libsecret have
  to either install it as part of the package's post-install or accept
  the file fallback.
- Maintaining three platform-specific code paths in vault.ts increases
  the test matrix.

---

## Option D — Tauri externalBin a small "stavr-keyring" helper binary

**Idea.** Compile a tiny Rust binary (`stavr-keyring`) that wraps
`keyring-rs` and exposes a CLI: `stavr-keyring get <service> <account>`
and `stavr-keyring set <service> <account>` (secret via stdin). Ship it
as a second `externalBin` sidecar in the Tauri installer alongside the
daemon SEA. The daemon shells out to it via execFile, same shape as
Option C, but with cross-platform consistency.

**Pros**
- One code path on the daemon side (vault.ts shells out to one binary
  on every OS).
- `keyring-rs` covers Windows / macOS / Linux from one Rust crate.
- No Node ABI coupling — the helper is a freestanding binary.
- Easy to audit (small, single-purpose binary).

**Cons**
- Another binary to build, version, sign, and ship — adds matrix
  overhead to governor-release.yml.
- Two sidecars in the installer instead of one.
- The Governor + the helper-binary duplicate `keyring-rs` use; Option B
  is cleaner if we already want IPC between daemon and Governor.

---

## Option E — Status quo with explicit degradation

**Idea.** Accept that installed mode (SEA) uses the file-based master
key under `~/.stavr/master.key`. The existing
`credential_unsafe_storage` event already surfaces the regression in the
event stream and dashboard. Document the trade-off in the installer
docs and in ADR-039 (or a new ADR) so it's a deliberate position, not
an oversight.

**Pros**
- Zero new code. Smallest blast radius.
- Honest with the current state: as documented in the discovery
  section, this has been the production behavior on Windows since the
  feature shipped.
- The file fallback is not nothing — `~/.stavr/master.key` is
  user-mode-only on both Unix (0600) and Windows (NTFS user ACLs by
  default under `%USERPROFILE%`).

**Cons**
- Leaves a known-degraded security posture in place.
- The `credential_unsafe_storage` event will fire on every install,
  desensitising operators to a real future regression.
- Doesn't address the macOS / Linux gap either — vault.ts has never
  had a non-file path for those platforms.

---

## Cross-cutting concerns

These apply to all options A-D (not E):

1. **Migration of existing installs.** A user who has been running with
   `master.key` on disk and adopts a new keychain-backed install must
   either (a) auto-migrate the existing key into the keychain on first
   run, or (b) accept a one-time rotation. Auto-migration is preferable;
   it's a vault.ts change applicable to whichever option is chosen.

2. **Backup / recovery.** A keychain-stored key is harder to back up
   than a file. If the user's machine dies and they restore from
   backup, the file-mode key comes with the home directory; a
   keychain-mode key may not (Windows DPAPI is account-tied;
   macOS Keychain is partially portable via Keychain Access export;
   Linux Secret Service depends on the keyring impl). vault.ts should
   document the recovery story for whichever option is picked.

3. **Family-mode interaction.** Phase 7 (family-pack installer) is
   precisely the case where setup must work for a non-technical user.
   Option B (Governor IPC) has a bootstrap dependency on the Governor
   running; if a family-pack post-install runs the daemon first, the
   key load fails. Whichever option is picked needs to specify
   ordering.

4. **Audit visibility.** Today, file-mode emits one
   `credential_unsafe_storage` event. The selected option should emit a
   complementary `credential_keychain_loaded` (or similar) so the
   dashboard's credential health pane stops showing red for installs
   that are actually secure.

---

## Comparison matrix

| | A: native addon | B: Governor IPC | C: shell-out | D: helper binary | E: status quo |
|---|---|---|---|---|---|
| Daemon-side change | small | large | medium | small | none |
| New native dep | ✅ | ❌ | ❌ | ❌ (Rust binary) | ❌ |
| Cross-platform | ✅ one API | ✅ one IPC | ❌ three paths | ✅ one CLI | n/a |
| Installer payload | +1-3 MB × 5 | +0 | +0 | +1 MB × 5 | +0 |
| Node ABI coupled | ✅ | ❌ | ❌ | ❌ | ❌ |
| IPC auth needed | ❌ | ✅ critical | ❌ | ❌ | ❌ |
| Bootstrap order | independent | governor-first | independent | independent | independent |
| Maintenance load | high (rebuilds) | medium | medium | low | none |

---

## Recommendation framing

If the operator's priority is **shipping installer-grade keychain
integration soonest**, Option C (shell-out) is the fastest path — no
new binaries, no IPC contract, works on Windows day one. Linux gap
documented.

If the priority is **architectural cleanliness aligned with the BOM
Phase 4.5 / ADR-033 direction** (Governor as local privilege boundary),
Option B is the right shape but needs the IPC contract designed first.

If the priority is **explicit honesty about the current state**, Option
E is the smallest commit and acknowledges what's already in production.

Options A and D are technically clean but each carries one large
trade-off (Node ABI coupling for A; two sidecars + duplicated Rust deps
for D) that's hard to justify when B and C are available.

**Decision is the operator's.** This document deliberately does not
pick.

---

## End of findings
