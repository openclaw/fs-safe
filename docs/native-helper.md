---
title: Native helper policy
description: "How fs-safe loads its platform-specific native filesystem primitives and how auto, require, and off affect guarded fallbacks."
---

# Native helper policy

`@openclaw/fs-safe` declares seven exact-version optional packages for Linux
x64/arm64 (glibc or musl), macOS x64/arm64, and Windows x64. Package-manager
OS, CPU, and libc filters install only the matching package. The loader requires
that package lazily, without runtime downloads, postinstall scripts, or a
consumer Rust build.

```ts
import { configureFsSafeNative } from "@openclaw/fs-safe/config";

configureFsSafeNative({ mode: "auto" });    // default
configureFsSafeNative({ mode: "off" });     // disable the addon; reject native-only operations
configureFsSafeNative({ mode: "require" }); // fail closed when the binding is unavailable
```

The equivalent environment variables are `FS_SAFE_NATIVE_MODE` and `OPENCLAW_FS_SAFE_NATIVE_MODE`. Accepted values are `auto`, `off`, `require`, `true`, `false`, `on`, `never`, `required`, `1`, and `0`.

## Modes

| Mode | Behavior |
|---|---|
| `auto` | Prefer native primitives when the current platform package loads; otherwise use supported fallbacks and reject native-only operations. |
| `off` | Do not load a native package. Use supported fallbacks and reject native-only operations deterministically. |
| `require` | Throw `FsSafeError("helper-unavailable")` instead of falling back when an operation needs the native binding and it cannot load. |

Plain TAR, gzip, zstd, and bzip2 extraction and bounded entry reads use a bundled,
import-free WASM build of the same Rust TAR parser when native support is absent
or disabled. Zstd/bzip2 codecs are bundled alongside the parser; gzip uses Node's
built-in decoder. These archive fallbacks require no runtime interpreter or
download. `off` disables the optional native filesystem helper, not the bundled
WASM. `auto` prefers native and does not retry a native operation failure through
WASM; `require` still rejects an unavailable native binding. ZIP fallback still
requires optional `jszip`. `inspectTarArchive()` remains limited to plain TAR
and gzip.

