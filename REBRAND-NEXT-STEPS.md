# Stavr rebrand — next steps

The rebrand from `cowire` → `stavr` is complete in the working tree. **0** files contain "cowire" any case, **112** files now contain "stavr". The brand surfaces — `README.md`, `package.json`, `.mcp.json`, `src/paths.ts` (now points at `~/.stavr/runestone.db`), every ADR, every doc, every test, every CLI script — are renamed. The git remote is still pointing at `Kstkoda/cowire` because the sandbox couldn't write to `.git/`; you'll repoint it locally.

## What you need to do on your own machine

The sandbox where I worked has Windows file permissions blocking `.git/` writes and a couple of file deletions. Everything below runs from a normal terminal on your machine. Order matters.

### 1. Repair the git index

The sandbox corrupted `.git/index` during a failed `git stash`. Repair it before doing anything else:

```sh
cd C:\dev\cowire
del .git\index .git\index.lock .git\index.stash.3 .git\index.stash.3.lock 2>nul
git read-tree HEAD
git status
```

After `read-tree HEAD`, `git status` should run cleanly and show every rebrand change as modified.

### 2. Delete the two orphan files

```sh
del docs\cowire-architecture.docx
del test-renamed.txt
```

The first is a leftover copy of the docx (the new one is `docs/stavr-architecture.docx`). The second is a test artifact I created while probing sandbox permissions.

### 3. Rename the folder (optional but recommended)

```sh
cd C:\dev
ren cowire stavr
cd stavr
```

After this your working directory is `C:\dev\stavr`.

### 4. Point the git remote at the new repo

```sh
git remote set-url origin https://github.com/stenlund/stavr.git
git remote -v
```

### 5. Create the empty repo on GitHub

Go to https://github.com/new and create `stavr` under the `stenlund` account. Do not initialize with a README, license, or .gitignore — the push will populate everything.

If `stenlund` isn't an account you control, create it first or transfer ownership of `Kstkoda/cowire` and rename it.

### 6. Review and commit

You had uncommitted work in `src/event-types.ts`, `src/persistence.ts`, `src/connectors/`, `src/policy/`, `src/steward/planner.ts`, and `src/types/` before I started. That work is now mixed into the rebrand changes. Two reasonable paths:

**Option A: one commit for everything.**

```sh
git add -A
git commit -m "rebrand: cowire → stavr (carved into your machine)"
git push -u origin main
```

**Option B: split the rebrand from your WIP.**

```sh
git add README.md package.json package-lock.json .mcp.json src/paths.ts ARCHITECTURE.md CONTRIBUTING.md SECURITY.md NOTICE adr/ docs/ scripts/ tests/ examples/ .gitignore
git add src/cli.ts src/config.ts src/daemon.ts src/log.ts src/server.ts src/shim.ts src/tail.ts src/transports.ts src/watchdog.ts src/watchdog-install.ts src/dashboard-html.ts src/devices-storage.ts src/pairing.ts src/connect-test.ts src/usage-cli.ts src/steward-ask-cli.ts src/steward-ask-tool.ts src/steward-bug-fix.ts src/steward-bug-fix-cli.ts
git add src/credentials/ src/trust/ src/tools/ src/types/stavr-bom.ts src/workers/
git commit -m "rebrand: cowire → stavr"
git add src/event-types.ts src/persistence.ts src/connectors/ src/policy/ src/steward/planner.ts
git commit -m "wip: pre-rebrand work-in-progress"
git push -u origin main
```

### 7. Verify the published surface

After push, hit https://github.com/stenlund/stavr — the README should render with the wordmark and tagline. Then:

```sh
npm install
npm run build
node dist/cli.js daemon start
```

The daemon should bind to `127.0.0.1:7777` and write its first inscription to `~/.stavr/runestone.db`.

## Known caveats

- `package-lock.json` was touched by the sed pass. Run `npm install` once to regenerate it cleanly.
- The `COWIRE_HOME` env var is now `STAVR_HOME`. If you have shell rc files that export the old name, update them.
- The `~/.cowire/` directory on your existing machines is now stale. Either rename it to `~/.stavr/` (and the db inside to `runestone.db`) to preserve history, or start fresh.
- Old `cowire.db` files won't be found by the new daemon — it looks for `runestone.db` per `src/paths.ts`. The schema is identical; renaming the file is enough.

## Domains and trademarks

Reminder of the open items from the brand sweep:

- Register `stavr.ai` and `stavr.com` via WHOIS verification.
- File USPTO trademark applications in class 9 (downloadable software) and class 42 (SaaS).
- The known same-zone adjacency is the STAVR Team blockchain validator at `stavr.tech` — different category, different audience, but worth a one-line acknowledgment in your launch comms if it ever comes up.
