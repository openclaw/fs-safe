# Temp workspaces

`@openclaw/fs-safe/temp` is the stable temp surface: private temp **workspaces** with auto-cleanup plus the secure per-user temp root the helpers default to.

```ts
import {
  tempWorkspace,
  withTempWorkspace,
  tempWorkspaceSync,
  withTempWorkspaceSync,
  resolveSecureTempRoot,
} from "@openclaw/fs-safe/temp";
```

## Private temp workspaces

A private workspace is a uniquely named directory under a caller-provided temp
root. The default requested mode is `0o700`. Calling `cleanup()` or leaving an
`await using` scope moves an unchanged workspace through a private quarantine
before removal. Descriptor-bounded cleanup prevents recursive traversal of
substitutions; the compatible JavaScript fallback has the narrower race
contract documented below.

On POSIX, workspace creation verifies the supplied root and its canonical
ancestors before creating a child. Each existing directory must be owned by the
effective user or root. Group/world-writable directories must also have the
sticky bit, so ordinary system temp directories remain usable without changing
their modes. Foreign-owned directories and non-sticky writable ancestors reject
with `not-owned` or `insecure-permissions`; unavailable effective-user identity
rejects with `permission-unverified`. Existing supplied directories keep their
permissions. Missing root components are created at `0o700` and initialized
from their first exact security snapshot; if a restrictive umask changes that
mode, correction uses a verified directory descriptor.
An initial mode-descriptor admission error is preserved if closing that rejected
descriptor also fails; close failures after successful admission remain reportable.

For an already existing canonical root, discovery retains only its immutable
exact identity. Cleanup-parent retention is provisional: after any native
capability probe, creation captures and validates the complete ancestry,
re-observes the root against discovery, and associates the retained parent
descriptor. Async creation and sync creation outside the Linux/macOS
direct-mode case dispatch `mkdtemp` immediately after that synchronous boundary
without another yield or native probe. Existing aliases and missing-component
roots keep the guarded admission route.

On Linux and macOS, synchronous creation can instead use an exclusive six-character
random child name when an explicit requested mode other than `0o700` has owner
`rwx`, no special bits, and no group/world write bits. The requested mode is
passed directly to `mkdir` and the observed complete permission bits, rather
than the requested bits, are authoritative. Umask, inherited ACL state, or
inherited special bits can make that observation differ, in which case creation
corrects the mode through the retained descriptor. This mode-based optimization
does not claim that Linux and macOS have identical syscall or ACL behavior, and
POSIX mode bits do not establish ACL privacy. Creation makes at most 64 attempts;
after a name collision, each retry generates its candidate first, replays the
already admitted immutable ancestry and descriptor receipts, and then
immediately attempts exclusive creation. A colliding entry is never inspected,
adopted, corrected, registered, or deleted. The default `0o700`, async creation, and
other sync modes retain the `mkdtemp` path. That path requests initial mode
`0o700`; a result different from `dirMode` is initialized through the same
descriptor-bound correction.

The direct sync path opens the new child without following its final component
and captures one exact descriptor observation after the parent replay. The new
child's exact identity, type, owner, private bits, and complete `0o7777` mode are
checked before mode initialization. When its creation mode already
matches `dirMode` (including the default `0o700`), creation avoids an extra mode
descriptor and chmod. If the observed creation mode differs from `dirMode`, the
immediate synchronous correction consumes that one-shot observation, checks the
fresh child name, replays the parent, and applies correction through the retained
descriptor. Later admission always performs fresh descriptor and name checks.
Permission failures propagate. POSIX `dirMode`
must not grant group/world write access; it only controls the new workspace,
not existing supplied directories. After the
first exact child observation, final adoption retains a no-follow child
descriptor, rechecks complete ancestry and retained cleanup-parent authority,
and then validates the original child's descriptor and current name for exact
identity, owner, private bits, and requested mode before cleanup is registered.
Linux and macOS may replay exact identities through round-trip-safe nonnegative
numeric `dev`/`ino` projections. Initial receipts that cannot be represented
exactly stay on the BigInt path; a malformed or mismatched numeric replay fails
closed without an exact retry.
Parent or child replacements observed during creation reject before cleanup
ownership is registered. Unverified artifacts are left in place for
caller-directed recovery.

