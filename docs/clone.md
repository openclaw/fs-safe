# Native directory cloning

`@openclaw/fs-safe/clone` materializes independent directory trees using filesystem copy-on-write primitives. It requires a native binding and a supported filesystem; it never substitutes an ordinary byte copy when cloning is unavailable.

```ts
import { cloneTree, createCloneSource, probeTreeClone } from "@openclaw/fs-safe/clone";

const parent = "/srv/worktrees";
const backend = probeTreeClone(parent);
if (backend) {
  const template = `${parent}/template`;
  await createCloneSource(template);
  // Populate this caller-owned template, then keep its contents unchanged.
  await cloneTree(template, `${parent}/checkout`, { signal: AbortSignal.timeout(60_000) });
}
```

## Filesystems

| Backend | Operation                                                  | Source preparation                                                                                                          |
| ------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `apfs`  | One native directory clone                                 | `createCloneSource` creates an empty directory.                                                                             |
| `btrfs` | One native writable subvolume snapshot                     | `createCloneSource` creates a subvolume; an ordinary directory is not a snapshot source. No `btrfs` executable is required. |
| `refs`  | Native directory traversal with parallel file block clones | `createCloneSource` creates an empty directory on ReFS, including Dev Drive volumes.                                        |

Source and destination must be on a filesystem that supports cloning between them. The source repository used to populate a template can live elsewhere. ReFS shares file data rather than the whole directory metadata tree, so creating many small files still has a cost.

Btrfs preserves native subvolume snapshot semantics: nested subvolume contents are not included. Prepare source-only templates without nested subvolumes. This API does not recursively snapshot a hierarchy of subvolumes.

### APFS permissions

APFS directory cloning does not guarantee descendant ACL preservation. With the `CLONE_ACL` flag used here, live macOS testing preserved the source root's ACL but dropped an explicit ACL on a source descendant. Destination ACL inheritance was also omitted below the cloned root. `probeTreeClone` checks filesystem support only; neither it nor `cloneTree` checks whether these ACL semantics meet the caller's permission policy. A successful clone is not proof of source ACL preservation or normal file-creation inheritance throughout the tree.

Callers that require source ACL preservation or destination ACL inheritance must use a creation path that preserves their permission policy. For example, a private Git template cache can prohibit custom descendant ACLs and decline cloning when the destination parent has inheritable ACL entries, the template root carries ACLs, or ACL inspection fails; it must also account for policy changes during cloning. Checking only the source root cannot establish that an arbitrary tree has no descendant ACLs. This library does not inspect or repair ACLs after a clone.

Apple [strongly discourages general directory cloning](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/man/man2/clonefile.2). The [XNU directory-clone authorizer notes unfinished descendant ACL inheritance](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/vfs/vfs_subr.c#L8879); this is one verified limitation, not Apple's stated complete rationale. The bulk operation remains useful for controlled, immutable templates whose callers accept its metadata semantics.

## API

`TreeCloneBackend` is the `"apfs" | "btrfs" | "refs"` union returned by the probe. `CloneTreeOptions` contains the optional `signal` and `concurrency` arguments.

`probeTreeClone(parentPath)` synchronously inspects an existing directory and returns `"apfs"`, `"btrfs"`, `"refs"`, or `undefined`. It creates no probe artifacts. An unavailable native binding produces `undefined` in automatic mode; the package's explicit native `require` mode still reports a missing binding as an error.

`createCloneSource(destination, { signal? })` creates an empty cloneable source. Its parent must already exist and the destination must be absent.

`cloneTree(source, destination, { signal?, concurrency? })` clones a directory into an absent destination. Existing destinations are never merged or overwritten. The destination must be outside the source tree. ReFS uses 16 workers by default; `concurrency` accepts integers from 1 through 32. APFS and Btrfs use their bulk operation and do not need worker parallelism.

Clones preserve file contents, empty directories, timestamps, executable modes where supported, and literal symbolic links. Editing a clone does not modify its source. Unsupported filesystem operations fail; callers may choose their own copy or checkout fallback after the failed operation has settled.

The ReFS backend rejects files with alternate data streams and unsupported reparse-point types instead of silently losing their contents. Symbolic links and junctions are preserved.

`readCloneFileMetadata(files)` asynchronously reads APFS data-stream identities and file metadata in one native batch. Results correspond to input order; missing or unsupported entries return `undefined`. The returned `CloneFileMetadata` includes clone ID, device/inode, size, mode, ownership, and timestamps. These are point-in-time observations, not authorization or proof that later reads remain unchanged. Consumers such as Git index adapters must validate their own content and timestamp invariants. The reader does not follow leaf symbolic links.

## Ownership and cancellation

These are low-level operations on caller-owned absolute paths, not Root-relative methods. The source and destination parent must be real directories. The library pins their descriptors and verifies their identities; it does not establish the caller's authorization to use them. Keep the source immutable for the operation, including writes through other aliases, and keep the destination namespace under the caller's control. Literal symlinks in the cloned contents are preserved rather than followed or sanitized.

An already aborted signal prevents dispatch. In-flight cancellation stops cancellable traversal and waits for admitted native writes to finish before rejecting. APFS and Btrfs bulk operations cannot be interrupted once dispatched. An aborted or failed call can therefore leave a destination, including a complete bulk clone. It remains caller-owned; after settlement, the caller decides whether to retain or remove it. Do not start cleanup by racing the cloning promise against an abort promise.

Completion is not a crash-durability guarantee. The API is suitable for reconstructible templates and checkouts; it does not sync every file or replace application-level publication and recovery rules.

## Platform tests and benchmarks

After building the host native binding, run `pnpm test test/clone.test.ts`. APFS tests can use the normal macOS temporary directory. For Btrfs or ReFS, set `FS_SAFE_CLONE_TEST_ROOT` to an existing writable directory on that filesystem. The test creates and cleans only its own temporary children. An explicitly configured unsupported directory fails the test rather than silently skipping platform proof.

Run `node benchmarks/clone.mjs SOURCE DESTINATION_PARENT` after `pnpm build` to compare one and 16 workers on the same immutable source. It records copying time separately from fixture preparation and full file-hash verification, and retains its uniquely named output directory for inspection. Prepare Btrfs sources with `createCloneSource` first.
