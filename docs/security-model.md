# Security model

`fs-safe` is a library-level guardrail: a capability-style root handle for Node.js code that handles untrusted relative paths. It assumes the calling process already has whatever filesystem permissions it needs and aims to stop trivial path tricks from broadening that authority. It is not a sandbox and does not replace operating-system isolation.

The same shape exists in other languages: Go's [`os.Root` / `OpenInRoot`](https://go.dev/blog/osroot) and Rust's [`cap-std`](https://github.com/bytecodealliance/cap-std) both expose a root handle whose operations refuse to escape it. `fs-safe` is the Node-side equivalent: a single `root()` capability that carries the boundary across every read, write, move, and remove, instead of leaving each call site to redo `path.resolve(...).startsWith(...)` and hope.

## Threat model

You hand a `root()` boundary to a piece of code that takes caller-controlled relative paths. The library defends against a caller that:

- supplies `..` traversal segments to escape the boundary
- supplies an absolute path where a relative one is expected
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

Every relative path is resolved against the canonicalized real path of the root, then checked with `isPathInside`. Inputs containing `..`, leading `/` (without `pathScope` opt-in), or that resolve outside the root throw `outside-workspace`.

### Symlinks (read side)

`open()` and `read()` use `fs.open` with `O_NOFOLLOW` on POSIX where available. The library then `fstat`s the open fd and `realpath`s the original input, asserting the two refer to the same inode (`sameFileIdentity`). A symlink swap that happens between resolve and open will fail at the identity check rather than silently following the new target.

Per-call `symlinks: "follow-within-root"` allows symlinks whose final target is still inside the root. The default is `"reject"`.

### Symlinks (write side)

Writes use a sibling-temp + rename helper that opens the parent directory by fd, then performs the rename `at` the parent fd. Replacing the parent directory with a symlink between the parent-fd open and the rename does not divert the write.

### Hardlink aliasing

When `hardlinks: "reject"` is set, reads stat the target and refuse if `nlink > 1`, on the conservative assumption that a hardlinked file might alias an out-of-tree inode. This is defense-in-depth: the link count check is best-effort and platform-dependent. Treat it as a tripwire, not authorization.

### TOCTOU between resolve and use

`resolve()`, `exists()`, `stat()`, and `list()` are explicitly **not** race-resistant — they answer a question and return. To act on a path with race resistance, use `read()`, `open()`, `write()`, `create()`, `copyIn()`, `move()`, or `remove()`. They re-pin the path identity at the point of use.

### Denied mutations

`denyMutations` is an opt-in application policy for `root()` mutation methods. It blocks exact absolute paths with `paths` and whole subtrees with `prefixes`, merging root defaults with per-call entries so a call cannot clear root-level denies. This is not an OS permission boundary: code with access to `node:fs`, a shell, or another process with the same filesystem privileges can bypass it.

### Atomic writes

`replaceFileAtomic` writes to a sibling temp file in the destination directory, optionally `fsync`s it, optionally `fsync`s the parent directory after rename, and atomically renames over the destination. On failure mid-write, the destination is either the old contents (rename never happened) or the new contents (rename succeeded). There is no half-written intermediate state visible at the destination path.

Within one process, async writes to the same target are queued so their temp-write/rename phases do not overlap. Cross-process writers still need an external protocol such as the sidecar lock helpers.

### Archive extraction

`extractArchive` first stages into a private temp directory (mode 0700) outside the destination, validates each entry path against `..` and absolute prefixes, refuses link-type entries by default, enforces entry count and byte budgets, and only then merges the staged tree into the destination through the same boundary checks used by direct writes.

## What "library-level" means

A library cannot revoke its own caller's authority. If your code chooses to bypass `fs-safe` and call `fs.writeFile` directly with the same path, you bypass the defenses too. The contract `fs-safe` enforces is: *every filesystem operation that touches caller-controlled input goes through the boundary*. That contract is yours to keep.

The library does not modify or constrain the global Node.js `fs` namespace, and it does not patch the runtime. Other code in the same process retains its normal filesystem authority.

## Platform notes

- **POSIX (Linux, macOS):** Best-defended path. Uses `O_NOFOLLOW`, fd identity checks, and one persistent Python helper process for fd-relative `unlinkat` / `mkdirat` / `renameat` / parent-fd write operations. Configure `FS_SAFE_PYTHON_MODE=require` when helper startup must fail closed, or `off` when you need a no-Python runtime. See [Python helper policy](python-helper.md).
- **Windows:** Falls back to the safest Node-level behavior available. `O_NOFOLLOW` is not honored. Some fd-relative POSIX hardening is unavailable. The library does the path canonicalization, identity, and atomic-rename checks it can.

The library does not advertise different security guarantees per platform — it advertises the same surface and relies on the strongest mechanism the platform offers.

## Limitations to keep in mind

| Limitation | What it means |
|---|---|
| Not ambient authority removal | Code that can import `node:fs` can still bypass the handle. Keep caller-controlled path operations behind `root()` by convention, review, and tests. |
| Absolute paths are escape hatches | APIs that accept or return absolute paths exist for audit, ingest, and advanced composition. Prefer root-relative names in normal application flow. |
| Not a mount boundary | `root()` keeps path traversal inside the directory tree and blocks known unsafe read device paths, but it does not make bind mounts or virtual filesystems safe to expose wholesale. |
| Per-call, not per-session | Another process with the same privileges can still mutate the tree between two separate calls. Use one verb method for the operation you need to make race-resistant. |
| Hardlink rejection is best-effort | Link-count checks depend on platform metadata. Treat `hardlinks: "reject"` as a tripwire, not an authorization primitive. |
| Mode bits are not a full policy engine | `replaceFileAtomic` and secret-file helpers set requested modes, but you should still set umask and inspect modes when policy requires it. |
| Archive extraction is path safety, not content safety | Unsafe entry paths and links are rejected; malicious payload contents remain your application layer's problem. |
| Helper failures degrade fd-relative hardening | `helper-unavailable` falls back in `auto` mode and fails closed in `require` mode. Atomicity and identity checks remain, but parent-directory swaps between validation and mutation are less tightly pinned without the helper. |
| FUSE mounts with rename-unstable inode numbers | Some FUSE mounts (rclone is a confirmed example) do not preserve source inode identity at the rename destination. The explicit `renameIdentity: "verify-content-with-lock"` compatibility mode verifies content under a cooperative lock for that boundary only; subsequent path identity checks and the default remain strict. See [Writing](writing.md) for the weaker opt-in contract. |

## Recommended deployment shape

- Run worker code under a dedicated UID with the smallest filesystem privileges that still allow the worker to do its job.
- Mount the workspace directory writable; mount everything else read-only or not at all.
- Use `fs-safe`'s `root()` for that workspace.
- For credentials, use [secret files](secret-file.md) (mode 0600 in mode-0700 dirs) rather than the workspace.
- For scratch space, use a [private temp workspace](temp.md) — don't reuse the workspace root.

## Reporting issues

Suspected security issues belong in private disclosure first. See [`SECURITY.md`](https://github.com/openclaw/fs-safe/blob/main/SECURITY.md) in the repo for the current contact path.
