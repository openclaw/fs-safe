# Directory copying and cloning

`@openclaw/fs-safe/copy` materializes independent, caller-owned directory trees. `copyTree` prefers native copy-on-write operations by default, can require cloning, or can copy regular file bytes without cloning or copy offload.

```ts
import { copyTree, createCloneSource, probeTreeClone } from "@openclaw/fs-safe/copy";

const parent = "/srv/worktrees";
const backend = probeTreeClone(parent);
if (backend) {
  const template = `${parent}/template`;
  await createCloneSource(template);
  // Populate this caller-owned template, then keep its contents unchanged.
  await copyTree(template, `${parent}/checkout`, {
    clone: "always",
    signal: AbortSignal.timeout(60_000),
  });
}
```

## Filesystems

| Backend | Operation                                                  | Source preparation                                                                                                          |
| ------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `apfs`  | One native directory clone                                 | `createCloneSource` creates an empty directory.                                                                             |
| `btrfs` | One native writable subvolume snapshot                     | `createCloneSource` creates a subvolume; an ordinary directory is not a snapshot source. No `btrfs` executable is required. |
| `refs`  | Native directory traversal with parallel file block clones | `createCloneSource` creates an empty directory on ReFS, including Dev Drive volumes.                                        |
| `xfs`   | Native directory traversal with parallel file reflinks     | `createCloneSource` creates an empty directory. The XFS volume must support reflinks.                                       |

Native cloning requires source and destination filesystems that support cloning between them. Automatic and ordinary copying can cross filesystems. The source repository used to populate a template can live elsewhere. ReFS and XFS share file data rather than the whole directory metadata tree, so creating many small files still has a cost.

Btrfs preserves native subvolume snapshot semantics: nested subvolume contents are not included. Prepare source-only templates without nested subvolumes. This API does not recursively snapshot a hierarchy of subvolumes.

### APFS permissions

APFS directory cloning does not guarantee descendant ACL preservation. With the `CLONE_ACL` flag used here, live macOS testing preserved the source root's ACL but dropped an explicit ACL on a source descendant. Destination ACL inheritance was also omitted below the cloned root. `probeTreeClone` checks filesystem support only; neither it nor `copyTree` checks whether these ACL semantics meet the caller's permission policy. A successful clone is not proof of source ACL preservation or normal file-creation inheritance throughout the tree.

Callers that require source ACL preservation or destination ACL inheritance must use a creation path that preserves their permission policy. For example, a private Git template cache can prohibit custom descendant ACLs and decline cloning when the destination parent has inheritable ACL entries, the template root carries ACLs, or ACL inspection fails; it must also account for policy changes during cloning. Checking only the source root cannot establish that an arbitrary tree has no descendant ACLs. This library does not inspect or repair ACLs after a clone.

