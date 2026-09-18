# Exclusive leaf creation

The creation-policy work is tracked in [#482](https://github.com/openclaw/fs-safe/issues/482).

Use `createDirectory()`, `createDirectorySync()`, and `createFileSync()` from
`@openclaw/fs-safe/advanced` when an existing, trusted parent should receive
one new entry. These operations are exclusive and nonrecursive: an existing
entry throws `FsSafeError("already-exists")`, and missing parents are not
created. They do not repair or adopt an existing destination. `Root.mkdir()`
continues to own recursive, idempotent directory creation within a Root.

```ts
import {
  createDirectorySync,
  createFileSync,
} from "@openclaw/fs-safe/advanced";
import fs from "node:fs";

createDirectorySync("/trusted/application/new-state", { private: true });
using file = createFileSync("/trusted/application/new-state/initial.db", {
  private: true,
});
fs.fsyncSync(file.fd);
```

Both directory variants return `void`; `createFileSync()` returns an empty,
read/write descriptor owned by `OwnedFileDescriptorSync`, with
`{ fd, close(), [Symbol.dispose]() }`. Use the
owner to close it, rather than calling `fs.closeSync()` yourself. Closing and
disposal are idempotent; a failed close is not retried through a descriptor
number that might already have been reused. File creation does not write
payload data or request file or parent-directory synchronization.

## Permission options

`CreateDirectoryOptions` and `CreateFileOptions` both support `private?: boolean`
for private creation. `mode?: number` selects permission
bits; invalid values and private requests with group/world or special bits
reject before mutation. Restrictive owner-only modes remain restrictive.
Without `private`, ordinary Node defaults and the process umask apply. Private
POSIX creation requests `0700` for directories and `0600` for files by default;
the umask may restrict those permissions further. Existing directory privacy
checks never broaden permissions.

On macOS (Darwin), private creation also requires an ACL-free result. The native
helper must provide `inspectDarwinAcl`; native `off`, a missing helper, or an
older helper without that capability rejects with `helper-unavailable` before
creating parents or staging entries. There is no system-command fallback for
Darwin private creation. Operations without `private: true` keep their existing
native-mode behavior.

Private Darwin directories must retain owner-read or owner-search permission
after applying the umask so their ACL can be inspected. Modes `0000` and `0200`
reject with `helper-unavailable` before directory creation. Existing private
directories with neither permission also reject with `helper-unavailable`;
permissions are never broadened to inspect them. Modes `0100`, `0300`, and `0400`
remain supported, as does the default `0700`. Private files with mode `0000`
remain supported because inspection uses the owned creation descriptor.

Before creation, the parent ACL is inspected for entries that could be inherited
by the new directory or file, as applicable. Relevant inheritable entries reject
creation. Noninheriting parent ACLs, such as the usual macOS home-directory
deny-delete entry, do not reject child creation. Created directories and files
are checked for owner-only permissions and no ACL before admitting the directory
or allowing payload writes. An existing directory requested with `private: true`
must also be owned by the current user, have owner-only permissions, and have no
ACL. These checks never clear an ACL after creation or repair an existing entry.

On Windows, mode bits alone do not establish privacy. Private creation uses a
protected current-user, LocalSystem and Administrators DACL. A private staging
directory supplies trusted-only inheritable permissions before Node creates
the file. The original Node descriptor stays pinned while its full Windows
identity is compared with a security handle before the file DACL is protected.
An already broadly accessible file is rejected, not repaired. Keep the trusted
parent ancestry and staging directory ACL protected from untrusted changes;
post-operation checks do not make pathname-based fallback operations atomic
against an adversary who can change that namespace.

The internal async writer awaits system commands, file opens and closes, and
security verification. It does not wrap the synchronous creator in a promise.
Short identity checks and the existing guarded link/unlink critical sections
remain synchronous.

Private Windows file publication retains the same inode and never overwrites
an existing destination. The current implementation requires hardlinks on the same
local filesystem. Unsupported filesystems reject with `helper-unavailable`;
there is no copy-to-destination fallback. On Windows the owner overlaps a
verified destination descriptor with the creation descriptor before removing
the temporary name. Requested read-only attributes are finalized through the
retained destination descriptor after that handoff.

On Windows, native `auto` uses available capabilities; native `off` and
missing-capability `auto` use the packaged system-command security bridge. Native `require`
rejects unavailable required capabilities instead of starting a command. The
private-file capability check runs before creating parents or staging entries;
directory-only operations require only their directory capabilities. The
[Windows security fallback prerequisites](install.md#windows-security-fallback)
apply. All command mutations report unconfirmed outcomes when their reply or
termination cannot establish completion.

## Authority and failure outcomes

`assertBeforeMutation?: () => void` is a synchronous current-authority check.
It runs after preparation and immediately before creation or publication;
thenables reject before mutation. Parent and file identity checks are repeated
after the callback. Final permission checks, descriptor settlement and cleanup
retain the operation's cleanup ownership after publication.

Failure does not always mean the final path is absent. Private-file errors
after publication or ambiguous publication preserve the destination and carry
`details.publication.status` (`published` or `indeterminate`), the target path and
staging cleanup outcome. Cleanup and close failures retain the original error
in the cause chain. When `stageDirectory` is present, `cleanup` describes that
stage's settlement; it does not mean the published destination was removed.
If a directory is created but its subsequent admission fails, the error records
its published path and preserves it. A private file whose staging directory
cannot be admitted reports `not-published` and identifies the preserved stage.
Observed replacement paths are preserved. Existing
`createPrivateDirectory()` retains its Windows-only compatibility contract;
new portable callers should use the ordinary creation operations with
`private: true`.
