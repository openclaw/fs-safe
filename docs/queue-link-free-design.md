---
title: Link-free queue design
description: "Unimplemented durable JSON queue v2 proposal, crash recovery, and barriers to mixed-version Android support."
---

# Link-free durable JSON queue design

**Status: design only; not implemented.** The current queue still requires
hardlinks for claim, quarantine, and retirement recovery. Android/Termux systems
that refuse those links receive `helper-unavailable`. This document does not
announce Android support or change any existing API, error code, or disk format.

The candidate below moves ownership into one atomic state file in a separate,
versioned store. It explains how link-free transitions could work for cooperating
v2 clients. It does **not** solve transparent migration with concurrent legacy
writers, arbitrary processing paths, or existing failed-file destinations.
Those gaps prevent implementation as a replacement or fallback for v1.

## Existing guarantees

The [durable queue contract](store.md#durable-json-queues) uses plain payloads at
`<id>.json`, `<id>.processing`, and `<id>.delivered`. A transfer lock serializes
consumer transitions for the JSON path; producers atomically replace `.json`
without taking that lock. The lock is not a worker lease. Another load can return
the existing processing generation, so delivery is at least once.

Claim creates a no-replace hardlink from the pending name to the processing
name. The generation at that syscall is the claimed generation. Source
retirement moves the then-current pending file into a journal and compares exact
device/inode identity with the claim. A different generation is restored
create-only if no newer pending generation exists. Thus acknowledging an older
claim cannot remove a newer enqueue. Replacing a still-pending generation by a
later enqueue for the same ID is already permitted; this is not a FIFO of all
writes to that ID.

Quarantine publishes create-only to the failed destination. A shared inode
distinguishes an interrupted publication from an unrelated destination collision.
Acknowledgement moves only the claim through the delivered marker. Migration
retains the opened claim and rejects a stale generation after its callback.
Completed transitions synchronize affected directories; ambiguous ownership,
identity, and stale transfer locks fail closed. Existing same-privilege race
limitations in the [security model](security-model.md) still apply.

These are ownership guarantees, not consequences that can be recovered from
equal JSON bytes. Two independent enqueues may contain identical JSON. A digest,
timestamp, or rounded numeric inode cannot establish that they are one generation.

## Why an in-place fallback is insufficient

| Candidate | Lost guarantee |
|---|---|
| Ordinary rename after testing for absence | A competing processing or failed destination can be overwritten. Different queues can share a failed destination without sharing a transfer lock. |
| Copy into an exclusive destination | A crash can expose partial JSON; equal bytes cannot identify interrupted publication versus unrelated collision evidence. |
| Exclusive empty placeholder, then record its owner | A crash between creation and recording ownership leaves an empty file indistinguishable from a pre-existing collision. |
| Add a producer lock or format marker | Old producers ignore both and can replace `.json` during retirement recovery. |
| Rename a retirement record back to `.json` | An old producer can publish after the absence check; replacing rename then destroys that newer generation. |

Native atomic no-replace rename could remove some of these obstacles without
making old producers cooperate. It is a distinct implementation route, requiring
qualified Android support and full claim, retirement, and quarantine crash proof.
An unavailable primitive, cross-device move, or unsupported filesystem must not
select a replacing rename or a weaker copy fallback.

## Candidate v2 disk format

V2 would be an additive, explicitly selected API with a dedicated store root,
not an option that silently changes the existing helpers. Proposed layout:

```text
store/
  .fs-safe-queue-v2/
    format.json
    state.json
    objects/
      <object-token>/
        payload.json
    .state-transfer.lock
```

`format.json` identifies protocol `fs-safe-json-queue`, integer version `2`, and
a random store ID. `state.json` repeats those values, has a monotonically
increasing decimal-string revision, and contains queue/ID slots plus a shared
failed index. Queue names and IDs use validated portable segments; object tokens
are library-generated and never interpreted as caller-supplied paths.

Each queue/ID slot has nullable `pending` and `claimed` references. A reference
contains a logical delivery-generation token and an object token. Migration can
replace the object while retaining the delivery generation. Failed slots contain
the originating queue, ID, delivery generation, and object reference. All queues
sharing a failed namespace must live in this same store and share its state
lock. Two separately configured stores cannot advertise one shared failed index.

Payload objects are immutable. They remain ordinary JSON, not envelopes exposed
to the caller. Their unique, exclusively created directories distinguish
independent equal-byte enqueues. Tokens select protocol records; they never
replace exact bigint filesystem identity, no-follow admission, or pinned-file
checks. Reused tokens, references to missing objects, unexpected links, malformed
state, unknown versions, and inconsistent store IDs fail closed.

Opening v2 requires both valid format and state files and an admitted dedicated
root. Merely finding a directory, an empty file, or a partial initialization is
not permission to adopt or delete it. Initialization exclusively creates the
namespace, writes and synchronizes its files and directory edges before success,
and leaves interrupted/ambiguous initialization for explicit recovery. An
existing v1 directory remains v1; absence of a marker never means an empty v2
store. No v2 file uses a top-level legacy queue filename.

## State transitions and persistence ordering

All v2 producers, consumers, migrations, and collectors take the same store
transfer lock. Start with a coarse lock and bounded state/object sizes; splitting
it requires a separate transaction design. Stale locks require operator recovery
after proving the owner is gone. No timeout grants ownership automatically.
Callbacks run outside the lock with their payload descriptor retained.

Every state transaction re-admits the root, format, state, and referenced objects,
including exact identity checks around awaited work. It writes a private sibling
state temp, synchronizes that file, atomically replaces the admitted state file,
then strictly synchronizes its parent before reporting success. Replacement has
the same documented platform confinement limits as existing guarded writes; a
format token or cooperative lock cannot upgrade those limits.

Before publishing a new object reference, synchronize the complete payload file,
its object directory, and the new edge in `objects/`. Persist store initialization
edges first. No mutable state may refer to an incomplete object. Before consuming
a state observed after an interrupted commit, synchronize the state parent under
the lock. A visible post-rename sync failure is uncertain completion: retain all
potentially referenced objects, report the error, and retry recovery. Never undo
the transaction by deleting its payload.

| Operation | One atomic state replacement |
|---|---|
| Enqueue | Set `pending` to a newly persisted object and delivery generation; retain `claimed`. A later enqueue may supersede this pending reference. |
| Load without a claim | Move the pending reference to `claimed` and clear `pending`; synchronize before returning bytes. |
| Load with a claim | Keep the same reference and retry that generation before any pending replacement. |
| Acknowledge | After processing succeeds, clear only the expected claimed generation. A retry with an absent claim succeeds; a different claim rejects. Never clear pending. |
| Quarantine | Require an absent failed slot, add its claim reference, and clear that claim in the same state update. An identical origin/generation/object reference is an idempotent retry; any other occupant is a collision. |
| Migrate | After the callback, require both the delivery generation and original object reference still match the claim; publish a fully persisted replacement object and change only that claim's object reference. |

The failed index is terminal inspection evidence, not pending work. It remains
create-only even across different queues in the store. A loader never scans
objects to infer pending work. The authoritative state alone determines whether
an object is pending, claimed, quarantined, superseded, or acknowledged.

Garbage collection holds the same lock, first completes parent synchronization,
and removes only objects unreachable from the committed state. It must preserve
objects pinned by active readers/migration callbacks; uncertain ownership or
unverifiable pin lifetime defers collection. Version 2 can initially omit
collection entirely. Leaked unreferenced objects are preferable to lost entries.
There is no age-based deletion of potentially referenced data.

## Crash-point table

This table is the proposed protocol invariant, **not implementation proof**.
It assumes cooperative v2 participants, an already initialized store, atomic
whole-file replacement, a filesystem honoring successful file/directory syncs,
and recovery after proven-stale lock removal. Filesystem corruption, concurrent
hostile mutation, and an unavailable durability mechanism remain explicit errors.
Power-loss behavior on each supported Android filesystem needs qualification.

For a durably accepted generation that has not been superseded, acknowledged,
or quarantined, recovery must find exactly one authoritative pending or claimed
reference. Physical orphan objects are never redelivered. Quarantine and
acknowledgement are deliberate terminal states, not exceptions silently counted
as pending. Processing can repeat if its external side effect precedes durable
acknowledgement; this is the existing at-least-once boundary.

| Crash after / during | Recovery and surviving generation |
|---|---|
| Acquiring a lock, before any transaction | Prior state stays authoritative; stale lock blocks until explicit recovery. |
| Exclusive object directory creation or partial payload write | No state reference exists. Prior pending/claimed state survives; enqueue has not succeeded. Never expose the incomplete object. |
| Payload file sync, before all object-directory edges sync | Same as above; the object is not yet eligible for publication. |
| All object syncs, before state replacement | Complete but unreferenced object is retained or later collected; prior state survives. |
| Partial state-temp write or its file sync | Prior state survives. Temp contents never authorize delivery or cleanup. |
| State replacement, before parent sync | After restart, admit the complete old or new state and sync its parent before acting. Retain objects needed by either outcome until recovery. No operation has reported durable success. Missing/invalid state is a hard failure, never an empty queue. |
| Enqueue parent sync, before response | New generation is pending (or subsequently superseded under the ordinary same-ID contract). Producer may retry after an uncertain response; no exactly-once enqueue is promised. |
| Claim replacement/sync, before returning payload | Old state has pending; new state has the same generation claimed. Recovery retries the claim first. Never both. |
| Read or callback, before ack | Claim remains; side effects may repeat. A concurrent enqueue changes only pending. |
| Migration object persistence, before state commit | Original claim survives; new unreferenced object is not delivered. |
| Migration commit/sync, before response | Old or new object belongs to the same claimed delivery generation; stale callbacks cannot overwrite the new object reference. |
| Ack replacement, before parent sync | Old state retains the claim and may redeliver; new state has an acknowledged generation. A newer pending reference survives both. |
| Ack parent sync, before response | Acknowledged generation is absent; retry never clears a different claim. Objects left behind cannot resurrect it. |
| Quarantine replacement, before parent sync | Old state retains the claim; new state has only terminal failed evidence for it. No intermediate state removes both references or exposes both as deliverable. |
| Quarantine parent sync, before response | Failed reference remains; identical retry succeeds, different-origin collision preserves both generations. |
| Collection unlink or directory sync | Only unreferenced, unpinned garbage is affected; pending/claimed/failed objects stay intact. |

## Mixed-version behavior and cutover

An old writer cannot be made to honor a new marker or lock by updating the
consumer. For example: read legacy generation A, copy it into v2, then let an
old writer replace `.json` with B. Removing `.json` can now delete B; leaving
it can deliver A twice through independent protocols. Equality of bytes does
not distinguish these events. Watching for a quiet interval cannot prove the
old writer will not publish later.

| Participants | Permitted behavior |
|---|---|
| Old and upgraded clients on v1 | Keep the current v1 protocol and error codes. Upgraded clients do not auto-convert or copy around refused links. |
| All cooperating clients on a new v2 store | Candidate state protocol above; requires an explicit new API and validation before implementation. |
| Old v1 writers alongside an isolated v2 store | Namespace coexistence only: separate backlogs. V2 must neither delete nor adopt v1 files. Old writers' work is not silently included in v2 success/drain results. |
| Old writers with a requested single merged backlog on link-refusing storage | Unsupported. Report the capability/migration failure and preserve legacy evidence; do not claim the queue was drained. |
| Quiesced legacy queue | A future explicit importer could retain migration receipts and copy under exclusive ownership. No importer is specified or authorized by this proposal. |

Old batch loaders do not recurse into the v2 namespace, but that is only format
separation, not a guarantee that an application shares a logical queue safely.
Applications must stop and fence old producers/consumers before any destructive
cutover. A directory scan, PID timeout, or absence of a current lock is not that
fence. Deployments unable to stop old writers need a qualified native primitive
route that continues the v1 ownership protocol.

## Implementation gates and decision

Do not retrofit this candidate into `writeJsonDurableQueueEntry()` or the
existing path-based lifecycle helpers. A separate proposal must settle the
public API, callback path semantics, expected-generation receipts, bounded state
growth, active-reader collection, and fail-closed initialization recovery.
Arbitrary `processingPath`/`deliveredPath`, shared external `failed/<id>.json`,
and cross-device destinations cannot be represented by this single-store
transaction without another protocol. They must retain v1 behavior, not acquire
a silently weaker fallback. V2 is not an implementation of those contracts.

Before implementing an approved scope, require deterministic crashes before and
after every mutation and sync above, subprocess termination/restart tests,
identical-payload distinct-generation tests, stale migration/ack tests, failed
index collisions across queues, invalid-format/identity tests, and initialization
and garbage-collection failures. Run a link-refusal matrix for `EACCES`, `EPERM`,
`EXDEV`, `ENOTSUP`, `EOPNOTSUPP`, and `ENOSYS` in `off`, `auto`, and `require`.
V1 must preserve its typed failures; v2 must make no ownership link attempt.
Use real Linux seccomp denial of `link`/`linkat` and Android/Termux filesystem
crash/durability qualification as separate evidence, not substitutes for one
another. Native-capable operations must retain their native security mechanism;
any performance change needs measured native/off comparison with an A/A control.

**Decision: retain the existing fail-closed implementation and land this design
only.** Transparent link-free v1 support with concurrent old writers has not
been established. A separately scoped v2 API or qualified native no-replace
implementation remains follow-up work; neither is required for 0.26.3.
