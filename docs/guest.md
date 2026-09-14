# Guest filesystem source

`@openclaw/fs-safe/guest` exports Python 3 source for filesystem operations in
Linux and macOS guests that do not have Node installed. The host imports a
string and passes it to its existing container, SSH, or process transport.
Importing this subpath performs no I/O and launches no process.

This is the filesystem engine extracted from OpenClaw's sandbox bridge. The
caller still owns root admission, mount selection, read-only policy, canonical
path authorization, live authority, argument framing, and process lifetime.
Use [Root](root.md) for ordinary filesystem operations in the Node process.
This source artifact is separate from the retired host-side Python worker
described in [Migrating to 0.5](migrating-to-0.5.md).

## Exports and requirements

```ts
import {
  GUEST_FILESYSTEM_PYTHON,
  GUEST_FILESYSTEM_CREATE_EXISTS_EXIT_CODE,
  GUEST_FILESYSTEM_READ_NOT_FOUND_EXIT_CODE,
  GUEST_FILESYSTEM_RENAME_NO_REPLACE_PYTHON,
} from "@openclaw/fs-safe/guest";
```

`GUEST_FILESYSTEM_PYTHON` is the complete single-invocation program. The two
exit constants are `17` for an exclusive-create collision and `2` for a
missing read parent or leaf after the root opens. Other nonzero statuses are
errors; stderr is diagnostic text, not a structured error protocol.

The guest needs Python 3 with `ctypes`, descriptor-relative POSIX operations,
`O_DIRECTORY`, and `O_NOFOLLOW`. Linux and macOS are the supported guest
platforms. The guest does not need fs-safe's Node package, native addon, Rust,
or WASM. Native mode configuration in the host does not configure this program.

`GUEST_FILESYSTEM_RENAME_NO_REPLACE_PYTHON` contains just the
`rename_no_replace(src_parent_fd, src_basename, dst_parent_fd, dst_basename)`
definition. OpenClaw's workspace bootstrap consumes this same fragment when
publishing a prepared workspace; exporting it avoids a second source owner.
Its embedding program must import `ctypes`, `errno`, `os`, and `sys`, admit
the descriptors and single-component names, and own cleanup and syncing.
The fragment has no argument preflight of its own.

On Linux it uses `renameat2(RENAME_NOREPLACE)`; on macOS it uses
`renameatx_np(RENAME_EXCL)`. If Linux lacks that function or reports it as
unsupported, it falls back to `link(..., follow_symlinks=False)`, leaving the
source entry for caller cleanup. That fallback supports files, not directory
publication. Existing destinations are never replaced by this fragment.

## Invocation protocol

Pass the source through `python3 -c` and arguments as literal argv elements.
Do not concatenate untrusted values into a shell command. Transport adapters
that require a shell must apply their existing quoting rules to every element.
The following example uses an already admitted guest root and parent path:

```ts
import { spawnSync } from "node:child_process";
import { GUEST_FILESYSTEM_PYTHON } from "@openclaw/fs-safe/guest";

const result = spawnSync("python3", [
  "-c", GUEST_FILESYSTEM_PYTHON,
  "write", "/srv/admitted-workspace", "notes", "today.txt", "1",
], { input: Buffer.from("hello\n"), timeout: 10_000 });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(result.stderr.toString());
```

All frames below start at `sys.argv[1]`. `root` is an admitted guest directory;
`parent` and `directory` are paths relative to that root. An empty relative
path selects the root itself. Flags are strings: `"1"` enables and `"0"`
disables. Do not omit required fields.

| Operation | Positional frame | Input / output |
|---|---|---|
| Read | `read root parent basename [maxBytes]` | Raw bytes on stdout; optional nonnegative integer byte limit. |
| Write | `write root parent basename mkdir` | Raw stdin; atomically replaces a file entry. |
| Create | `create root parent basename mkdir` | Raw stdin; exclusively publishes a completed file. |
| Copy | `copy srcRoot srcParent srcBasename dstRoot dstParent dstBasename mkdir` | Regular-file copy, atomically replaces destination. |
| Rename | `rename srcRoot srcParent srcBasename dstRoot dstParent dstBasename mkdir` | Rename with cross-device copy/delete fallback. |
| Remove | `remove root parent basename recursive force` | Removes the leaf, or recursively removes its tree. |
| Make directories | `mkdirp root directory` | Creates missing relative directory components. |
| List directory | `readdir root directory` | JSON array of `{ name, isDirectory }`; no sorting guarantee. |

The complete program rejects empty, `.`, `..`, slash-containing, and NUL
basenames before opening roots or creating parents. Both leaf operands of copy
and rename are checked. Backslashes, colons, quotes, and newlines remain legal
POSIX basename characters. Relative directory traversal rejects `..`; empty
and `.` components are skipped. Supply admitted relative paths, not arbitrary
absolute paths whose spelling happens to pass that component walk.

## Boundary and operation behavior

The supplied root spelling is trusted. Opening it does not prove the root is
the mount or inode previously authorized by the caller. Basename syntax checks
are not authorization. Callers must admit their roots and paths, preserve
read-only shadows and live authority, and run the program inside the intended
OS isolation boundary.

Parent traversal and operation bodies use directory descriptors. Reads and
copies refuse final symlinks, hardlinked files, and nonregular files. Bounded
reads check both admitted size and consumed bytes; a growing file can produce
partial stdout before rejection. Consumers must discard read output when the
exit status indicates failure. Removal unlinks a final symlink without
following it; rename moves symlink entries. Write and copy replace destination
entries, including symlinks, without following them. A force removal tolerates
a missing leaf but does not suppress failure to open its parent.

Write preserves an existing regular file's mode and otherwise creates private
files. Copy preserves the source mode. Exclusive create publishes a mode-0600
file from a private staging directory. Staging names retain the `.openclaw-*`
prefixes and use short random suffixes independent of the destination basename,
so legal names near the filesystem's component limit also work for writes and
cross-device moves.

Cross-device directory moves build a copy manifest and check it during source
cleanup. Source changes can leave the published destination and some or all
of the source. Regular-file and symlink move fallbacks unlink the source
pathname after publication; they do not perform the directory manifest's
identity checks. Directory cleanup also has check-to-unlink race windows.
These mechanics do not promise content integrity against same-UID peers.

## Failure, cancellation, and budgets

Nonzero exit is not proof that nothing was published. A post-publication
identity or sync failure, or cross-device source-cleanup failure, can leave a
destination. The caller owns reconciliation and retry policy; do not assume
it is safe to remove that destination or replay a mutation blindly.

Ordinary Python failures run `finally` cleanup. There is no cancellation frame
or signal handler. Process death closes descriptors, but forced termination
can leave staging names. The transport owns termination, waiting for children
to settle, and any application-specific recovery.

Read byte limits are optional. Copy, write, recursive removal, directory
listing, and cross-device tree moves have no byte, entry, or depth budget in
this protocol. Recursive traversal and listing collect entries eagerly.
Use caller-owned isolation and resource limits appropriate to the operation.
The existing fsync sequence is preserved; this is not a recursive transaction,
rollback facility, or a stronger durability guarantee than the underlying
filesystem provides.