On Windows, POSIX mode/UID metadata does not establish ACL privacy, and these
factories neither claim nor initialize a POSIX `dirMode`; every requested value
uses the identity-only path without opening a mode descriptor or applying chmod.
Callers must supply a root with trusted ACLs that protect its children and
ancestors; exact pathname identity checks still apply. `cleanupSafety` controls
removal capability, not Windows ACL admission.

Root aliases already present at entry retain their historical support and are
canonicalized. Callers remain responsible for choosing trusted root paths and
excluding hostile peers with the same filesystem authority. Node's pathname
`mkdir`/`mkdtemp` calls do not atomically return a creation descriptor: identity
checks detect observed substitutions but cannot prove provenance against every
same-privilege replacement before the first observation. Descriptor chmod
cannot be redirected to a subsequently substituted pathname. Native bounded
cleanup does not upgrade the creation operation to an atomic namespace boundary.

### `tempWorkspace`

The compact factory. Returns:

```ts
type TempWorkspace = {
  dir: string;
  identity: { dev: number | bigint; ino: number | bigint };
  store: FileStore;
  path(fileName: string): string;
  write(fileName: string, data: string | Uint8Array): Promise<string>;
  writeText(fileName: string, data: string): Promise<string>;
  writeJson(fileName: string, data: unknown, options?: { trailingNewline?: boolean }): Promise<string>;
  copyIn(fileName: string, sourcePath: string): Promise<string>;
  read(fileName: string): Promise<Buffer>;
  cleanup(): Promise<"removed" | "missing" | "identity-mismatch" | "indeterminate">;
  [Symbol.asyncDispose](): Promise<void>;
};
```

```ts
import { tempWorkspace } from "@openclaw/fs-safe/temp";

await using workspace = await tempWorkspace({ rootDir: "/tmp/my-app", prefix: "build-" });
const inputPath = await workspace.write("input.txt", "data");
await runBuild(workspace.dir, inputPath);
```

`write` writes at `mode` (default `0o600`); `writeText` and `writeJson` are convenience wrappers for the common scratch-file shapes; `copyIn` ingests an absolute source path through the same atomic-rename machinery as `Root.copyIn`. `read` is a small accessor that reads back any file you wrote into the workspace.
Both the async and sync `read` methods throw `FsSafeError("not-file")` when the
named leaf is a directory or another non-regular target, and preserve the
`not-found`, `hardlink`, or `symlink` code for those stable target states.
Operational filesystem read failures use `read-failed` with the Node error in
`cause`.

`store` is a `fileStore({ rootDir: workspace.dir, private: true })` handle. Use
it when you want the richer store surface, including `writeStream`, `exists`,
`remove`, `readJsonIfExists`, or `store.json<T>(rel)`:

```ts
await using workspace = await tempWorkspace({ rootDir: "/tmp/my-app", prefix: "build-" });
const state = workspace.store.json<State>("state.json");
await state.write({ ready: true });
```

The workspace owns cleanup; the store is only a view over the workspace
directory.

**Compatibility and security:** workspace creation remains available in native
`auto`, `off`, and unavailable-native environments. The default
`cleanupSafety: "compatible"` preserves the JavaScript cleanup behavior from
0.6: it verifies the workspace identity, moves the public name to a fresh
`.fs-safe-workspace-cleanup-<uuid>` sibling, verifies that quarantine, and then
uses guarded pathname-recursive removal. This fallback never recursively
removes the public workspace name, but it is not atomic conditional deletion: a
same-privilege peer that discovers and replaces the private quarantine after
verification can still redirect the final pathname removal.
If admitting a cleanup parent fails and closing its descriptor also fails,
creation rejects with both failures in an `AggregateError`. This does not select
compatible fallback or retry the indeterminate descriptor close.

