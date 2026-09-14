# Path case probing

`probePathCaseInsensitiveSync()` observes whether a path's lookup location
folds ASCII case. It returns `true`, `false`, or `undefined` when the observation
cannot establish an answer. It does not infer a filesystem property from the
operating system or cache its result.

```ts
import { probePathCaseInsensitiveSync } from "@openclaw/fs-safe/advanced";

const insensitive = probePathCaseInsensitiveSync("/srv/data/future.json", {
  allowTemporaryProbe: false,
});
if (insensitive === undefined) {
  // The application decides how to handle an unavailable observation.
}
```

## Lookup location

The input is resolved with Node's `path.resolve()`. Existing targets, including
directories and final symlinks, are first compared by basename in their parent.
The probe does not follow a final symlink to decide the target's case behavior.
Parent aliases are followed. For a missing path, it walks to the nearest existing
directory whose metadata can be read, without creating the missing directories.
An unreadable directory listing returns `undefined`.

The probe checks existing directory entries before considering a temporary
file. Separately listed case variants count as distinct entries even when they
are hardlinks to the same inode. Identity comparisons retain bigint precision;
unknown Windows identities do not count as matches. The original entry is
rechecked after looking up its case variant, so its disappearance or replacement
invalidates the observation. A detected directory replacement also returns
`undefined`.

## Temporary probes and cleanup

`allowTemporaryProbe` defaults to `true`. When existing entries give no answer,
the helper exclusively creates one empty `.fs-safe-case-probe-*` file in the
selected directory at mode `0o600`. It uses the existing temporary-file owner
to retain the descriptor and exact cleanup identity. Successful ordinary
completion removes the probe and closes the descriptor.

Set `allowTemporaryProbe: false` for strictly read-only observation. In that
mode an empty directory, or one with no useful ASCII-case names, returns
`undefined` without creating a temporary file. Temporary probing can change
directory timestamps and trigger filesystem watchers even when cleanup succeeds.

Operational failures, unverified identities, changed entries, and cleanup
failures return `undefined`. A substituted or hardlinked temporary entry is
preserved. When cleanup fails operationally, the existing owner retains its
identity-bound process-exit retry. A creation whose identity cannot be obtained
may leave an empty file; the helper never guesses cleanup ownership. Therefore
`undefined` does not promise that no temporary artifact remains.

## Limits

This is a local ASCII-case observation, not a Unicode-normalization test,
filesystem-wide guarantee, lock, or authorization receipt. Directory enumeration
and metadata lookups are separate operations. Concurrent changes can invalidate
or immediately stale a result, and the final identity check and unlink are not
an atomic conditional deletion. Use temporary probing only where creating a
temporary file is permitted. The caller retains any admission, serialization,
fallback, or later mutation policy.