Windows security operations can use the package's readable PowerShell/C# scripts
in `auto` and `off`, subject to the [Windows security fallback prerequisites](install.md#windows-security-fallback).

On Bun macOS/Linux, the [runtime path adapter](install.md#bun-runtime) uses the
same Rust addon for system canonicalization in `auto` and `require`. No JIT is
needed. With `off` or a missing addon in `auto`, Bun's own resolver retains its
path and permission limitations. Canonicalization in `require` fails with
`helper-unavailable` if the addon or its canonicalizer is missing, including
when admitting a temp workspace. Containment and identity checks stay intact.

Configure the mode once during startup. Loading is lazy and cached; changing from `auto` to `require` after a failed load changes failure policy but does not repeatedly probe the binary.

Native-created descriptors retain their originating native close operation through
normal and error cleanup, including later mode changes. Node-created roots and
directory handles keep Node's close operation, and borrowed handles keep their
caller-owned lifetime. This preserves Node worker-thread descriptor tracking
without unmanaged-descriptor warnings. A helper missing native close support is
unavailable before descriptor allocation.

Close retained native resources and let in-flight operations finish before
forcibly terminating a worker. Native-created descriptors are not registered
with Node's automatic worker-exit cleanup; `Worker.terminate()` can leave them
open until process exit. The native close operation handles explicit cleanup,
not forced worker termination.

[`tempWorkspace()` and its scoped/sync variants](temp.md#private-temp-workspaces)
remain available in every mode. Their default compatible cleanup uses guarded
JavaScript quarantine when owned native tree removal is unavailable.
`cleanupSafety: "require-bounded"` instead rejects before child creation unless
no-replace quarantine plus descriptor-relative owned-tree removal are available.
On Linux, admission probes the exact `openat2` child-directory flags, including
`RESOLVE_NO_XDEV`, at runtime. An unavailable or denied probe selects compatible
JavaScript cleanup even in global `require` mode; `require-bounded` rejects before
child creation.
Already-created strict workspaces retain their binding
and descriptors across later mode changes.

[`stageFileInDirectory()`](staged-file.md) always requires native support on
Linux/macOS and rejects before creation when off, unavailable, or missing the
required capability. Windows is unsupported for this lifecycle. This does not
change the mode policy of existing fallback-capable APIs.

## Native boundary

The internal Darwin descriptor ACL inspector requires its matching native
capability in both `auto` and `require`; `off`, a missing package, or an older
binding without `inspectDarwinAcl` rejects with `helper-unavailable`. Inspection
failure or malformed facts reject with `permission-unverified`; there is no
mode-bit or pathname fallback for this capability. Clone admission uses a fused
descriptor-bound metadata and ACL observation, then compares immutable receipts
with fresh no-follow pathname identity fences; pathnames never authorize ACL
state. The payload ACL-clear readback is part of that fused observation. Once
a clone payload exists, normalization and verification failures become terminal
`EIO` errors (with the underlying status and detail retained), not capability
signals that permit an ordinary-copy retry. Checked cleanup cannot undo that
terminal classification.
This addition does not change other APIs' native-mode or permission contracts.

The native layer exposes policy-free filesystem mechanisms: beneath-root
open/mkdir/link, replace and no-replace rename, identity reads, archive decode/execution,
clone/copy/hash workers, POSIX canonicalization, and Windows security descriptor calls. The TypeScript
layer owns policy, retries, filters, budgets, modes, cleanup, error
normalization, and the decision to fall back.

- Linux uses `openat2` with `RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS`, `renameat`, and `renameat2(RENAME_NOREPLACE)`. Without `openat2`, beneath opens use the [no-follow component walk](native.md#linux-without-openat2) with exact identity checks and report `best-effort`. Direct-child no-replace renames borrow already-retained parent descriptors; deeper relative paths retain the guarded reopen. Owned-tree cleanup still requires `openat2` with `RESOLVE_NO_XDEV` and fails closed when unavailable.
- macOS 15.4 and newer prefer `O_RESOLVE_BENEATH`; older kernels resolve components with `O_NOFOLLOW` and restart in-root symlinks from the pinned root descriptor. Both routes use an `F_GETPATH` post-open escape detector and report `best-effort` because directory rename races are not atomic with that check. Direct-child no-replace renames borrow already-retained parents without another `F_GETPATH`; deeper paths retain the guarded reopen. Publication uses `renameat` for replacement and `renameatx_np(RENAME_EXCL)` for no-replace; owned-tree cleanup uses descriptor-relative `openat`/`unlinkat`.
- Windows uses handle-relative `NtCreateFile`, rejects reparse points during root-bounded traversal, and uses `FileRenameInfoEx` with replacement selected explicitly by the TypeScript policy layer. The dedicated retained-directory `renameNoReplaceWithIdentity` primitive compares its required exact source receipt with the handle opened for rename before mutation. Its internal mismatch status is normalized to public `path-mismatch`; the legacy four-argument `renameNoReplace` export and its other callers are unchanged. Owned trees are deleted through exact opened handles with `FileDispositionInfoEx`; symlink/reparse entries in owned trees are removed as leaves and never traversed. Descriptors crossing N-API are converted only by the host executable's paired `uv_get_osfhandle` and `uv_open_osfhandle` exports. A runtime without both exports is unsupported for these native operations; the binding never guesses a raw HANDLE or uses a foreign CRT descriptor table. Descriptor-producing operations also require that same host's synchronous libuv close and request-management APIs before exporting an owned descriptor.

Linux root lookups reject negative descriptor sentinels before borrowing a handle or resolving a relative path; they never substitute the process working directory for an admitted root. Public Root operations already supply retained, admitted handles.

On Linux and macOS, native asynchronous file-copy admission rejects negative source and parent descriptors before creating a stage, preserving source-before-parent error ordering. Callers must keep nonnegative source and parent descriptors open until the operation settles.

Low-level Unix query, hash, copy, clone, staging, and owned-tree cleanup calls also reject negative descriptors before using them, preserving each operation's path-validation, cancellation, and cleanup order. Descriptor-relative mutations never accept a working-directory sentinel as a retained capability. On modern macOS, beneath opens reject negative roots with `EBADF` before calling `openat`, rather than returning `EIO` after an OS failure or working-directory operation. This check does not establish the validity of arbitrary nonnegative integers: callers must supply live descriptors and retain them until synchronous calls return or asynchronous operations settle.

`replaceDirectoryAtomic()` requires `renameNoReplaceWithIdentity` before it
creates a missing target parent. On POSIX the dedicated entry point keeps the
existing pre-dispatch exact receipt fence but dispatches direct-child names
through the retained parents without another receipt, duplicate, reopen, or
macOS `F_GETPATH`; the documented final source-name substitution window remains
there. Deeper names retain guarded parent traversal.

Native primitives back create-only and replacing pinned writes, no-clobber
`Root.move()`, async sidecar creation, guarded publication, archive acceleration,
and direct Windows ACL operations. Windows secure-file reads require
descriptor-bound owner/DACL facts. In native `auto` or `off` mode, a missing
binding or capability can use a packaged PowerShell script that inspects the
borrowed handle. Raw owner/DACL inspection and private-directory creation also support
this fallback, subject to the [Windows security fallback prerequisites](install.md#windows-security-fallback).
Each capability emits a path-free warning once per process and adds PowerShell
startup and compilation overhead per call. Native `require` rejects missing
capabilities, and native operation failures remain terminal. No-clobber moves fail with
`helper-unavailable` when descriptor-relative parent admission or the atomic
no-replace rename is unavailable; they never use a check followed by a replacing
rename. Equivalent JavaScript paths remain available for documented
fallback-capable features. See [Native architecture](native.md#javascript-fallback-guarantees-and-delta)
for the exact difference.

The guarded JavaScript mutation path is detection-based, not containment-atomic.
If a same-privilege peer can replace a writable parent after its identity guard
but before Node resolves a pathname mutation, the mutation can land outside the
intended root before the post-operation guard throws. Native `require` ensures the addon is present, but does not require a
`kernel-atomic` resolver; inspect containment and use OS isolation when that
concurrent attacker is part of the threat model.

`openBeneath()` returns `{ fd, containment }`. `containment` is
`"kernel-atomic"` for Linux `openat2` and `"best-effort"` for the Linux fallback, macOS and
Windows. Public JavaScript root open/read/writable results also expose the
field and report `"best-effort"`; the label reports mechanism, not policy.

## Migration from the Python helper

Version 0.5 removes the Python worker and interpreter-path selection. The mode
contract is unchanged, so migrate startup configuration directly:

| Python helper configuration | Native replacement |
|---|---|
| `configureFsSafePython({ mode: "auto" })` | `configureFsSafeNative({ mode: "auto" })` |
| `configureFsSafePython({ mode: "off" })` | `configureFsSafeNative({ mode: "off" })` |
| `configureFsSafePython({ mode: "require" })` | `configureFsSafeNative({ mode: "require" })` |
| `FS_SAFE_PYTHON_MODE` | `FS_SAFE_NATIVE_MODE` |
| `OPENCLAW_FS_SAFE_PYTHON_MODE` | `OPENCLAW_FS_SAFE_NATIVE_MODE` |
| `pythonPath`, `FS_SAFE_PYTHON`, and the OpenClaw interpreter-path aliases | Remove; prebuilt bindings do not use an interpreter path |

In 0.5, `configureFsSafePython` and the legacy Python environment names
remain only as an upgrade bridge. On the first config read they emit one
`DeprecationWarning` with code `FS_SAFE_PYTHON_DEPRECATED`, state the mapped
native mode, and then apply that mode. A legacy interpreter path without an
explicit mode maps to `auto` and the path itself is ignored. Native config has
the normal precedence over legacy environment config.

There is no silent alias and no Python execution fallback. The bridge exists
only to make shipped 0.4 configuration visible and predictable while the
consumer performs its 0.5 upgrade.

## Related pages

- [Config](config.md)
- [Security model](security-model.md)
- [Writing](writing.md)
- [File locks](sidecar-lock.md)
- [Durability](durability.md)
- [Migrating to 0.5](migrating-to-0.5.md)
- [Migrating to 0.6](migrating-to-0.6.md)

### Retained existing Windows file

The maintained Windows helper supports the public
[`retainFileInDirectory`](retained-file.md) lifecycle on fixed local NTFS.
Private native handles, exact identity/generation checks, writable-section
admission and explicit close results stay behind that public API. Older helpers
without this capability are unsupported; there is no pathname deletion fallback.
No Windows namespace persistence barrier is provided.
