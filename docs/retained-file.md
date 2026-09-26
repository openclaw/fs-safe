---
title: Retained Windows files
description: "Explicit identity-bound retirement of an existing file; resource settlement is not persistence."
---

# Retain an existing Windows file

`retainFileInDirectory` from `@openclaw/fs-safe/advanced` retains **one existing
regular direct child**, without creating or deleting anything at admission.
It requires the matching native package. There is no pathname-unlink fallback.
The initial implementation supports fixed local NTFS drives only; other systems
return `unsupported`.

```ts
import { retainFileInDirectory } from "@openclaw/fs-safe/advanced";

const admission = retainFileInDirectory({
  directory: producer.directory, // canonical C:\... spelling
  parent: producer.parentIdentity, // exact bigint dev/ino
  basename: producer.basename,
  expected: producer.expected, // bigint dev/ino/size/mtimeNs/ctimeNs and SHA-256
  assertBeforeMutation: () => producer.assertCurrentExclusiveAuthority(),
});
if (admission.status === "retained") {
  using file = admission.file;
  const outcome = file.remove(); // explicit; using alone does NOT delete
  // outcome.persistence is always "not-proven".
  producer.recordRetirementObservation(outcome);
}
```

The producer must capture its expected identity, generation and bytes during its
own creation/ownership protocol. Reading an arbitrary current pathname immediately
before admission does **not** authenticate the producer. `Number` identities,
zero/unknown identities, negative/overflowing identities, and malformed digests
are rejected. A full opaque native volume/file ID is included in the receipt;
no native handle or numeric descriptor is exposed. Receipts are immutable facts,
not transferable authority.

## Admission and mutation custody

The directory's ancestry is opened component by component without following
reparse points, with delete sharing denied. Its exact expected parent identity
and canonical path are checked. The file is opened relative to that retained
parent, with write/delete sharing denied. Existing writer handles refuse
admission; a read-oplock grant also excludes preexisting writable mapped
sections. That oplock request is cancelled and joined before admission returns,
while the no-write-sharing file handle remains open. No detached request remains.

The opened file must match the expected exact NTFS identity, single-link regular
type, write/change generation, size and SHA-256. Names with stream/device syntax,
trailing-dot/space aliases and observed named data streams are unsupported.
Readonly attributes and ACL denials are not repaired or overridden. Verification
is synchronous and bounded by `maxBytes` (default 16 MiB, maximum 64 MiB).

The original producer must retain **exclusive mutation custody for the entire
file**, including alternate streams, attributes, security and hardlink creation.
Windows read/write sharing is per-stream; it is not an application lock over
all possible aliases. The helper rejects observed alternate streams and changed
generations, but does not turn a point-in-time check into exclusion of concurrent
alias/attribute operations. The synchronous `assertBeforeMutation` must check
that this original authority is still current. Callers unable to establish that
custody must not call `remove`. Privileged/raw-volume/kernel modifications are
outside this capability's threat model.

`remove()` admits authority once, revalidates the retained object, sets native
handle disposition, closes the file, observes the name under the still-retained
parent, then closes ancestry. No pathname is passed to unlink. Ordinary
`dispose()` and `[Symbol.dispose]()` only close resources. Asynchronous authority
callbacks and reentrancy are refused; even caught reentrancy poisons that attempt.
Repeated settlement returns the original receipt without another mutation or
another authority call. A copied receipt cannot be used to remove a replacement.
GC closes only and produces no settlement receipt; use explicit disposal.

## Read the facts separately

| Field | Meaning |
| --- | --- |
| `status` | `unsupported`, `not-attempted`, `preserved-mismatch`, `disposition-accepted`, `name-absent-after-settlement`, `failed`, or `indeterminate`. |
| `disposition` | Whether native deletion was unattempted, accepted, rejected, or indeterminate. |
| `namespace` | A post-file-close observation: absent, original, foreign, unknown, or not observed. Absence alone never authenticates prior deletion. |
| `resources` | `closed` or `close-failed`; operation and close errors are retained together. An uncertain close is never retried against a possibly recycled handle. |
| `persistence` | Always `not-proven`; no namespace persistence barrier was performed. |

An accepted disposition can still have an unknown/foreign/original namespace
observation or failed close. A later replacement may exist even after observed
absence. Existing read handles can retain access to old bytes after the name is
absent. Namespace observation does not certify all foreign handles are closed.
An unexpected native binding failure is indeterminate, not success.

## No persistence or service-transaction guarantee

This API does not flush a volume, implement a journal, certify power-loss-safe
unlink, or issue an application dependency release. Process-termination tests
establish process-owned handle lifetime only, not crash/storage durability.

An update transaction must independently qualify either a real namespace
persistence barrier or original-owned durable recovery with correct ordering,
generation binding and restart consumption. Until then it must retain its
uncertain recovery/dependency state. Successful removal of one payload does not
establish a committed multi-file transaction or justify deleting its receipt.
