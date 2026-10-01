# root()

`root()` is the primary entry point. It takes a trusted directory and returns a capability-style `Root` handle whose methods accept relative paths and refuse to escape the directory.

```ts
import { root } from "@openclaw/fs-safe";

const fs = await root("/srv/workspace", {
  hardlinks: "reject",
  symlinks: "reject",
  mkdir: true,
});
```

## Signature

```ts
function root(rootDir: string, defaults?: RootDefaults): Promise<Root>;

type RootDefaults = {
  assertBeforeMutation?: () => void; // synchronous caller authority check at mutation dispatch
  durable?: boolean;               // fsync write/create/writeJson/createJson/append/copyIn; default true
  hardlinks?: "reject" | "allow";  // refuse files with nlink > 1 on read; defaults to "reject"
  denyMutations?: DenyMutationPolicy; // absolute paths/prefixes mutation methods may not change
  maxBytes?: number;               // refuse reads larger than this many bytes; defaults to 16 MiB
  mkdir?: boolean;                 // create missing parent dirs on write/openWritable/append; default true
  mode?: number;                   // requested file mode; per-call override available
  renameIdentity?: "strict" | "verify-content-with-lock"; // default "strict"
  symlinks?: "reject" | "follow-within-root" | "follow-parents-within-root"; // read policy
  mutationSymlinks?: "reject" | "follow-parents-within-root"; // opt-in mutation policy
};

type DenyMutationPolicy = {
  paths?: readonly string[];
  prefixes?: readonly string[];
};
```

`root()` resolves the directory through the real filesystem. A symlinked input becomes the canonical path; a non-existent root throws `FsSafeError` with code `not-found`, and malformed or non-directory roots throw `invalid-path`.

The root directory is pinned with exact bigint device/inode identities. A changed root rejects subsequent operations; an unknown Windows identity that remains unverifiable after bounded reinspection rejects construction with `path-mismatch`.

`defaults` apply to every method on the returned handle. Per-call options on individual methods override the defaults for that call only, except `denyMutations` and `assertBeforeMutation`: deny entries are merged, and the root assertion runs before the per-call assertion. A call cannot clear either root-level restriction.

Every `maxBytes` value must be a non-negative safe integer or positive `Infinity`. Zero is an active zero-byte cap; `Infinity` explicitly disables the cap. An omitted or explicitly `undefined` per-call value preserves the configured Root default instead of clearing it.

## The `Root` interface

Every method on the returned handle accepts paths relative to the root and rejects anything that would escape it.

Explicit path, data, and copy-source arguments select the operation. Properties
with those names in an options object do not replace them; a supplied source
Root retains ownership of source admission and read policy.

### Reads

```ts
fs.read(rel, options?)         // { buffer, containment, realPath, stat }
fs.readBytes(rel, options?)    // Buffer
fs.readText(rel, options?)     // string
fs.readJson<T>(rel, options?)  // parsed T
fs.open(rel, options?)         // { handle, containment, realPath, stat, [Symbol.asyncDispose] }
fs.readAbsolute(absPath, options?) // ReadResult; absPath must already be inside the root
fs.reader(options?)            // (path) => Promise<Buffer>; useful for loader APIs
fs.walk(rel, options)          // root-bounded AsyncIterable<{ relativePath, kind, size }>
```

