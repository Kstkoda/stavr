# ADR-037 — Operator-data lifecycle: backup, retention, restore

**Status:** Proposed
**Date:** 2026-05-17
**Related:** ADR-002 (SQLite not Postgres), ADR-030 (event retention), ADR-036 (audit integrity), memory `project_stavr_team_repositioning_decision.md`

## Context

stavR accumulates state that's expensive to recreate: trust scope grants and their action history, decision audit trail, autonomy lessons learned, BOM dispatch records, credential vault entries, operator keypairs. All of it lives in `~/.stavr/runestone.db` (SQLite single file) plus `~/.stavr/keys/` (Ed25519 keypairs from ADR-036) plus `~/.stavr/credentials/` (vault per ADR-022).

Current state of backup: none. No automated snapshot, no documented restore procedure, no integrity check on the backup. If `runestone.db` corrupts or the operator's disk fails, all governance state is lost. PM2 dump.pm2 has corrupted twice in the past 48 hours (different cause but same blast radius — operator-data loss).

For a tool that's becoming the operator's source of truth for AI governance (trust scopes are legal-equivalent consent records; audit log is the only record of what was done in the operator's name), data loss is unacceptable.

Specific gaps:
- **No automated backup.** Operator would need to manually `sqlite3 .backup` on a schedule they invent.
- **No documented restore procedure.** What if the daemon won't start because `runestone.db` is corrupt? Operator has no playbook.
- **No backup integrity check.** Even if backups existed, a corrupted backup of a corrupted DB is no better than no backup.
- **No RTO/RPO targets.** No baseline expectation for "how fresh is the latest backup" or "how long to restore."
- **No retention policy for backups.** Backups themselves need lifecycle (else they accumulate forever).
- **Cross-platform path differences.** Backup procedure has to work on Windows (where stavR lives today), macOS, and Linux equally.

The team-direction repositioning raises the stakes: multiple operators sharing one instance means data loss affects multiple people. Recovery must be both feasible AND verifiable.

## Decision

Adopt a three-layer lifecycle: **continuous WAL → nightly verified snapshots → operator-managed cold copies**, with explicit RTO/RPO targets and a restore procedure that's tested in CI.

**1. Continuous protection: SQLite WAL mode + Litestream replication.**

Enable WAL mode on `runestone.db` (likely already on; ADR action item: verify). WAL gives crash-safety for in-progress transactions.

Add **Litestream** (litestream.io — single binary, MIT licensed, BSD-style replication-to-anything-S3-compatible) as an optional replication target. Operator configures via env:
- `STAVR_BACKUP_LITESTREAM_BUCKET=...` (S3-compatible URL — works with AWS S3, Backblaze B2, Cloudflare R2, MinIO)
- `STAVR_BACKUP_LITESTREAM_INTERVAL=10s`

When configured, Litestream sidecar replicates SQLite changes to the bucket every N seconds. Off-machine durable copy with second-level RPO. Operator pays bucket costs (negligible — single-digit MB/day for stavR's event volume).

If unconfigured, Litestream is skipped. The operator gets a one-time startup warning: "Off-machine replication not configured; data loss possible on disk failure. See docs/backup.md."

**2. Nightly verified snapshots.**

PM2 ecosystem.config.cjs adds a third app: `stavr-backup` — a Node process that runs nightly at operator-configurable hour (default 03:00 local) and:

1. `sqlite3 runestone.db ".backup ~/.stavr/backups/YYYY-MM-DD.db"` (atomic, online — uses SQLite's backup API, daemon stays running)
2. Computes SHA-256 of backup file
3. Opens backup file in a separate SQLite handle, runs `PRAGMA integrity_check` + walks the ADR-036 hash chain from genesis (verifies no corruption in the backup itself)
4. If verification fails: emit `backup_verification_failed` event, send notification (per v0.6 fabric) to operator with the failure detail. Keep the bad backup file for forensics.
5. If verification passes: emit `backup_completed` event with file path + SHA-256 + verified-events-count + duration
6. Copy keypairs (`~/.stavr/keys/*.ed25519*`) and credentials vault (`~/.stavr/credentials/*`) to the same dated folder
7. Apply backup retention: keep last 7 daily + last 4 weekly + last 12 monthly (Tower of Hanoi pattern); delete older

Backup destination defaults to `~/.stavr/backups/` (local disk — protects against DB corruption but not disk failure). Operator-overridable to mounted external drive or network share via `STAVR_BACKUP_DIR=...`.

**3. Operator-managed cold copies.**

Documentation in `docs/backup.md` covers:
- How to schedule a third copy to operator's preferred off-machine storage (USB drive, OneDrive, iCloud, encrypted Dropbox, etc.) — operator's choice; tool stays out of cloud-provider lock-in
- How to verify a cold copy is restorable (the same `stavr audit verify --db path/to/backup.db` command)
- How to encrypt cold copies if backing up to untrusted storage (`age` or `gpg`)

**4. Explicit RTO/RPO targets.**

- **RPO (data loss tolerance) without Litestream**: 24h worst case (between nightly snapshots).
- **RPO with Litestream**: 10 seconds (configurable down to 1s).
- **RTO (restore time) for fresh-machine recovery**: target ≤30 minutes. Sequence: install stavR binary → restore `~/.stavr/` from latest verified backup → start daemon → run `stavr audit verify` → done.
- **RTO for in-place corruption recovery**: target ≤5 minutes. Sequence: stop daemon → swap `runestone.db` with latest backup → restart → verify.

**5. CI-tested restore procedure.**

A test in `tests/backup/restore-cycle.test.ts` runs the full cycle: populate a DB with synthetic events → take a backup → corrupt the source DB → restore from backup → verify the chain end-to-end. Test runs on every push to `main`. Catches restore-procedure regressions before operator hits them in anger.

## Consequences

**Positive:**
- 30-min worst-case recovery from any single-machine failure (with Litestream off-machine copy)
- Tamper-evident backups (verification step on every backup catches corruption at backup time, not at restore time)
- Operator gets affirmative signal each morning ("backup_completed" notification) — silence on this channel = canary
- Team mode benefits: shared instance = shared protection; one operator can verify all operators' state is preserved
- Restore procedure exists in code (the test), not just docs — proves it actually works

**Negative we accept:**
- Litestream adds a subprocess (third PM2 app) — modest operational complexity gain
- Backup verification adds 1-3s wall-clock per night (negligible)
- Backups consume disk: at 10MB/day grown DB, the Hanoi pattern peaks at ~250MB locally. Trivial on any modern machine.
- Operator-managed cold copies require operator discipline (the tool can suggest but can't enforce). Documented, not automated.
- Litestream is an additional dependency; supply-chain review needed (covered in ADR-038).

## Alternatives considered

- **No backup, document a manual procedure** — what we have today. Insufficient for the team-direction bar.
- **External managed backup service (Tarsnap / rsync.net)** — fine but adds vendor lock-in and obscures the operator's data location. Litestream-to-S3-compatible gives operator vendor choice.
- **Postgres with continuous archive + PITR** — would solve recovery elegantly but contradicts ADR-002 (SQLite chosen for single-operator simplicity). Revisit only if team mode grows beyond ~3 operators.
- **Snapshot the entire `~/.stavr/` directory via OS snapshotting (ZFS / Btrfs / APFS / VSS)** — solves data capture but requires operator's filesystem support and doesn't verify backup integrity. Defer; nightly explicit backups are the primitive that works everywhere.
- **Backup via Git (commit DB to a private repo)** — Git is not designed for binary blobs that grow; would scale poorly and add Git LFS complexity. Reject.
- **Replicate to a peer stavR via ADR-035 federation** — interesting (peer-to-peer backup for the operator's own machines) but federation is still early and not the right load-bearing primitive for ADR-037. Future ADR if federation matures.

## Implementation notes (not part of decision)

- Backup file naming: `YYYY-MM-DD-HHMMSS.db` so multiple-per-day works if operator opts in to higher frequency
- The backup process needs READ-ONLY access to `runestone.db` while daemon holds write lock — SQLite's online backup API handles this correctly
- Test data for the restore test: deterministic synthetic events with predictable hashes; ~100 events covers chain walk + retention boundary + multi-actor signing
- The notification on `backup_completed` ties into v0.6 — recommend setting `notify_on_complete: true` for the backup task so operator sees it in the daily digest at minimum, immediately if configured for `crit` channels

## Acceptance for moving Status to Accepted

This ADR moves to "Accepted" when:
1. Nightly `stavr-backup` PM2 app is wired and runs successfully for 7 consecutive days in operator's environment
2. CI restore-cycle test passes on every PR
3. `docs/backup.md` exists with operator-tested procedures for: cold copy setup, restore from local, restore from Litestream
4. Litestream env var support documented (even if operator hasn't enabled it)
5. RTO/RPO targets documented in same docs page
