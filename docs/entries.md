# Directory entries

`Root.entries()` observes one directory at a time. Use it when the application
owns traversal order or must inspect symlinks itself, such as an installer that
validates selected dependency links or a manifest builder that rejects all links.

```ts
import { root } from "@openclaw/fs-safe";

const workspace = await root("/srv/workspace");
for await (const entry of workspace.entries("plugins", {
  maxEntries: 1_000,
  signal: AbortSignal.timeout(5_000),
})) {
  if (entry.isSymbolicLink) {
    throw new Error(`unexpected link: ${entry.name}`);
  }
  console.log(entry.name, entry.size);
}
```

## API

```ts
interface Root {
  entries(relativePath: string, options?: RootEntriesOptions): AsyncIterableIterator<DirEntry>;
}

type RootEntriesOptions = {
  maxEntries?: number;
  order?: "filesystem" | "sorted";
  signal?: AbortSignal;
  symlinks?: "reject" | "follow-within-root" | "follow-parents-within-root";
};
```

Each result is the existing [`DirEntry`](types.md) shape: a basename and advisory
`lstat` metadata, including `isFile`, `isDirectory`, `isSymbolicLink`, `size`,
`mode`, `nlink`, `dev`, and `ino`. Entries are immediate children; the iterator
never descends. An empty path or `"."` selects the root directory.

Child symlinks are always reported without following them, including dangling
links and links whose targets lie outside the root. Their metadata describes
the link, not its target. Hardlinked files are also reported regardless of the
Root's read hardlink policy. Reporting a name grants no read or mutation access.
Use the Root operation methods when consuming or changing an entry.

The `symlinks` option applies only to the path of the selected directory. It
inherits the Root's read policy and defaults to `"reject"`. The two follow
policies allow only contained aliases; `"follow-parents-within-root"` also
rejects a link as the final directory component. Child-link reporting is
independent of this path policy.

## Work limits and ordering

`maxEntries` is an optional non-negative safe integer. Every child counts,
including directories, symlinks, special files, and entries the caller later
ignores. Omit it to leave the count unbounded. An empty directory satisfies a
zero limit. Exceeding the limit throws `FsSafeError` with code `"too-large"`;
there is no silent truncation or success marker for a partial scan.

The default `order: "filesystem"` reads names incrementally in the filesystem's
nondeterministic order. It observes one child's metadata per iterator step,
with one name of lookahead to distinguish an exact limit from an overflow.
Entries already yielded before overflow remain partial observations. A caller
that stops early has not established that the whole directory fits the limit.

`order: "sorted"` collects names first and orders them with JavaScript's default
string sort, not locale collation. With `maxEntries`, names are collected from
a bounded directory stream; overflow rejects before yielding any entries or
requesting their full metadata. Without a limit, sorted mode enumerates the
complete name list. Metadata is observed only as each sorted entry is consumed.
Applications that need locale-specific ordering can collect with an explicit
limit and apply their own comparator.

The count bounds logical directory reads and fs-safe metadata requests. Node
may classify a directory entry with `lstat` when the filesystem omits type
information, including the single lookahead entry. It does not bound elapsed
time for an individual filesystem operation or the size of one filename.

Cancellation is checked before setup and around awaited work. Directory
handles close on completion, overflow, cancellation, failure, and early
`break` or iterator return. In-flight filesystem work settles before rejection;
an individual syscall cannot be interrupted. If iteration and disposal both
fail, a `SuppressedError` retains the close failure in `error` and the original
failure in `suppressed`.

## Identity and caller responsibilities

The iterator reuses Root's guarded directory-listing owner. It validates the
selected path, pins exact Root and directory identities, and checks them around
directory observations, including after control returns from the caller. A
replaced directory rejects instead of continuing under the replacement.

These are pure-Node, best-effort checks. The iterator does not hold descriptors
for every path component and cannot sandbox a hostile process that repeatedly
swaps and restores directories. Results are not an atomic snapshot, an exact
identity receipt, or permission to use the name later. Contents and metadata
can change between entries; a removed entry may cause iteration to reject.
Use an admitted descriptor for metadata and hashing that must refer to the same
opened file, and keep snapshot consistency or cooperative locking with its
application owner.

Traversal strategy, global budgets, ignored names, and approved external peers
remain application policy. A per-directory physical-entry limit cannot replace
a global file-only or unique-directory budget. Full metadata also requires a
child `lstat`; a caller that previously needed only `Dirent` types should assess
that cost. `Root.walk()` remains the recursive option for its supported link,
pruning, and error policies; `Root.list()` returns an eager advisory listing.