Apple [strongly discourages general directory cloning](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/man/man2/clonefile.2). The [XNU directory-clone authorizer notes unfinished descendant ACL inheritance](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/vfs/vfs_subr.c#L8879); this is one verified limitation, not Apple's stated complete rationale. The bulk operation remains useful for controlled, immutable templates whose callers accept its metadata semantics.

## API

`TreeCloneBackend` is the `"apfs" | "btrfs" | "refs" | "xfs"` union returned by the probe. `CopyTreeOptions` contains the optional `clone`, `signal`, and `concurrency` arguments.

`probeTreeClone(parentPath)` synchronously inspects an existing directory and returns its supported backend name or `undefined`. It creates no probe artifacts. A filesystem name identifies a candidate backend; for example, an older XFS volume may have reflinks disabled. The actual operation determines availability. An unavailable native binding produces `undefined` in automatic mode; the package's explicit native `require` mode still reports a missing binding as an error.

`createCloneSource(destination, { signal? })` creates an empty cloneable source. Its parent must already exist and the destination must be absent.

`copyTree(source, destination, { clone?, signal?, concurrency? })` copies a directory into an absent destination. Existing destinations are never merged or overwritten. The destination must be outside the source tree.

| `clone` policy     | Behavior                                                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `"auto"` (default) | Prefer native cloning; copy bytes when the binding or filesystem capability is unavailable, or cloning cannot cross the filesystem boundary. |
| `"always"`         | Require native cloning. Unsupported operations fail without a byte-copy fallback.                                                            |
| `"never"`          | Copy regular file bytes using reads and writes. No native cloning or copy-offload calls. Works without a native binding.                     |

Automatic copying does not recover from permission errors, I/O errors, cancellation, or rejected source contents such as ReFS named streams. A failed clone must leave the destination absent before fallback can create it; otherwise copying fails rather than merging into a partial tree.

ReFS and XFS cloning use 16 workers by default; `concurrency` accepts integers from 1 through 32 and bounds native file-clone workers. APFS and Btrfs use their bulk operation. Portable byte copying is sequential with one 128 KiB buffer.

Clones preserve file contents, empty directories, timestamps, executable modes where supported, and literal symbolic links. Editing a clone does not modify its source. Unsupported filesystem operations fail; callers may choose their own copy or checkout fallback after the failed operation has settled.

The ReFS backend rejects files with alternate data streams and unsupported reparse-point types instead of silently losing their contents. Symbolic links and junctions are preserved.

XFS preserves regular-file and directory modes, timestamps, extended attributes, and ACLs. It rejects special files, symlink extended attributes, non-UTF-8 names, and directory nesting deeper than 128 levels. Hardlinked source files become independent reflinked files. Portable byte copying preserves file contents, empty directories, modes where supported, file and directory timestamps, and literal symbolic links; it does not promise ownership, ACL, extended-attribute, alternate-stream, or sparse-layout preservation. On Windows, byte copying rejects unresolved symbolic links because Node does not expose their file/directory link type; resolved links keep their literal target and source type. POSIX dangling links are preserved. Choose a copying policy that meets the caller's metadata requirements; automatic copying can select either path.

`readCloneFileMetadata(files)` asynchronously reads APFS data-stream identities and file metadata in one native batch. Results correspond to input order; missing or unsupported entries return `undefined`. The returned `CloneFileMetadata` includes clone ID, device/inode, size, mode, ownership, and timestamps. These are point-in-time observations, not authorization or proof that later reads remain unchanged. Consumers such as Git index adapters must validate their own content and timestamp invariants. The reader does not follow leaf symbolic links.

## Ownership and cancellation

These are low-level operations on caller-owned absolute paths, not Root-relative methods. The source and destination parent must be real directories. The library pins their descriptors and verifies their identities; it does not establish the caller's authorization to use them. Keep the source immutable for the operation, including writes through other aliases, and keep the destination namespace under the caller's control. Literal symlinks in the cloned contents are preserved rather than followed or sanitized.

An already aborted signal prevents dispatch. In-flight cancellation stops cancellable traversal and waits for admitted native writes to finish before rejecting. APFS and Btrfs bulk operations cannot be interrupted once dispatched. An aborted or failed call can therefore leave a destination, including a complete bulk clone. It remains caller-owned; after settlement, the caller decides whether to retain or remove it. Do not start cleanup by racing the cloning promise against an abort promise.

Completion is not a crash-durability guarantee. The API is suitable for reconstructible templates and checkouts; it does not sync every file or replace application-level publication and recovery rules.

## Platform tests and benchmarks

After building the host native binding, run `pnpm test test/clone.test.ts test/copy-tree.test.ts`. APFS tests can use the normal macOS temporary directory. For Btrfs, ReFS, or XFS, set `FS_SAFE_CLONE_TEST_ROOT` to an existing writable directory on that filesystem. The test creates and cleans only its own temporary children. An explicitly configured unsupported directory fails the test rather than silently skipping platform proof. XFS metadata tests require the `attr` and `acl` utilities.

Run `node scripts/clone-xfs-proof.mjs MOUNT` on a real XFS volume to verify the public API, hashes, independent writes, and shared physical extents. It requires `filefrag` from `e2fsprogs`. Add `no-reflink` for an XFS fixture formatted with reflinks disabled; strict copying must fail and automatic copying must succeed through byte copying.

Run `node benchmarks/clone.mjs SOURCE DESTINATION_PARENT` after `pnpm build` to compare one and 16 workers on the same immutable source. It records copying time separately from fixture preparation and full file-hash verification, and retains its uniquely named output directory for inspection. Prepare Btrfs sources with `createCloneSource` first.
