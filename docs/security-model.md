# Security model

`fs-safe` is a library-level guardrail: a capability-style root handle for Node.js code that handles untrusted relative paths. It assumes the calling process already has whatever filesystem permissions it needs and aims to stop trivial path tricks from broadening that authority. It is not a sandbox and does not replace operating-system isolation.

The same shape exists in other languages: Go's [`os.Root` / `OpenInRoot`](https://go.dev/blog/osroot) and Rust's [`cap-std`](https://github.com/bytecodealliance/cap-std) both expose a root handle whose operations refuse to escape it. `fs-safe` is the Node-side equivalent: a single `root()` capability that carries the boundary across every read, write, move, and remove, instead of leaving each call site to redo `path.resolve(...).startsWith(...)` and hope.

## Affected versions / exposure

In published releases through 0.4.7, the exported `resolveRootPath()` and
`resolveRootPathSync()` helpers validated a lexically normalized path spelling.
A caller-supplied path traversing an in-root symlink could therefore pass
validation while resolving outside the root. Version 0.5 fixes this with
component-wise alias resolution, resolving each alias before applying later
path components.

`root()` handles were **not** affected: their operations have contained this
case since `5ddca80`. Exposure is limited to consumers that call
`resolveRootPath()` or `resolveRootPathSync()` directly.

## Threat model

You hand a `root()` boundary to a piece of code that takes caller-controlled relative paths. The library defends against a caller that:

- supplies `..` traversal segments to escape the boundary
- supplies an absolute path outside a configured root, or to an API whose input
  contract is strictly relative/portable
- replaces a path component with a symlink between check and use (TOCTOU)
- replaces the destination directory with a symlink right before a write
- creates a hardlink that aliases an out-of-tree inode and asks you to read or replace it
- asks a read/open primitive to target a known unsafe device or process-fd path
- triggers a partial write that leaves a half-written file at the destination
- ships an archive with `..` paths, absolute paths, or symlinks pointing outside the destination

It does **not** defend against:

- a process running with permissions to write anywhere on the filesystem and choosing to ignore the library
- another process with the same UID racing to mutate the same directory between two separate `fs-safe` calls — the boundary is per-call, not per-session
- arbitrary traversal across filesystem boundaries, bind mounts, or virtual filesystems beyond the known unsafe read device paths
- container escape, TOCTOU between fork and exec of helpers, or kernel-level vulnerabilities
- semantic content checks: file types, archive payload schemas, signature verification

If you need full sandboxing, run the worker under reduced privileges (uid, container, seccomp, chroot, jail) and use `fs-safe` inside the sandbox to keep the worker honest about its own workspace.

## Defenses, by failure mode

### Path traversal and absolute paths

Every path is resolved against the canonicalized real path of the root, then checked with `isPathInside`. Alias resolution walks components before applying a later `..`, so a symlink cannot change what that parent segment means after validation. Parent traversal, an absolute spelling, or any alias whose canonical result is outside the root throws `outside-workspace`; absolute spellings that remain inside the root are accepted.

### Symlinks (read side)

`open()` and `read()` use `fs.open` with `O_NOFOLLOW` on POSIX where available. The library then `fstat`s the open fd and `realpath`s the original input, asserting the two refer to the same inode. A symlink swap that happens between resolve and open will fail at the identity check rather than silently following the new target.

Per-call `symlinks: "follow-within-root"` allows symlinks whose final target is still inside the root. The default is `"reject"`.

Guarded root reads compare lossless bigint identities from before open, the opened
descriptor, the input path, and the canonical target; numeric public `Stats`
receipts are not used as identity evidence. Unknown Windows device/inode values
receive one re-inspection without reopening the file. A definite mismatch or
persistent unknown identity rejects with `path-mismatch` before reading bytes.

### Symlinks (write side)

With the native binding loaded, `write()`, `create()`, and `copyIn()` use a
sibling temp file and create parents and publish the target relative to pinned
directory descriptors. Replacement uses descriptor-relative rename just like
no-replace publication, so replacing the parent pathname does not divert the
mutation.

The JavaScript fallback used by `off`, by `auto` when no binding loads, and by
the explicit `renameIdentity: "verify-content-with-lock"` compatibility policy
cannot provide that guarantee because Node exposes no `mkdirat` or `renameat`.
It asserts directory identity around a pathname mutation and detects many
swaps, but detection occurs after the kernel may already have followed a new
parent symlink. A same-privilege peer with write access to the parent can
therefore cause an out-of-root side effect before the operation throws. Use
native `require` mode when concurrent hostile mutation is in scope.

The separate [retained-directory staging lifecycle](staged-file.md) keeps abort
cleanup anchored to the original directory after a parent or ancestor move.
It preserves observed substituted temporary entries and never cleans a recorded
publication. Directory anchoring is not expected-inode/CAS replacement, and
identity-check-then-unlink is not atomic conditional unlink. The guarantee
requires the temporary name to remain owned and removal to remain permitted;
application authorization and cooperative coordination remain necessary.

### Hardlink aliasing

When `hardlinks: "reject"` is set, reads stat the target and refuse if `nlink > 1`, on the conservative assumption that a hardlinked file might alias an out-of-tree inode. This is defense-in-depth: the link count check is best-effort and platform-dependent. Treat it as a tripwire, not authorization.

### TOCTOU between resolve and use

`resolve()`, `exists()`, `stat()`, and `list()` are explicitly advisory — they answer a question and return. To act on a path with operation-local identity checks, use `read()`, `open()`, `write()`, `create()`, `copyIn()`, `move()`, or `remove()`. The containment table below states which opens are kernel-atomic and which remain best-effort.

A `root()` handle also remembers the canonical root directory identity. Calls fail with `path-mismatch` if that canonical pathname is replaced, including advisory inspection and walking calls, rather than following a replacement root into another tree.

### Denied mutations

`denyMutations` is an opt-in application policy for `root()` mutation methods. It blocks exact absolute paths with `paths` and whole subtrees with `prefixes`, merging root defaults with per-call entries so a call cannot clear root-level denies. This is not an OS permission boundary: code with access to `node:fs`, a shell, or another process with the same filesystem privileges can bypass it.

### Atomic writes

`replaceFileAtomic` writes to a sibling temp file in the destination directory, optionally `fsync`s it, optionally `fsync`s the parent directory after rename, and atomically renames over the destination. On failure mid-write, the destination is either the old contents (rename never happened) or the new contents (rename succeeded). There is no half-written intermediate state visible at the destination path unless the caller explicitly enables `copyFallbackOnPermissionError`, whose default `copyFallbackRestore: "none"` contract may leave a partial destination after a failed in-place fallback.

Within one process, async writes to the same target are queued so their temp-write/rename phases do not overlap. Cross-process writers still need an external protocol such as the sidecar lock helpers.

### Directory durability

`pinDirectory()` opens a directory without following its final component on
POSIX, verifies the descriptor against the pathname identity and canonical
path, and repeats those checks around synchronization. `ensureDurableDirectory()`
pins the nearest existing ancestor and each newly created segment before
synchronizing every new directory edge from the leaf upward.

Known Windows directory-flush limitations are returned as an explicit
`unsupported` outcome. POSIX and other I/O failures propagate from the strict
API. The separately named best-effort helpers intentionally provide no crash
durability guarantee.

### Archive extraction

`extractArchive` first stages into a private temp directory (mode 0700) outside the destination, validates each entry path against `..` and absolute prefixes, refuses link-type entries by default, enforces entry count and byte budgets, and only then merges the staged tree into the destination through the same boundary checks used by direct writes.

## What "library-level" means

A library cannot revoke its own caller's authority. If your code chooses to bypass `fs-safe` and call `fs.writeFile` directly with the same path, you bypass the defenses too. The contract `fs-safe` enforces is: *every filesystem operation that touches caller-controlled input goes through the boundary*. That contract is yours to keep.

The library does not modify or constrain the global Node.js `fs` namespace, and it does not patch the runtime. Other code in the same process retains its normal filesystem authority.

## Containment guarantees by platform

`openBeneath()` and JavaScript open results report one of two factual containment classes:

| Mechanism | Reported containment | Boundary |
|---|---|---|
| Linux native | `kernel-atomic` | `openat2(RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS)` resolves and opens under the root in one kernel operation. |
| macOS native | `best-effort` | macOS 15.4 and newer use `O_RESOLVE_BENEATH` first; older kernels use the guarded `openat(O_NOFOLLOW)` component walk. Both verify the opened descriptor with `F_GETPATH`. |
| Windows native | `best-effort` | Handle-relative `NtCreateFile` rejects reparse points, but this package does not claim a Linux-style atomic beneath guarantee. |
| JavaScript fallback | `best-effort` | Canonical checks, no-follow opens where Node exposes them, and post-open identity checks form a check-then-use sequence. |

The macOS `F_GETPATH` verification is an escape detector, not a race-atomic guarantee. A hostile same-UID process can rename a directory after `O_RESOLVE_BENEATH` or the manual walk and race the post-open sample or a later descriptor-relative mutation. The native result therefore remains `best-effort` on macOS even when the kernel flag is available. No policy decision is attached to these labels; callers can inspect the fact and decide what their own threat model requires.

The public `OpenResult`, `ReadResult`, and `WritableOpenResult` expose `containment`. Those root APIs currently report `best-effort`; direct native `openBeneath()` reports the platform value above. No-replace publication uses `renameat2(RENAME_NOREPLACE)` on Linux, `renameatx_np(RENAME_EXCL)` on macOS, and `FileRenameInfoEx` with replacement disabled on Windows, but those separate mutation semantics do not upgrade an open result's containment label.

## Limitations to keep in mind

| Limitation | What it means |
|---|---|
| Not ambient authority removal | Code that can import `node:fs` can still bypass the handle. Keep caller-controlled path operations behind `root()` by convention, review, and tests. |
| Absolute paths are escape hatches | APIs that accept or return absolute paths exist for audit, ingest, and advanced composition. Prefer root-relative names in normal application flow. |
| Not a mount boundary | `root()` keeps path traversal inside the directory tree and blocks known unsafe read device paths, but it does not make bind mounts or virtual filesystems safe to expose wholesale. |
| Per-call, not per-session | Another process with the same privileges can still mutate the tree between calls, and best-effort mechanisms retain documented same-call race windows. Use one verb method to minimize the window and inspect its reported containment class. |
| JavaScript mutations are detection-based | Without the native binding, Node pathname mutations retain a check-to-syscall race. A writable parent can be swapped so a create, rename, or removal affects an out-of-root path before the fallback detects identity drift. |
| Hardlink rejection is best-effort | Link-count checks depend on platform metadata. Treat `hardlinks: "reject"` as a tripwire, not an authorization primitive. |
| Mode bits are not a full policy engine | `replaceFileAtomic` and secret-file helpers set requested modes, but you should still set umask and inspect modes when policy requires it. |
| Archive extraction is path safety, not content safety | Unsafe entry paths and links are rejected; malicious payload contents remain your application layer's problem. |
| Native package unavailable | `helper-unavailable` falls back in `auto` mode and fails closed in `require` mode for native-backed operations. Guarded JavaScript atomicity and identity checks remain. |
| FUSE mounts with rename-unstable inode numbers | Some FUSE mounts (rclone is a confirmed example) do not preserve source inode identity at the rename destination. The explicit `renameIdentity: "verify-content-with-lock"` compatibility mode verifies content under a cooperative lock for that boundary only; subsequent path identity checks and the default remain strict. See [Writing](writing.md) for the weaker opt-in contract. |

## Recommended deployment shape

- Run worker code under a dedicated UID with the smallest filesystem privileges that still allow the worker to do its job.
- Mount the workspace directory writable; mount everything else read-only or not at all.
- Use `fs-safe`'s `root()` for that workspace.
- For credentials, use [secret files](secret-file.md) (mode 0600 in mode-0700 dirs) rather than the workspace.
- For scratch space, use a [private temp workspace](temp.md) — don't reuse the workspace root.

## Reporting issues

Suspected security issues belong in private disclosure first. See [`SECURITY.md`](https://github.com/openclaw/fs-safe/blob/main/SECURITY.md) in the repo for the current contact path.
