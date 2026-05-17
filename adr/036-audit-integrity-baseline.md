# ADR-036 — Audit integrity baseline: hash-chained + signed events

**Status:** Proposed
**Date:** 2026-05-17
**Related:** ADR-030 (event retention), ADR-031 (observability), ADR-022 (trust scopes), memory `project_stavr_team_repositioning_decision.md`

## Context

stavR's `events` table is the authoritative record of everything the daemon does on the operator's behalf: decisions made, scopes granted/revoked, host_exec calls, brick installs, BOM dispatches, worker outcomes. Today the table is a normal SQLite table — any process with file access to `~/.stavr/runestone.db` can `UPDATE` or `DELETE` rows without trace.

For a tool that the operator delegates non-trivial authority to (trust scope grants, host_exec writes, GitHub PR merges), the audit log is not a nice-to-have — it's the artifact that proves the operator's consent was respected. Today that artifact can be edited.

Specific gaps:
- **No append-only enforcement.** Schema allows `UPDATE events SET ...` and `DELETE FROM events WHERE ...`. Nothing detects modification.
- **No tamper-evidence.** Even if the daemon never modifies events, an external script with file access can. Operator has no way to verify history is intact.
- **No identity attribution.** Event rows include `actor` field as plain text. Nothing cryptographically binds the event to the actor who wrote it.
- **Retention sweeps look identical to malicious deletes.** ADR-030 retention is legitimate; the trail of a deletion is indistinguishable from tampering.

The team-direction repositioning (memory `project_stavr_team_repositioning_decision.md`) raises the audit bar: multiple operators sharing one stavR instance means each operator needs cryptographic proof that the others' actions are recorded faithfully.

## Decision

Adopt **hash-chained + Ed25519-signed events** as the new audit integrity baseline. Three concrete changes:

**1. Hash-chain the events table.**

Add columns to `events`:
- `prev_hash TEXT NOT NULL` — SHA-256 of the previous event's full canonical-JSON serialization (genesis event uses 64 zero hex chars)
- `event_hash TEXT NOT NULL` — SHA-256 of THIS event's canonical-JSON including `prev_hash`

Insertion: writer reads max(`event_hash`) under `BEGIN IMMEDIATE TRANSACTION`, computes new hash, inserts. Concurrent writers serialize on the transaction (better-sqlite3 is sync; SQLite WAL mode handles this naturally).

Verification: separate `stavr audit verify` command walks the chain from genesis, recomputing each `prev_hash` and confirming match. Any break = tamper indicator with the exact row pinpointed.

**2. Sign events with operator's Ed25519 key.**

Add column:
- `signature TEXT NOT NULL` — Ed25519 signature over `event_hash`, base64-encoded

Operator key generated on first boot (`~/.stavr/keys/operator.ed25519` — private, 0600) + public key (`~/.stavr/keys/operator.ed25519.pub`). Daemon loads private key into memory at start; signs every event before insert.

For team mode: each operator has their own Ed25519 keypair. Events include `actor_pubkey_fingerprint` (SHA-256 of public key, first 16 hex chars). Verifier checks signature against the matching pubkey from `~/.stavr/keys/team/*.pub`.

**3. Retention sweeps preserve the chain.**

ADR-030 retention deletes old events. To preserve hash-chain integrity, retention works by:
- Mark for deletion (set `retention_pending = 1`) rather than DELETE
- Create a `retention_summary` event with `kind: 'retention_swept'` that records: range deleted, count, hash of pre-deletion chain head
- On actual delete (separate vacuum step), the summary event remains as the bridge between pre- and post-sweep chain

Verifier knows to expect chain gaps at `retention_swept` boundaries and validates only the still-present range.

## Consequences

**Positive:**
- Tamper-evidence: any modification to events (outside the daemon, or even by the daemon if compromised) is detectable in O(N) walk
- Per-actor cryptographic proof for team mode — operator A can verify operator B's actions are signed by B's key
- Detection of accidental data loss (e.g., SQLite file corruption) is automatic via chain validation
- External audit trail (e.g., to SIEM via OTel) is the same hash-chained events — third party can verify independently
- Foundation for ADR-037's backup integrity (backup of hash-chained events is self-verifying)

