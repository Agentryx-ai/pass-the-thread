# Codex Goal app-server contract

This note records the native live-Goal target contract used by Pass the Thread.
It applies only to the exact audited Codex Desktop internal version
`26.721.41059`, `app.asar` SHA-256
`44884f86d619a12c3c0af1b8c65945005bda4379775b03270674c666226ff4b7`,
and `codex.exe` SHA-256
`39e9e041ea33ac34aad9578adfe660c5c7a6dc8f82620b77623960f9352a6ef3`.

## Static generated protocol

Running the pinned executable's own experimental TypeScript generator with
`app-server generate-ts --experimental --enable goals` produced these requests:

- `thread/goal/get`: `{ threadId }` → `{ goal: ThreadGoal | null }`
- `thread/goal/set`: `{ threadId, objective?, status?, tokenBudget? }` → `{ goal: ThreadGoal }`
- `thread/goal/clear`: `{ threadId }` → `{ cleared: boolean }`

`ThreadGoal` contains `threadId`, `objective`, `status`, `tokenBudget`,
`tokensUsed`, `timeUsedSeconds`, `createdAt`, and `updatedAt`. It exposes no Goal
id. `clear` exposes no Goal id, expected hash, timestamp, or conditional
compare-and-clear field. Consequently, Pass the Thread never uses `clear` for
rollback: a Goal can change between read and clear, and deleting a user
replacement would be unrecoverable.

## Isolated runtime canary

On 2026-07-26 the exact executable was run only against a temporary isolated
`CODEX_HOME`. The canary initialized app-server, registered a temporary thread,
observed `get = null`, set an active Goal with token budget `4321`, stopped the
process, started a new app-server process, and received an exact readback. The
rollout SHA-256 was unchanged before and after Goal RPC. The automated test is
`test/codex-goal-target.test.ts`; it skips with an explicit reason when the
pinned installed artifact is unavailable.

Windows can deny direct process creation from the packaged `WindowsApps`
artifact even though it remains readable for hashing. The adapter therefore
copies those exact bytes into a unique lease below the current user's
`AppData\Local\PassTheThread` root. It installs a protected DACL that grants
only the current user SID, verifies the owner, effective allow rules, reparse
status, and executable hash before every spawn, and fails closed if any check
cannot be established. `chmod` and the ambient `%TEMP%` ACL are not treated as
security boundaries.

Each lease has a protected v2 marker binding its exact directory, owner PID,
the owner's OS process creation time, lease creation time, and executable hash.
The creation-time binding prevents a reused PID from pinning an abandoned
lease. Normal disposal retries deletion of only that exact allowlisted lease
for a bounded interval while a hard-killed worker's app-server image settles.
A later importer may reap a dead-owner lease only after a grace period and only
when marker, exact owner identity, DACL, reparse, hash, and exact
executable-process liveness checks all pass. Each pass also has a global time
budget and candidate cap. Directory enumeration runs in a deadline-bound child
that retains only the next bounded candidate set, so roots larger than 256
entries still make progress without unbounded parent memory. A protected SQLite
cursor is advanced under `BEGIN EXCLUSIVE`; commits are crash-atomic and
concurrent importers serialize, while a hard kill rolls an uncommitted advance
back. The final cursor path is published no-overwrite only after a unique stage
database is initialized, flushed, DACL-protected, and verified. A later run
removes an abandoned stage only after exact name, grace age, DACL, reparse,
SQLite integrity/schema/metadata, PID plus process-start identity, sidecar
absence, and unchanged file identity checks. A second transactional cursor
advances before each bounded stage inspection, so preserved live, partial, or
malformed prefix stages cannot starve later valid abandoned stages. Such
unverifiable stages remain evidence. Live or malformed leading lease entries
therefore cannot starve later leases.
Executable hashing also runs in a deadline-bound child, and cleanup never starts
after the pass budget has expired.
Malformed, live, or changing leases are preserved for inspection; the shared
lease root is never recursively deleted.

## Apply and crash boundary

The plan binds the source Goal hash, deterministic target thread id, requested
and expected readback, capability id `codex.goal-app-server/v1`, capability
fingerprint, and exact target artifacts. Apply preflights the runtime before any
target write, writes and registers the rollout, checks for an absent or exact
idempotent Goal, journals `goal-activation-requested`, calls `set`, restarts for
`get`, verifies semantic equality and the unchanged rollout hash, then commits.

There is no cross-database atomicity claim. A crash after the request marker may
have committed the native Goal even if the journal was not updated. Importer
rollout and thread registration are therefore preserved until reconciliation:

- exact native readback: roll forward and commit;
- absent native readback: recover only exact importer-owned rollout and thread
  registration;
- differing native readback: stop, preserve everything, and never overwrite or
  clear the Goal.

Each app-server worker acquires a separate OS-backed SQLite exclusive fence,
bound to the canonical `CODEX_HOME`, before it starts app-server and holds it
until the child has closed. If the importer parent is terminated and releases
its main target lock, the surviving write-capable worker still excludes a
recovery read. Recovery can proceed only after the worker exits and the OS
releases the fence, so it cannot observe absence while an orphaned `set` is
still able to commit.

The parent also persists a per-thread generation before spawning a set worker.
It binds operation id, thread id, capability id, profile fingerprint, and a
one-use nonce. The worker must CAS `pending` to `claimed` and durably commits
that claim before app-server starts; a normal child close advances it to
`completed`. Recovery cancels a still-`pending` generation under the same
exclusive fence before reading. A delayed worker then fails its nonce/state
check and performs no set. A durable `claimed` row left by a hard-dead worker
cannot prove that its app-server child is gone, so automatic recovery fails
closed and preserves the imported artifacts.

Provider usage/time counters are not migrated as if they were equivalent.
Only an already-native Codex token budget is portable to the Codex target; a
Claude Goal has no equivalent native counter and starts with `tokenBudget = null`.
