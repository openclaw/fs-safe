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
| `apfs`  | Native bulk clone, then directory timestamp repair         | `createCloneSource` creates an empty directory.                                                                             |
| `btrfs` | One native writable subvolume snapshot                     | `createCloneSource` creates a subvolume; an ordinary directory is not a snapshot source. No `btrfs` executable is required. |
| `refs`  | Native directory traversal with parallel file block clones | `createCloneSource` creates an empty directory on ReFS, including Dev Drive volumes.                                        |
| `xfs`   | Native directory traversal with parallel file reflinks     | `createCloneSource` creates an empty directory. The XFS volume must support reflinks.                                       |
| `zfs`   | Native directory traversal with parallel file reflinks     | `createCloneSource` creates an empty directory. Requires Linux OpenZFS file reflinks and the pool block-cloning feature. |

Native cloning requires source and destination filesystems that support cloning between them. Automatic and ordinary copying can cross filesystems. The source repository used to populate a template can live elsewhere. ReFS, XFS, and ZFS share file data rather than the whole directory metadata tree, so creating many small files still has a cost.

ZFS uses strict file reflinks within one dataset, not dataset snapshots. The installed Linux OpenZFS version must implement `FICLONE`, and the pool must enable `feature@block_cloning`. The probe identifies ZFS even when that feature is unavailable; `clone: "always"` then fails and `"auto"` can copy bytes. Native cloning was verified on OpenZFS 2.4.1 with POSIX ACLs. See the [OpenZFS block-cloning contract](https://openzfs.github.io/openzfs-docs/Basic%20Concepts/Data%20Storage/Block%20Cloning.html) for filesystem limits and pool sharing counters.

Btrfs preserves native subvolume snapshot semantics: nested subvolume contents are not included. Prepare source-only templates without nested subvolumes. This API does not recursively snapshot a hierarchy of subvolumes.

### APFS permissions

APFS directory cloning does not guarantee descendant ACL preservation. With the `CLONE_ACL` flag used here, live macOS testing preserved the source root's ACL but dropped an explicit ACL on a source descendant. Destination ACL inheritance was also omitted below the cloned root. `probeTreeClone` checks filesystem support only; neither it nor `copyTree` checks whether these ACL semantics meet the caller's permission policy. A successful clone is not proof of source ACL preservation or normal file-creation inheritance throughout the tree.

Callers that require source ACL preservation or destination ACL inheritance must use a creation path that preserves their permission policy. For example, a private Git template cache can prohibit custom descendant ACLs and decline cloning when the destination parent has inheritable ACL entries, the template root carries ACLs, or ACL inspection fails; it must also account for policy changes during cloning. Checking only the source root cannot establish that an arbitrary tree has no descendant ACLs. This library does not inspect or repair ACLs after a clone.

Apple [strongly discourages general directory cloning](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/man/man2/clonefile.2). The [XNU directory-clone authorizer notes unfinished descendant ACL inheritance](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/vfs/vfs_subr.c#L8879); this is one verified limitation, not Apple's stated complete rationale. The bulk operation remains useful for controlled, immutable templates whose callers accept its metadata semantics.

## API

`TreeCloneBackend` is the `"apfs" | "btrfs" | "refs" | "xfs" | "zfs"` union returned by the probe. `CopyTreeOptions` contains the optional `clone`, `signal`, and `concurrency` arguments. `CopyCloneMode` is the `"auto" | "always" | "never"` strategy shared with [`Root.copyIn`](root.md#writes); tree copies default to `"auto"`, while guarded file copies default to `"never"`.

`probeTreeClone(parentPath)` synchronously inspects an existing directory and returns its supported backend name or `undefined`. It creates no probe artifacts. A filesystem name identifies a candidate backend; for example, an older XFS volume may have reflinks disabled. The actual operation determines availability. An unavailable native binding produces `undefined` in automatic mode; the package's explicit native `require` mode still reports a missing binding as an error.

`createCloneSource(destination, { signal? })` creates an empty cloneable source. Its parent must already exist and the destination must be absent.

`copyTree(source, destination, { clone?, signal?, concurrency? })` copies a directory into an absent destination. Existing destinations are never merged or overwritten. The destination must be outside the source tree.

| `clone` policy     | Behavior                                                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `"auto"` (default) | Prefer native cloning; copy bytes when the binding or filesystem capability is unavailable, or cloning cannot cross the filesystem boundary. |
| `"always"`         | Require native cloning. Unsupported operations fail without a byte-copy fallback.                                                            |
| `"never"`          | Copy regular file bytes using reads and writes. No native cloning or copy-offload calls. Works without a native binding.                     |

Automatic copying does not recover from permission errors, I/O errors, cancellation, or rejected source contents such as ReFS named streams. A failed clone must leave the destination absent before fallback can create it; otherwise copying fails rather than merging into a partial tree.

`concurrency` accepts integers from 1 through 32 and bounds active file copies. ReFS, XFS, and ZFS cloning default to 16 workers. Byte copying defaults to four concurrent files on Windows and one elsewhere. Btrfs uses its bulk operation. APFS uses a bulk clone followed by native directory-entry enumeration to restore directory timestamps; known regular files and symbolic links need no additional stat or open.

On Windows, automatic byte copying uses the native binding when available to transfer data between the already-checked file handles in chunks of at most 1 MiB, with smaller buffers for small files. This accelerates NTFS and cross-volume copies without reopening source or destination pathnames. The native worker finishes before its descriptors are closed or cancellation is reported. `clone: "never"` and native-disabled copies use JavaScript read/write loops with reusable buffers: at most 1 MiB per active file on Windows, or 128 KiB elsewhere. Both paths share the file-worker budget across sibling directories, wait for all admitted writes after cancellation or failure, and restore directory timestamps after their descendants finish. Completed directory traversals awaiting writes or metadata are bounded by concurrency; ancestors remain pinned while traversing their children.

On Linux, automatic byte copying also uses the native binding when available. It reads in chunks up to 1 MiB, using smaller buffers for smaller source-size hints, and leaves leading and trailing zero-filled portions of each chunk unwritten in the new file, avoiding their allocation on filesystems that support sparse files. A final size update preserves trailing holes and all-zero files. This path uses reads and writes, without cloning or copy offload; it still reads the full logical contents and does not promise identical sparse extent layout. `clone: "never"` retains the JavaScript byte-copy path.

Clones preserve file contents, empty directories, timestamps, executable modes where supported, and literal symbolic links. Editing a clone does not modify its source. Unsupported filesystem operations fail; callers may choose their own copy or checkout fallback after the failed operation has settled.

Native Windows byte copies can store large zero-filled chunks as sparse ranges when the destination is initially empty and its filesystem supports sparse files. This still reads every source byte and creates an independent copy.

The ReFS backend rejects files with alternate data streams and unsupported reparse-point types instead of silently losing their contents. Symbolic links and junctions are preserved.

XFS and ZFS preserve regular-file and directory modes, timestamps, extended attributes, and ACLs. They reject special files, symlink extended attributes, non-UTF-8 names, and directory nesting deeper than 128 levels. Hardlinked source files become independent reflinked files. Portable byte copying preserves file contents, empty directories, modes where supported, file and directory timestamps, and literal symbolic links; it does not promise ownership, ACL, extended-attribute, alternate-stream, or sparse-layout preservation. On Windows, byte copying rejects unresolved symbolic links because Node does not expose their file/directory link type; resolved links keep their literal target and source type. POSIX dangling links are preserved. Choose a copying policy that meets the caller's metadata requirements; automatic copying can select either path.

`readCloneFileMetadata(files)` asynchronously reads APFS data-stream identities and file metadata, preferring the native batch. On macOS in `auto` or `off`, an unavailable native reader selects a slower built-in system command and warns once. The command invokes the same filesystem query and preserves exact 64-bit clone and inode identifiers; it does not substitute ordinary stat metadata. Large inputs are split into bounded command batches without changing result order. Explicit native `require` rejects a missing addon or reader, and a failed native query is never retried through the command.

Results correspond to input order; missing or unsupported entries return `undefined`. On other known Node platforms, the native reader has no APFS observation, and `auto` or `off` returns the same per-input `undefined` results without requiring the addon. The returned `CloneFileMetadata` includes clone ID, device/inode, size, mode, ownership, and timestamps. These are point-in-time observations, not authorization or proof that later reads remain unchanged. Consumers such as Git index adapters must validate their own content and timestamp invariants. Both backends retain the API's absolute-path normalization and Node's UTF-8 conversion of lone surrogate code units to U+FFFD; they do not follow leaf symbolic links, so an observed link has its own identity and metadata. The portable command requires stock macOS `/usr/bin/osascript`; command launch, timeout, or malformed-response failures reject with `helper-failed` instead of returning fabricated absent metadata. No compiler, Python installation, or additional npm dependency is needed.

## Borrowed FileHandle transfers

`copyFileHandle` from `@openclaw/fs-safe/advanced` copies bytes between two
already-open regular files. Use it when a snapshot or materialization owner
has admitted the source and opened its own destination:

```ts
import { createHash } from "node:crypto";
import { copyFileHandle } from "@openclaw/fs-safe/advanced";

const digest = createHash("sha256");
const bytes = await copyFileHandle(sourceHandle, targetHandle, {
  maxBytes: expectedSize,
  signal: AbortSignal.timeout(30_000),
  onChunk: (chunk) => { digest.update(chunk); },
  assertBeforeMutation: assertSnapshotOwnerCurrent,
});
```

`CopyFileHandleOptions` contains optional `maxBytes`, `signal`, `onChunk`, and
`assertBeforeMutation`. The result is the actual byte count copied through EOF.
The four options are selected once before descriptor inspection; later mutation
of the options object cannot replace the active budget, signal, observer, or
mutation-authority callback.
The byte limit is not a prefix length: excess data rejects with `too-large`,
including data added after admission. Omitted limits are unlimited; Root's
default read cap does not apply. Zero accepts only an empty source. Invalid
limits reject before descriptor inspection.

The source and target must be distinct regular files; exact device/inode
aliases, including two handles to hardlinked names, reject before writing.
Both reads and writes start at position zero and preserve the handles' current
cursors. Existing destination bytes beyond the copied prefix remain intact.
The target must have been opened **without append mode**: some platforms ignore
positional writes on append handles, and Node exposes no portable open-flags
query. Keep both handles open and free of concurrent I/O through settlement.

The synchronous `onChunk` observer sees each source chunk before any target
write for that chunk. It receives a borrowed view reused by later reads; consume
it immediately without retaining or mutating it. This supports source hashing;
it does not verify bytes persisted by the destination. Callers that require a
destination digest must still hash the destination handle afterward. Observer
and authority callbacks may throw; thenable returns reject with `TypeError`
before the affected write. `assertBeforeMutation` runs immediately before every
partial-write submission and must inspect current authority each time.

The helper reuses Root copying's bounded read buffer and completes positive
short reads and writes. JavaScript file transfers use at most 512 KiB of scratch
space, reduced for smaller source-size hints and capped by a finite byte budget
plus its one-byte overflow probe. A zero-progress write rejects with `helper-failed`.
Cancellation is checked before I/O, after source reads, and before each write;
admitted reads and writes settle before rejection. A rejected operation can
leave a copied prefix. There is no rollback or pathname cleanup.

This helper never opens or closes a file, truncates, chmods, syncs, renames, or
publishes it. Source admission, immutability checks, destination preparation,
durability, publication, and failure recovery stay with the caller. Initial
descriptor inspection does not prove that the source remained unchanged while
copying. Keep existing source-fingerprint and publication checks around the
transfer when building snapshot operations.

## Ownership and cancellation

These are low-level operations on caller-owned absolute paths, not Root-relative methods. The source and destination parent must be real directories. The library pins their descriptors and verifies their identities; it does not establish the caller's authorization to use them. Keep the source immutable for the operation, including writes through other aliases, and keep the destination namespace under the caller's control. Literal symlinks in the cloned contents are preserved rather than followed or sanitized.

An already aborted signal prevents dispatch. In-flight cancellation stops cancellable traversal and waits for admitted native writes to finish before rejecting. APFS and Btrfs bulk operations cannot be interrupted once dispatched. An aborted or failed call can therefore leave a destination, including a complete bulk clone. It remains caller-owned; after settlement, the caller decides whether to retain or remove it. Do not start cleanup by racing the cloning promise against an abort promise.

Completion is not a crash-durability guarantee. The API is suitable for reconstructible templates and checkouts; it does not sync every file or replace application-level publication and recovery rules.

Byte copying retains fractional file and directory access/modification timestamps to the precision supported by Node's timestamp APIs and the destination filesystem. This includes dates before 1970 on Unix. On Windows, [Node's unsigned stat seconds](https://github.com/nodejs/node/blob/v26.8.2/src/node_file-inl.h#L93-L104) can report pre-1970 timestamps as dates about 136 years later; byte copying inherits that upstream limitation.

## Platform tests and benchmarks

After building the host native binding, run `pnpm test test/clone.test.ts test/copy-tree.test.ts`. APFS tests can use the normal macOS temporary directory. For Btrfs, ReFS, XFS, or ZFS, set `FS_SAFE_CLONE_TEST_ROOT` to an existing writable directory on that filesystem. The test creates and cleans only its own temporary children. An explicitly configured unsupported directory fails the test rather than silently skipping platform proof. XFS and ZFS metadata tests require the `attr` and `acl` utilities.

Run `node scripts/clone-xfs-proof.mjs MOUNT` on a real XFS volume to verify the public API, hashes, independent writes, and shared physical extents. It requires `filefrag` from `e2fsprogs`. Add `no-reflink` for an XFS fixture formatted with reflinks disabled; strict copying must fail and automatic copying must succeed through byte copying.

Run `node scripts/clone-zfs-proof.mjs MOUNT POOL` on a dedicated, otherwise idle Linux ZFS pool with compression and deduplication disabled. It verifies both `copyTree` and `Root.copyIn` through hashes and changes in the documented `bclonesaved` pool counter. It requires `zfs`, `zpool`, and `findmnt`, including permission to run `zpool sync`. Add `no-reflink` for a pool without block cloning to verify strict refusal and automatic byte fallback. The script creates and removes only its temporary directory; it does not create pools or change their properties.

Run `node benchmarks/clone.mjs SOURCE DESTINATION_PARENT` after `pnpm build` to compare one, four, and 16 workers on the same immutable source. Add `3 auto` or `3 never` to measure three samples of ordinary copying, including NTFS destinations. It records copying time separately from fixture preparation and full file-hash verification, and retains its uniquely named output directory for inspection. Prepare Btrfs sources with `createCloneSource` first.