`walk()` is the root-bounded recursive iterator, with budgets, cancellation,
and symlink/filter policies. Default `order: "sorted"` enumerates and sorts all
names in each directory even with an entry budget; use `order: "filesystem"`
for bounded memory in wide directories. See [Root-bounded walking](walk.md#root-bounded-async-iteration)
for truncation, callback, and directory-error contracts.

`open()` returns a Node `FileHandle` for streaming. Prefer `await using` for cleanup:

```ts
await using opened = await fs.open("large.log");
{
  for await (const chunk of opened.handle.createReadStream()) {
    process.stdout.write(chunk);
  }
}
```

`open()`, `read()`, and `openWritable()` results include
`containment: "best-effort"`. The field reports the mechanism used; see the
[security model](security-model.md#containment-guarantees-by-platform).

The read methods also accept an absolute spelling that already resolves inside
the root. `readAbsolute()` and `reader()` make that intent explicit and accept
both the configured root spelling and its canonical real path when the Root was
created through a directory symlink or Windows junction. An absolute path
outside the root is still rejected. On Windows, alternate casing is accepted
only when the differently cased Root prefix has the Root's exact directory
identity; the operation then continues under the trusted Root spelling.
Absolute paths keep literal `~` components: `readAbsolute("/srv/root/~/file")`
reads that entry under the root, without expanding the user's home directory.
Relative `~/file` inputs still expand the home directory and must remain inside
the Root; use `./~/file` for a literal relative `~` directory.

### Writes

```ts
fs.write(rel, data, options?)            // overwrite-ok atomic write
fs.create(rel, data, options?)           // throws "already-exists" if target exists
fs.writeJson(rel, value, options?)       // JSON.stringify + atomic write
fs.createJson(rel, value, options?)      // create() variant of writeJson
fs.append(rel, data, options?)           // append text/buffer; syncs before close by default
fs.copyIn(rel, sourceAbsPath, options?)  // copy from outside the root, atomically, with size cap
fs.openWritable(rel, options?)           // FileHandle for streaming writes; supports await using
fs.move(from, to, options?)              // rename within the root; native-backed no clobber by default
fs.remove(rel, options?)                 // unlink file, rmdir, or bounded recursive removal
fs.mkdir(rel, options?)                  // mkdir -p (creates missing parents)
fs.ensureRoot(options?)                  // accepts "" / "." as the root itself
```

Mutation options control parent creation, modes, durability, and publication.
`write`, `create`, `append`, `writeJson`, `createJson`, and `copyIn` inherit
`durable` from Root defaults (normally `true`); `false` skips synchronization
without changing publication or identity checks. See [write options](writing.md#write-options)
for precedence and platform behavior, and [append](writing.md#write-verbs)
for newline handling and creation modes.

`mkdir`, `ensureRoot`, `create`, and `createJson` accept `private: true`; see
[Creation](creation.md) for permission checks and native requirements.
Buffered `create` and `createJson` support [atomic publication](writing.md#atomic-buffered-creation)
and `durable: "file"`; `create` also supports [streamed input](writing.md#streamed-creation).

`copyIn` accepts a trusted absolute path or another Root as its source, with
byte limits, cloning, cancellation, and publication receipts. See the complete
[copy contract](writing.md#write-verbs); a rejected copy
can still leave a completed destination after publication.

Root operations that choose a new destination reject a leading Windows
drive-relative spelling such as `C:name` on every platform. This applies to
`write`, `create`, `append`, `openWritable`, `mkdir`, `copyIn`, and the
destination argument of `move`. In particular, `copyIn(path.basename(source),
source)` can reject a legal POSIX basename such as `c:photo.png`; callers that
derive portable destination names from host files must sanitize or map that
basename first.

On Windows, every Root pathname admission also rejects NTFS alternate-data-stream
and directory-index aliases: relative names containing `:`, or absolute names
with a colon beyond the single rooted drive designator, fail with
`invalid-path` before filesystem access. This includes spellings such as
`file:stream`, `dir::$INDEX_ALLOCATION`, and `dir:$I30:$INDEX_ALLOCATION`.
Rooted drive, UNC, and extended-drive paths keep their existing handling, and
the separate device/network policies remain in force. Ordinary colon-bearing
names remain valid on POSIX where the operation's existing drive-relative rule
does not otherwise reject them.

`openWritable` opens a writable file with options `mode?: number` and `writeMode?: "replace" | "append" | "update"`. `replace` truncates existing files and is the default; `update` keeps existing contents. Before truncation or handle return, descriptor and pathname identities are compared with lossless bigint metadata; persistently unknown Windows identities fail closed. The returned `stat` remains an ordinary numeric Node `Stats` object. Use it for streaming output. Prefer `await using` for cleanup.

`remove` leaves non-empty directories unchanged unless `recursive: true`.
Recursive removal defaults to filesystem order, `maxEntries: 100_000`, and
`maxDepth: 64`. It is incremental: budget, cancellation, policy, or identity
failures can leave a partially removed tree. See [removal](writing.md#write-verbs)
for ordering, symlink, and failure semantics.

### Live mutation authority

All mutation methods accept `assertBeforeMutation?: () => void`. Use it when a
lease, operation owner, or cancellation state can expire while filesystem
preparation is awaiting I/O:

```ts
const controller = new AbortController();
await fs.write("config.json", "{}\n", {
  assertBeforeMutation: () => controller.signal.throwIfAborted(),
});
```

The callback runs synchronously after awaited preparation, immediately before
each Root-owned mutation is dispatched: parent creation, file creation and
content writes (including private staging and streamed chunks), publication,
truncation, append, move, and removal. Buffered writes use bounded chunks and
recheck before every partial-write submission; file removal submits a direct
unlink request. Native calls that perform multiple filesystem steps are one
dispatch. No asynchronous wait separates the check
from that dispatch. A thrown value rejects the operation unchanged; a Promise,
thenable, or synchronous or asynchronous generator result rejects with `TypeError`
before that mutation. Returned generators are never advanced. Other synchronous
return values are ignored. Generator detection applies to generator objects
themselves, not proxy wrappers. Callbacks can run multiple times and must inspect
current authority during each call; return-value validation does not establish it.
Directory creation rechecks the retained parent after the callback and before
submitting mkdir, so a replacement is rejected before creating that component.
Overwrite moves recheck the retained root, parents, source identity and both
routes after the callback, including destination parents that were missing
during preparation. Removals recheck cancellation, retained ancestry and exact
leaf identity before dispatch; `force` tolerates a missing leaf, not replaced
ancestry. Removing an admitted hardlink still leaves its other names intact.

Already dispatched I/O cannot be revoked. Identity-checked cleanup, final
permissions, and durability finish under the existing operation owner even
after authority expires. Sidecar lock acquisition, recovery, and release for
`renameIdentity: "verify-content-with-lock"` are lock bookkeeping outside this
callback; content mutations still recheck after the lock is acquired. An
operation may leave already-created parent directories when a later check
rejects. A no-op such as `ensureRoot()` on the existing root does not require a
callback invocation. This is a dispatch fence, not a filesystem transaction or
a replacement for root confinement.

If cleanup also fails or cannot prove ownership of an entry, the existing
structured cleanup error takes precedence and retains the authority refusal
as its cause.

For `openWritable()`, the callback covers the library's parent creation,
exclusive creation, and truncation. The returned raw `FileHandle` belongs to
the caller, which must check authority before its own later writes.

All mutation methods accept `denyMutations?: { paths?: string[]; prefixes?: string[] }`. Entries must be absolute paths. `paths` blocks those exact paths; `prefixes` blocks those paths and their descendants. fs-safe preserves path strings exactly and canonicalizes through existing ancestors before comparing, so a symlinked ancestor to a denied location is still denied. Missing suffixes also match prospective case and canonical Unicode normalization aliases: case-folding and Unicode NFC/NFD-equivalent spellings cannot bypass a denied path or prefix. A read-only observation of the existing parent can establish that ASCII case variants are distinct. Admission never creates temporary probe files or directories. If sensitivity cannot be established (including empty or unreadable parents, future directories, and Unicode normalization), equivalent suffixes are denied conservatively, even on a filesystem that would allow distinct names. Distinct existing canonical ancestors and unrelated names remain distinct. Observations are local to each synchronous policy check and are refreshed after callbacks or mutations. This conservative fallback does not model other filesystem-specific equivalences, such as HFS+ ignorable formatting characters.

Denied mutations throw `FsSafeError` with code `denied-path`. Use this for caller-specific sensitive paths, not as a replacement for the root boundary, symlink, or hardlink checks.

`move()` snapshots its merged default and per-call mutation policy before
asynchronous preparation. Later changes to the original policy objects or arrays
apply to subsequent calls. Use `assertBeforeMutation` for live revocation of an
in-flight move.

For writes, creates, streams, and copies, parent creation admits the prospective
file and each missing directory before creating that directory, including on the
Windows native route. An exact deny on an existing parent does not prevent using
that parent to write an allowed child. If a deeper missing parent is denied,
earlier admitted directories may remain; the denied directory and file are not
created. With `mkdir: false`, missing parents are never created. Native Windows
policy-aware creation requires the direct-child helper and fails with
`helper-unavailable` if it is absent.

All mutation methods also accept `mutationSymlinks`. `"reject"` rejects symlink
components; `"follow-parents-within-root"` resolves contained parent directory
aliases but rejects the final component if it is a symlink, including a dangling
link. Missing parent directories can still be created through a contained alias.
`move()` applies the policy to both source and destination. An omitted value
preserves existing behavior, including `remove()` unlinking a final symlink.
The read-only `symlinks` default does not change mutation behavior.

### Inspection (advisory)

```ts
fs.exists(rel)                   // boolean
fs.stat(rel)                     // PathStat
fs.list(rel)                     // string[]
fs.list(rel, { withFileTypes })  // DirEntry[]
fs.entries(rel, options?)        // nonrecursive AsyncIterable<DirEntry>, including symlinks
fs.resolve(rel)                  // absolute path inside the root, after canonicalization
```

Directory enumeration (`list`, `entries`, and `walk`) requires UTF-8 filenames.
A discovered name that cannot be represented losslessly as a JavaScript string
rejects with `invalid-path`, before looking up metadata through that name.
Streaming traversal may already have yielded earlier entries. Literal Unicode
replacement characters (`U+FFFD`) remain valid names.

These do not pin a later operation. During `stat()`, the exact selected target and
parent are checked around metadata collection; `list()` checks one exact selected
directory around the complete name/metadata batch instead of repeating containment
work for every child. A detectable redirection rejects with `path-mismatch` rather
than returning names or metadata from the replacement. Results remain advisory
after the call returns, so use the verb methods for the actual read or write.

`entries()` streams immediate children in filesystem order by default. It
supports cancellation, a physical-entry limit that throws on overflow, and
bounded sorted-name collection. It reports child symlinks without following
them; its `symlinks` option applies only to the selected directory path.
See [Directory entries](entries.md) for ordering, identity, and partial-result
semantics.

`resolve()` is the exception to the existing-object rule: because it selects a
location for later use, it rejects a leading drive-relative spelling. Reads,
`stat`, `exists`, `list`, `entries`, `walk`, `remove`, and the source argument of `move`
accept an existing POSIX filename such as `c:notes.txt`. For `move`, only the
new destination name is subject to the portable guard.

## Native helper mode

Create-only writes prefer the platform native helper for fd-relative opens and
atomic no-replace rename. Operations without native wiring retain their guarded
JavaScript implementations.

```ts
import { configureFsSafeNative } from "@openclaw/fs-safe/config";

configureFsSafeNative({ mode: "off" });     // guarded JavaScript path
configureFsSafeNative({ mode: "require" }); // fail if the binding is unavailable
```

`auto` is the default. Configure the mode before creating roots. See the
[native helper policy](native-helper.md) for supported platforms, the native
surface, and the precise fallback boundary.

### Properties

```ts
fs.rootDir       // the directory you passed in
fs.rootReal      // its canonical real path (after symlink resolution)
fs.rootWithSep   // rootReal with a trailing separator, for prefix comparisons
fs.defaults      // the RootDefaults you passed
```

The path properties are readonly metadata. Each Root retains the canonical
directory and exact identity admitted when it was created; changing object
properties is not a supported way to retarget it. Create another Root to use a
different directory. The `defaults` reference is readonly, while the supplied
object's option values remain live for later calls.

## Failure semantics

Boundary and policy failures throw `FsSafeError` with a `code`. Parsing callbacks
and underlying filesystem operations can also surface `SyntaxError` or native
`NodeJS.ErrnoException` values. Branch on `err.code`, not message text, after
checking `err instanceof FsSafeError`. Common fs-safe codes:

| Code | When it fires |
|---|---|
| `invalid-path` | The input path is malformed, including embedded NUL bytes. Portable relative-path helpers and `FileStore` keys reject drive-relative segments; Root destination and resolution operations reject a leading drive-relative spelling such as `C:name`. |
| `outside-workspace` | The input resolves outside the root, or contains a `..` segment that would escape it. |
| `not-found` | The target does not exist (or its parent does not, with `mkdir: false`). |
| `not-file` | A read or copy targeted a non-regular file (directory, FIFO, socket, …). |
| `device-path` | A read/open target is a known unsafe device or process-fd path. |
| `already-exists` | `create()` or `move()` without `overwrite` hit an existing target. |
| `denied-path` | A mutation target matched `denyMutations.paths` or `denyMutations.prefixes`. |
| `symlink` | A path component is a symlink, and the call's `symlinks` policy is `reject`. |
| `hardlink` | The target's `nlink > 1` and `hardlinks` policy is `reject`. |
| `path-mismatch` | Post-open identity check failed — the opened fd does not match the resolved path. |
| `too-large` | Read exceeded `maxBytes`. |

Full list in the [Errors](errors.md) reference.

## Defaults vs per-call options

Defaults reduce repetition; per-call options handle exceptions:

```ts
const fs = await root("/srv/workspace", {
  symlinks: "reject",
  hardlinks: "reject",
  mkdir: true,
});

// Default: symlinks rejected.
await fs.readText("config.toml");

// One specific path needs to follow a symlink that lands inside the root.
await fs.readText("links/current.log", { symlinks: "follow-within-root" });
```

With `follow-within-root`, parent components after a symlink are applied to the
symlink's resolved target. Reads use that checked canonical path, including
after home expansion and through `readAbsolute` and `reader`; the default policy still rejects a symlink
even when a later `..` would hide it in a purely lexical normalization.

Use `follow-parents-within-root` when directory aliases are allowed but a final
file symlink should fail. Set each policy at the root to share that contract
between reads and mutations:

```ts
const workspace = await root("/srv/workspace", {
  symlinks: "follow-parents-within-root",
  mutationSymlinks: "follow-parents-within-root",
});
await workspace.readText("directory-alias/notes.txt");
await workspace.write("directory-alias/notes.txt", "updated\n");
```

The library uses the resolved parent for the operation and checks the final
component again before publication or removal. These checks preserve the existing
[platform containment guarantees](security-model.md#symlinks-write-side);
they do not make check-and-rename atomic against another process. Callers do not
need a separate `realpath()` or final `lstat()` preflight.

For methods that accept absolute paths, the same final-component rule applies
when a path enters the root through an alias outside its lexical spelling. A directory alias may
lead to a regular file inside the root; an absolute final file or directory
symlink is rejected before its canonical target replaces the original path.

Text helpers default to UTF-8. Pass `encoding` per call to `readText`, `readJson`, `write`, `create`, or `append` when you need another encoding.

## Common patterns

### Read-only loader

```ts
const fs = await root("/srv/workspace", { symlinks: "reject", hardlinks: "reject" });
const load = fs.reader();
const a = await load("notes/today.txt");        // relative
const b = await load("/srv/workspace/state.bin"); // absolute, but inside the root
```

`fs.reader()` returns a `(path) => Promise<Buffer>` callback. Useful when wiring `fs-safe` into APIs that accept a generic loader function. Absolute paths outside the root are rejected with `outside-workspace`.

### "Touch only if missing" seeding

Use `create()` and handle `already-exists` so existing configuration wins;
see the [seeding example](writing.md#write-verbs).

### Replace + verify

```ts
await fs.write("state.json", JSON.stringify(state, null, 2));
const echoed = await fs.readJson<State>("state.json");
assertDeepEqual(echoed, state);
```

`write` is atomic, so the file is either old or new — never half-written. Re-reading lets you detect a parallel writer, if one exists.

## See also

- [Reading](reading.md) — read variants in depth, plus stream patterns.
- [Writing](writing.md) — write/create/move/remove in depth.
- [pathScope()](path-scope.md) — the same boundary semantics over an absolute path you already trust.
- [Atomic writes](atomic.md) — the lower-level helpers used by `fs.write`.
- [Errors](errors.md) — the closed code union you'll be catching.