Set `cleanupSafety: "require-bounded"` when that concurrent attacker is in scope.
Creation then requires native no-replace directory rename, native owned-tree
removal, and a readable retained parent descriptor **before** child creation.
On POSIX, the final requested `dirMode` must also include owner read
and search (`(dirMode & 0o500) === 0o500`). An unavailable capability throws
`FsSafeError("helper-unavailable")` without creating a child or calling a scoped
callback. The child descriptor is opened
while the new directory still has its private creation mode, before an explicit
`dirMode` can lower access. Retaining a read descriptor does not bypass the
POSIX final-mode requirement: enumeration reopens the directory relative to
that descriptor. Compatible mode accepts these restrictive modes but selects
the JavaScript fallback and does not retain native traversal authority for the
child, even if the caller later restores its permissions. Windows cleanup
does not use this POSIX mode gate. A search-only descriptor remains valid identity
evidence but is never native traversal authority: compatible cleanup selects
the JavaScript fallback, while `require-bounded` rejects and leaves the
unregistered child in place for caller-directed recovery. The compatible
default retains its fallback even if process-global native mode is `require`;
select `require-bounded` to make cleanup capability mandatory for this API.

On Linux, bounded cleanup requires a successful runtime probe of the exact
`openat2` child-directory flags, including `RESOLVE_NO_XDEV`, against the retained
parent descriptor. If the kernel or seccomp policy denies that capability,
compatible mode uses the guarded JavaScript fallback; `require-bounded` rejects
before child creation. For eligible modes, the probe runs once at creation,
without filesystem mutation.

Cleanup does not repair POSIX workspace or descendant permissions. In compatible
mode, a restrictive workspace mode or caller-created unreadable descendants
can prevent recursive removal; native bounded cleanup can also encounter later
permission changes or inaccessible descendants. These remain operational
cleanup failures, with the propagation and recovery behavior described below.

Bounded cleanup checks the parent and public workspace identity, quarantines
the direct child without replacement, and verifies the quarantine against the
retained workspace descriptor. It binds every enumerated child to its native
identity before opening it, rejects mount crossings, and traverses descendants
only through opened directory handles; symlinks/reparse entries are removed as
leaves and never traversed. Windows marks the exact opened objects for deletion by handle.

POSIX has no unlink-by-fd or expected-inode unlink for directory entries. After
the final identity check, each `unlinkat` can still be raced; the possible side
effect is bounded to one substituted non-directory leaf or one empty directory
entry per raced syscall. A substituted nonempty directory is never recursively
traversed and is preserved as `"indeterminate"`, but a leaf replacement removed
in that irreducible final gap cannot be distinguished after the syscall.

The workspace captures its identity, binding, and descriptors until cleanup.
Later process-global mode changes or loader resets do not revoke that authority.
Manual, disposal, and process-exit cleanup share one serialized owner,
registered before store construction; a construction failure after registration
remains exit-cleanable. Earlier creation failures close retained descriptors
without deleting an unverified child.

If the quarantine does not match the creation descriptor, cleanup leaves it in
place without restoring the public name or recursively deleting it and returns
`"indeterminate"`. A collision, uncertain rename outcome, changed parent,
mount/device crossing, changed reparse state, or detected concurrent mutation also
preserves the remaining artifact. Recover `.fs-safe-workspace-cleanup-<uuid>` entries only
after excluding competing mutators and re-establishing ownership.

A missing workspace returns `"missing"`. A replacement observed at the public
name before quarantine returns `"identity-mismatch"` when the parent is stable;
an ambiguous parent returns `"indeterminate"`. After successful removal,
repeated cleanup returns `"missing"` without touching a recreated public name.
Other statuses remain stable. Compatible recursive-removal failures propagate
the exact thrown value, including `undefined`, `null`, `false`, positive or
negative numeric zero, bigint zero, an empty string, and `NaN`; they are never
inferred from value identity or truthiness. Uncertain quarantine and
retained-parent checks instead return
`"indeterminate"`. After a propagated removal failure, later cleanup returns
`"indeterminate"` without retrying. Disposal and scoped helpers ignore returned
statuses, while manual cleanup exposes the result. A terminal descriptor-close
failure retains its existing precedence if it also fails during settlement.

When cleanup is part of a retention or audit decision, inspect the receipt
instead of treating cleanup as fire-and-forget:

```ts
const workspace = await tempWorkspace({ rootDir: "/var/lib/app/tmp", prefix: "restore-" });
try {
  await restoreInto(workspace.dir);
} finally {
  const cleanup = await workspace.cleanup();
  if (cleanup === "identity-mismatch") {
    alertOperator("restore workspace path was replaced; replacement preserved");
  } else if (cleanup === "indeterminate") {
    alertOperator("restore workspace cleanup could not establish safe completion; inspect retained entries");
  }
}
```