**Negative we accept:**
- ~64 bytes per event for the two hashes + ~88 bytes for the signature — ~200 bytes overhead per row. At today's ~5k events/day that's ~1MB/day extra storage — negligible for SQLite, would matter at SaaS scale (we're not SaaS).
- Insertion is ~3-5x slower due to the read-then-write inside a transaction. Measured baseline: ~100k events/sec on operator hardware. New: ~25k events/sec. Still 1000x more than stavR's actual event rate (~50/sec peak observed).
- Operator key loss = inability to sign new events (daemon refuses to start until key restored from backup). Solved by ADR-037's backup procedures including the keys directory.
- Verification of long chains gets slow (~10k events/sec verification rate on operator hardware = 100k events verifies in 10s). Acceptable; verifier is a manual operator command, not a hot path.
- Adding new actor in team mode requires distributing their pubkey to all other operators' `~/.stavr/keys/team/`. Manageable for trusted small teams; would need key-rotation infrastructure for larger teams.

## Alternatives considered

- **Merkle tree instead of linear hash chain** — gives O(log N) verification of any single event vs O(N) walk. Decided: linear chain is simpler, audit-verify is a manual command not a hot path, and the implementation surface is smaller. Revisit if verify performance becomes a bottleneck.
- **HMAC instead of Ed25519** — symmetric key is simpler but breaks team mode (any operator holding the key can forge any other's events). Ed25519 with per-operator keypairs solves attribution. Asymmetric is the right primitive here.
- **External audit-log service (Splunk / Datadog / S3 Object Lock)** — would solve tamper-evidence by externalizing. Decided: not in this ADR. Adds operational burden (an external service to maintain), changes the local-first promise. Optional sink integration is a separate ADR (would be 040+).
- **Append-only SQLite table via triggers** — `CREATE TRIGGER ... BEFORE DELETE ... RAISE` blocks DELETE. Decided: too brittle. Schema migrations need to be able to evolve the table; trigger fights us. Hash chain detects mutation rather than prevent it, which is the right primitive for an audit log (you want to know IF tampering happened, not to assume it can't).
- **Bitcoin-style proof-of-work** — overkill. We're protecting a personal audit log, not securing $1T of value against nation-state attackers.
- **Sigsum (sigsum.org) / Sigstore Rekor** — external transparency log for the operator's signed events. Strong primitive for "I can prove this event existed at time T to a third party." Decided: out of scope for ADR-036 (which is the local baseline); good candidate for a follow-up ADR if team mode evolves toward sharing logs across organizations.

## Implementation notes (not part of decision)

- Migration is ALTER TABLE additive (`prev_hash`, `event_hash`, `signature`, `retention_pending`, `actor_pubkey_fingerprint`); existing rows backfilled with `prev_hash = '00..00'`, `event_hash` computed at boot, signature set to a special `legacy:unsigned` marker that verifier accepts but flags. New events from this version forward are signed and chained.
- Boot fail-loud: if private key file missing OR permissions wrong (not 0600 on POSIX, not user-only on Windows) the daemon refuses to start with a precise error and pointer to the restore docs.
- Memory: private key stays in process memory only; never persisted into logs, never copied into events.
- Test surface: ~30 new tests. Round-trip (sign + verify), tamper detection (modify a row → verify fails at that row), chain break detection, multi-actor key rotation, retention boundary handling.

## Acceptance for moving Status to Accepted

This ADR moves to "Accepted" when:
1. Schema changes land via additive migration (still in `persistence.ts` per CC's PR #32 convention call — to be moved to Drizzle in a separate ADR)
2. Signing pipeline wired into event insertion path
3. `stavr audit verify` command works and is documented
4. Operator key bootstrap flow + key backup docs land (ADR-037 dependency)
5. At least one team-mode test demonstrates multi-actor verification
