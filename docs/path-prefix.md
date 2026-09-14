# Resolving an existing path prefix

`resolvePathPrefixSync()` follows filesystem path components until the first
missing entry. It returns a canonical existing prefix and the unprocessed
suffix separately, including dangling symlink targets.

```ts
import { resolvePathPrefixSync, type ResolvedPathPrefix } from "@openclaw/fs-safe/advanced";

const observed: ResolvedPathPrefix = resolvePathPrefixSync("/srv/data/future/file.json");
// When /srv/data exists but future does not:
// observed.existingPath is the canonical spelling of /srv/data.
// observed.unresolvedSegments is ["future", "file.json"].
```

The result has three readonly fields:

| Field | Meaning |
| --- | --- |
| `absolutePath` | Input anchored to the current directory or Windows drive, with raw path components retained and Windows separators converted to backslashes. |
| `existingPath` | Existing prefix canonicalized by fs-safe's native-realpath owner. This may be a file when the entire path exists. |
| `unresolvedSegments` | Components from the first missing entry onward, after expanding any earlier symlinks. Empty when the entire path exists. |

## Physical traversal and missing paths

The helper resolves `link/..` from the link's physical target. It does not use
`path.resolve()` on the full input or a symlink target, because lexical
normalization would erase that traversal. Relative inputs use the current
directory; Windows drive-relative inputs use Node's current directory for that
drive. A root-relative Windows symlink target retains its containing link's
drive or share root. Windows junctions and full UNC share roots are supported.

At the first `ENOENT`, traversal stops. A suffix such as
`missing/../live.sqlite` remains `["missing", "..", "live.sqlite"]`, even if
`live.sqlite` exists beside the missing component. Dot components, repeated
separators, and a trailing separator in the unresolved suffix are retained.
Normalizing that suffix would invent an alias to a file the filesystem cannot
reach through the missing directory. The caller owns any application-specific
comparison or prospective-path policy.

## Failures and limits

Only `ENOENT` from component inspection produces a missing suffix. Permission,
I/O, non-directory traversal, symlink-reading, and final canonicalization
failures propagate. A vanished symlink that was already observed is an error,
not an unprocessed missing component. NUL bytes reject with `invalid-path`.

Resolution rejects with `ELOOP` after 64 symlink expansions or a repeated
resolution state. The state retains exact bigint device/inode identity and
the remaining suffix, so revisiting a link with a shorter suffix is permitted.
Traversing through a non-directory, including `file/..`, `file/.`, or `file/`,
rejects with `ENOTDIR`.

Dot and parent components require the directory's search permission before
they are collapsed. Native realpath alone does not establish this permission
on every platform. Empty components from repeated or trailing separators do
not introduce a `.` lookup.

This is a read-only path observation. It neither pins files nor creates a root
boundary, authorizes access, or guarantees a consistent snapshot during
concurrent changes. Results can become stale immediately. Use a guarded Root
operation for subsequent access to untrusted paths; keep any database ownership,
cache invalidation, and mutation policy with the caller. Native configuration
and Bun realpath limitations follow the existing [runtime contract](install.md#bun-runtime).