The sync variant `tempWorkspaceSync` exposes the same surface with sync return
types and a `FileStoreSync` at `workspace.store`.

### `withTempWorkspace`

The recommended shape. Attempts cleanup on every exit path:

```ts
import { withTempWorkspace } from "@openclaw/fs-safe/temp";

const result = await withTempWorkspace({ rootDir: "/tmp/my-app", prefix: "build-" }, async (workspace) => {
  await workspace.write("input.txt", "data");
  return await runBuild(workspace.dir);
});
```

The callback receives the same workspace shape as `tempWorkspace()`. Cleanup is wired to run after the callback resolves or rejects.

### Manual lifetime

Lower-level. You manage the lifetime:

```ts
const workspace = await tempWorkspace({ rootDir: "/tmp/my-app", prefix: "scan-" });
try {
  // …work in workspace.dir…
} finally {
  await workspace.cleanup();
}
```

### Sync variants

`tempWorkspaceSync` and `withTempWorkspaceSync` are the synchronous siblings. Useful for setup code in tests or boot paths that have not entered async land yet.

### Options

```ts
type TempWorkspaceOptions = {
  rootDir: string;          // parent directory for workspaces
  prefix: string;           // dir prefix (sanitized)
  dirMode?: number;         // new workspace mode; default 0o700; no POSIX group/world write
  mode?: number;            // file write mode; default 0o600
  cleanupSafety?: "compatible" | "require-bounded"; // default compatible
};
```

On Windows, caller-provided workspace roots and workspace leaf names reject
NTFS alternate-stream and directory-index namespace spellings before directory
creation or file access. The lower-level temp and sibling helpers apply the
same admission to supplied roots, sibling directories, and callback-selected
final paths. Prefixes and `tempFile()` filenames keep their documented
sanitization behavior; ordinary colon-bearing POSIX roots and leaf names remain
valid.

## Advanced temp primitives

When you don't need the stable workspace abstraction, the lower-level temp-file
and sibling-temp helpers live behind `@openclaw/fs-safe/advanced`. They are
composition primitives for stores and atomic writers, not the primary API.
`tempWorkspace()` carries the stable lifetime contract for application code;
`tempFile()` is a one-shot building block whose options may move as store and
archive internals evolve.

### `tempFile`

```ts
import { tempFile } from "@openclaw/fs-safe/advanced";

const target = await tempFile({ fileName: "report.pdf", prefix: "render-" });
try {
  await render(target.path);
  await fs.copyFile(target.path, "/srv/workspace/reports/today.pdf");
} finally {
  await target.cleanup();
}
```

Options:

```ts
type TempFileOptions = {
  rootDir?: string;
  prefix: string;
  fileName?: string;
  onCleanupError?: (error: unknown) => void;
  cleanupSafety?: "compatible" | "require-bounded"; // default compatible
};
```

Returns:

```ts
type TempFile = {
  path: string;                            // absolute path; safe to write to
  dir: string;                             // the enclosing private workspace dir
  file(fileName?: string): string;          // resolve another file in the same dir
  cleanup(): Promise<void>;                 // removes the original private workspace dir
  [Symbol.asyncDispose](): Promise<void>;   // alias of cleanup()
};
```

The default `cleanupSafety: "compatible"` retains the historical temp-file
behavior without loading or probing the native helper. Cleanup captures the
directory identity at creation time and preserves a replacement observed by
its pre-removal identity check. That check and pathname-recursive removal are
separate operations, however: a same-privilege peer can substitute a directory
in the final gap and redirect recursive traversal. Process-exit cleanup has the
same compatible contract.

The bounded mode requires an existing supplied root and applies the same
trusted-ancestry admission as private temp workspaces. On POSIX it finalizes
the new directory to `0o700` through its retained descriptor; Windows keeps
identity checks without treating POSIX modes as ACL privacy. Unverified
creation artifacts are preserved for caller-directed recovery.

Set `cleanupSafety: "require-bounded"` to require the retained-parent,
no-replace quarantine, and descriptor-bounded owned-tree removal described for
[private temp workspaces](#private-temp-workspaces). Admission, including the
runtime probe, completes before `mkdtemp`; unavailable support throws
`FsSafeError("helper-unavailable")` before a child is created. Manual, disposal,
scoped, and process-exit cleanup then share one owner, and no pathname-recursive
fallback is used. `cleanup()` still resolves `Promise<void>`: operational
cleanup errors are passed to `onCleanupError` when supplied and otherwise
suppressed for compatibility. The bounded POSIX final-entry unlink limit still
applies.

### `withTempFile`

Same shape with auto-cleanup:

```ts
import { withTempFile } from "@openclaw/fs-safe/advanced";

await withTempFile({ fileName: "out.zip", prefix: "pack-" }, async (filePath) => {
  await pack(filePath);
  await uploadAndForget(filePath);
});
```

## Sibling temp writes

When you want to write to a temp file in **the same directory** as a future destination — useful when you need atomic placement but don't want to use `replaceFileAtomic`'s full machinery.

### `writeSiblingTempFile`

```ts
import { writeSiblingTempFile } from "@openclaw/fs-safe/advanced";

const result = await writeSiblingTempFile<string>({
  dir: "/srv/workspace",
  mode: 0o600,
  writeTemp: async (tempPath) => {
    await fs.writeFile(tempPath, JSON.stringify(state));
    return "state.json";
  },
  resolveFinalPath: (fileName) => path.join("/srv/workspace", fileName),
});
// result.filePath, result.result (returned by writeTemp)
```

By default, `writeSiblingTempFile` chooses a random, initially absent sibling
name in `dir` and calls `writeTemp()`. After the callback succeeds, it validates the produced
regular file before taking ownership: symlinks, directories, other non-regular
files, hardlinks, and changes between the pre-open pathname, opened descriptor,
and current pathname are rejected. The callback must finish and close its
writer before returning. Its return value is preserved as `result`.

Each option is read once before directory creation starts, including both
callbacks, the temp prefix, isolation, directory and file modes, and sync flags.
Later changes to the options object do not change the in-flight operation.
`writeTemp` and `resolveFinalPath` retain their shared internal staging object
as the callback receiver.

Generated temp filenames suffix Windows reserved-device basenames on every
platform. Before either an ordinary or isolated producer runs, the completed staging
name must be a nonempty, non-dot path component with no POSIX or Windows
separator, C0/C1 control, Windows-invalid punctuation or stream colon. Windows
reserved devices and trailing-dot/space aliases are rejected on every host.
The helper joins that validated component to the guarded or owned directory and
verifies that the result is a direct child. An invalid completion rejects with
`invalid-path` without calling the producer or its pre-write hook.

The helper retains one descriptor through requested mode application, opt-in
file synchronization, rename, and publication verification. It opens read-only
unless file synchronization is requested, so closed read-only producer output
remains publishable under the historical default. Omitting
`mode` preserves the callback-produced mode without chmod; explicit modes,
including `0`, are applied through that descriptor. File-mode errors are
tolerated for compatibility with the helper's historical best-effort behavior.
No chmod, content read, or reopen follows
the staged or published pathname. `resolveFinalPath(result)` must resolve to a
distinct direct child of the same directory. Final-path writes are serialized
within the process, and the retained descriptor and current name must still
have the admitted exact bigint identity and exactly one link before rename and
after publication. A verification failure after rename does not roll back or
delete the final name.

`syncTempFile` and `syncParentDir` retain their historical `false` defaults.
Explicit `syncTempFile: true` synchronizes the descriptor before rename;
file-sync errors propagate except for the existing `EPERM` compatibility case.
Explicit `syncParentDir: true` requests best-effort parent sync after rename.
Omitting either option or passing `false` skips that sync, never the identity
checks. Parent synchronization can be unsupported or fail without rejecting
the write, so success is not a strict crash-durability receipt.

Without producer isolation, cleanup only unlinks an admitted file while the
parent, pathname identity, and single-link regular-file checks still agree.
Observed substitutes are preserved,
including during process-exit cleanup. Operational cleanup failures retain an
identity-bound exit retry. If the callback throws or admission fails, no file
has been adopted: even a regular partial file is left for caller-directed
recovery. The helper never recursively removes a sibling temp file path.

Set `producerIsolation: "private-directory"` in `WriteSiblingTempFileOptions`
when the producer can leave partial output before throwing. The callback then
receives an initially absent file path inside a private child workspace under
`dir`, on the same filesystem as the final target. fs-safe captures directory
cleanup ownership before invoking the callback. A callback exception triggers
owned workspace cleanup, including partial output, subject to directory
identity checks and I/O failures. The callback must still finish and close its
writer before returning.

After the callback succeeds, an available native helper uses guarded
no-replace `Root.move`. Native-off operation admits the completed regular file
with a retained descriptor. On Windows, that branch first requests write-only
access so admission does not request completed-file data reads; access or provider
rejections fall back to the historical read-only or read/write open before admission.
It then creates the randomized sibling with an atomic
no-clobber hard link and verifies the expected two-link transition. On Windows,
it opens and verifies a sibling descriptor before closing the source descriptor,
keeping the file pinned while allowing the private name to disappear on runtimes
with legacy deletion behavior. It removes the private name before continuing.
If legacy deletion clears the completed file's read-only attribute, the helper
restores it through the retained sibling descriptor and verifies its mode and
identity before publication. Restoration failures reject the operation.
An escaping symlink fails with `path-alias`, and
a filesystem without either handoff reports `helper-unavailable`. The retained
descriptor carries file admission, requested modes, sync options, and final
rename with their existing contracts; `resolveFinalPath(result)` still names a
direct child of `dir`.

The isolated path retains exact bigint identities for both the parent and the
workspace and rechecks them before moving output to the sibling path. An
observed replacement is rejected. This internal use of [`withTempFile`](#withtempfile)
does not expose `cleanupSafety` and uses compatible cleanup: moving or replacing
the parent or workspace can leave artifacts, and a workspace substituted in
the final check-to-recursive-removal gap can redirect traversal. It does not
promise cleanup through a retained directory after a rename, bounded cleanup,
stronger permissions, or additional crash durability. Omitting producer
isolation preserves the direct sibling callback path and unadmitted
partial-file retention.

On POSIX, admission uses no-follow and nonblocking open flags, so a FIFO swap
does not block the helper. Windows retains Node's guarded pathname-open behavior
because Node has no portable no-follow flag there; metadata is checked before
and after opening, and unknown Windows identities fail closed after one bounded
re-inspection without reopening. These helpers remain available with native
mode `off`; they do not acquire the native-required retained-directory contract
of [`stageFileInDirectory`](staged-file.md).

Identity checks and pathname rename/unlink are separate syscalls, not atomic
conditional mutations. A hostile process can still replace a leaf or parent in
the final syscall gap or mutate an open file's contents. Use an approved writable
directory and cooperative locking or OS isolation; a moved parent can leave an
unpublished original temp behind. Replacements observed before the final
namespace mutation are preserved, but that observation is not an atomic
condition on the later unlink or rename. Private producer isolation also has
the compatible recursive-cleanup gap described above. Arbitrary concurrent
namespace changes cannot be prevented by these helpers.

By default the helper attempts to set `dir` to `dirMode` (default `0o700`)
through the shared verified POSIX directory-descriptor helper. Only the actual
descriptor chmod error is tolerated, preserving the historical best-effort
directory-mode behavior. Directory lstat, open, type, identity, and close errors
still propagate; there is no pathname chmod fallback. Windows only passes the
directory mode to `mkdir`. Pass
`chmodDir: false` when an existing staging/output directory mode must be preserved.

### `writeViaSiblingTempPath`

A higher-level convenience for callback-based producers. The callback writes to
a private temp path, then the helper copies the result into `targetPath` through
the root boundary:

```ts
import { writeViaSiblingTempPath } from "@openclaw/fs-safe/advanced";

await writeViaSiblingTempPath({
  rootDir: "/srv/workspace",
  targetPath: "/srv/workspace/state.json",
  writeTemp: async (tempPath) => {
    await fs.writeFile(tempPath, JSON.stringify(state));
  },
});
```

If `replaceFileAtomic` does what you need, prefer that. Use
`writeViaSiblingTempPath` when the producer needs a concrete temp pathname but
the final destination still needs root-boundary checks.

The root, target, callback, fallback filename, and temp prefix are read once
before setup. Later changes to the parameters do not affect the in-flight
operation; `writeTemp` retains the original parameters object as its receiver.

Its private workspace uses `tempFile()`'s compatible identity-aware cleanup.
It preserves replacements observed before removal, but retains the final
pathname-recursive-removal gap described above; this helper does not expose
`cleanupSafety: "require-bounded"`.
The callback staging component is capped at 255 bytes as written and under NFC and NFD by
shortening only an overlong embedded destination tail, while preserving an
extension when possible. Short callback paths and the final target stay
unchanged. An unusable target basename causes `fallbackFileName` to pass through
the same basename, character, reserved-device, and length sanitization before it
is embedded; if neither candidate is usable, the fixed tail `file` is used. The
completed component is then checked as a direct child before test hooks or the
producer run. This workspace owns its contents, unlike the unadmitted sibling
pathname above.

## Secure temp root

The `resolveSecureTempRoot()` helper picks a per-user directory under the system temp dir, creates it at mode `0o700` if missing, and returns the absolute path. The other helpers in this module call it by default; you can call it directly if you need to materialize the root yourself.

```ts
import { resolveSecureTempRoot } from "@openclaw/fs-safe/temp";

const tempRoot = resolveSecureTempRoot({ fallbackPrefix: "my-app" });
// e.g. /tmp/my-app-501
```

Consumers that only need this resolver can use the narrow package subpath:

```ts
import {
  resolveSecureTempRoot,
  type ResolveSecureTempRootOptions,
  type SecureTempRootDescriptorAdapter,
} from "@openclaw/fs-safe/secure-temp-root";
```

This entry excludes the temp workspace and store implementations from the
module graph, keeping the import closure small for browser-aware builds that
shim or exclude Node built-ins. The resolver remains a Node filesystem API; the
narrow entry does not make it runnable in a browser.

### Options

```ts
type ResolveSecureTempRootOptions = {
  fallbackPrefix: string;             // one portable path segment; invalid values throw
  preferredDir?: string;              // preferred secure temp root
  skipPreferredOnWindows?: boolean;
  unsafeFallbackLabel?: string;       // text used in thrown errors
  warningPrefix?: string;             // default "[fs-safe]"
  warn?: (message: string) => void;    // default console.warn

  // Platform/test adapters; production callers normally omit these.
  platform?: NodeJS.Platform;
  getuid?: () => number | undefined;
  tmpdir?: () => string;
  accessSync?: typeof import("node:fs").accessSync;
  chmodSync?: typeof import("node:fs").chmodSync; // deprecated, never read or called
  descriptor?: SecureTempRootDescriptorAdapter; // complete bundle; see below
  lstatSync?: (path: string) => {
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
    mode?: number | bigint;
    uid?: number | bigint;
  };
  mkdirSync?: (
    path: string,
    options: { recursive: boolean; mode?: number },
  ) => void;
};
```

When `process.getuid()` is available, the fallback is
`<tmpdir>/<fallbackPrefix>-<uid>`. Without a UID (including Windows), it is
`<tmpdir>/<fallbackPrefix>`; no username is appended. The helper never returns
the shared `os.tmpdir()` directory itself. It requires the selected path to be
a writable, non-symlink directory and, when UID/mode facts are available,
owned by the current user without group/world write bits. It creates or repairs
the fallback to mode `0o700` where mode bits apply. If it cannot establish that
state, it throws an ordinary `Error`; there is no native mode or
`helper-unavailable` branch on this API.

Existing secure directories retain the one-`lstat`/access fast path, with no
descriptor open or chmod. On POSIX, a directory created by this call is instead
finalized through a pinned descriptor and must finish at exactly `0o700`, even
when a privileged caller can access its initial restrictive mode. A concurrent
recursive-`mkdir` winner is inspected as an untrusted existing directory.
Broad-mode repair also uses a pinned descriptor; there is no pathname chmod.

Repair and finalization require a known nonnegative safe-integer UID and exact
bigint device, inode, owner, mode, and directory-type facts. They open with
`O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK`, verify the descriptor and
current directory entry against the initial receipt before `fchmod`, then
verify identity, permissions, and write/search access again before closing.
Trailing separators are stripped only for entry inspection, preserving filesystem
roots and symlink-sensitive `..` components. Unknown, numeric, or malformed
identity facts cannot authorize a mutation. A failed chmod is tolerated only for
the existing `EPERM`/`EACCES`/`ENOENT` cases when the same exact pinned directory
has concurrently become safe and accessible; it emits no repair warning.

There is no search-only descriptor or `/proc` fallback. A newly created `000`
directory that cannot be opened read-only is left in place; the resolver tries
the secure fallback or throws. Actual Windows uses directory-type and access
checks and performs no POSIX chmod, regardless of an injected `platform` value.
Failures keep the ordinary `Error` contract; available underlying repair and
close failures are retained in `cause`, including paired errors.

The optional descriptor adapter is a complete authority bundle:

```ts
type SecureTempRootDescriptorAdapter = {
  lstatSync(path: string, options: { bigint: true }): Pick<import("node:fs").BigIntStats,
    "dev" | "ino" | "uid" | "mode" | "isDirectory" | "isSymbolicLink">;
  fstatSync(fd: number, options: { bigint: true }): ReturnType<SecureTempRootDescriptorAdapter["lstatSync"]>;
  openSync(path: string, flags: number): number;
  fchmodSync(fd: number, mode: number): void;
  closeSync(fd: number): void;
  constants: { O_RDONLY: number; O_DIRECTORY: number; O_NOFOLLOW: number; O_NONBLOCK: number };
};
```

Options, adapter functions, and flags are captured synchronously before callbacks.
On POSIX a complete bundle supplies exact admission and repair observations,
taking precedence over the legacy `lstatSync` hook. Partial bundles or unavailable
flags make repair/finalization unavailable. Injecting `lstatSync`, `accessSync`,
or `mkdirSync` disables the default host descriptor bundle. Injected observations
also require an explicit `mkdirSync` for creation; supplying a descriptor bundle
likewise never implicitly authorizes host mkdir. A custom mkdir requires the
complete descriptor bundle for POSIX finalization. The deprecated `chmodSync`
option is inert and alone does not disable normal host behavior.

These checks bind chmod to the admitted object and reject observed replacements;
the returned path is not a retained capability. Pathname access and identity
checks remain separate syscalls, and another process can replace the path after
the final check. Applications still need a trusted namespace or OS isolation
when other processes can mutate it.

## Common patterns

### Build something, atomically place it

```ts
import { replaceDirectoryAtomic } from "@openclaw/fs-safe/atomic";

await withTempWorkspace({ rootDir: "/srv/site/tmp", prefix: "build-" }, async (ws) => {
  await runCompiler({ outDir: ws.dir });
  await replaceDirectoryAtomic({
    stagedDir: ws.dir,
    targetDir: "/srv/site/public",
  });
});
```

### Stream a download to a sibling temp, then commit

```ts
import { writeSiblingTempFile } from "@openclaw/fs-safe/advanced";
import fs from "node:fs/promises";

const r = await writeSiblingTempFile({
  dir: "/srv/cache",
  producerIsolation: "private-directory",
  writeTemp: async (tempPath) => {
    const handle = await fs.open(tempPath, "w");
    try {
      await pipeline(downloadStream, handle.createWriteStream());
    } finally {
      await handle.close();
    }
    return "blob.bin";
  },
  resolveFinalPath: (fileName) => path.join("/srv/cache", fileName),
});

console.log(`downloaded ${r.filePath}`);
```

### Per-call private scratch in a test

```ts
import { withTempWorkspace } from "@openclaw/fs-safe/temp";

it("processes a fixture", async () => {
  await withTempWorkspace({ rootDir: "/tmp/my-tests", prefix: "test-" }, async (ws) => {
    await fs.writeFile(path.join(ws.dir, "input.txt"), fixture);
    const out = await processFile(path.join(ws.dir, "input.txt"));
    expect(out).toEqual(expected);
  });
});
```

## See also

- [Atomic writes](atomic.md) — `replaceDirectoryAtomic` for whole-directory swaps.
- [`root()`](root.md) — `fs.copyIn(rel, sourceAbs)` for moving files from a temp into a `Root`.
- [File lock](sidecar-lock.md) — when many processes share a temp tree.
