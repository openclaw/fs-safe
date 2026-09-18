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
configureFsSafeNative({ mode: "off" });     // portable implementations; do not load the addon
configureFsSafeNative({ mode: "require" }); // fail closed when the binding is unavailable
```

The equivalent environment variables are `FS_SAFE_NATIVE_MODE` and `OPENCLAW_FS_SAFE_NATIVE_MODE`. Accepted values are `auto`, `off`, `require`, `true`, `false`, `on`, `never`, `required`, `1`, and `0`.

## Modes

| Mode | Behavior |
|---|---|
| `auto` | Prefer native primitives when the current platform package loads; otherwise use the feature's guarded portable implementation. |
| `off` | Do not load a native package. Use portable implementations for every feature, retaining validation and filesystem-error handling. |
| `require` | Binding lookup throws `FsSafeError("helper-unavailable")` when the addon cannot load; public wrappers retain their documented error mapping. |

Portable TAR uses bundled, import-free WASM and the same Rust TAR parser used
by native. Node handles gzip decompression; bundled WASM handles bzip2 and zstd.
`off` disables the optional addon, not this portable parser. ZIP uses lazily loaded, required `jszip`, so omitting optional
dependencies does not remove archive functionality.

`FS_SAFE_NATIVE_FALLBACK` warnings are deduplicated per affected feature and do
not include caller paths or native error text. Warnings explain a weaker
mechanism or system-command overhead. They never convert rejected
paths, unknown identity, insecure permissions, I/O failures, or cancellation
into successful results. Explicit global `require` remains a diagnostic choice
that rejects an unavailable addon; it does not prohibit per-feature fallbacks
when a loaded addon's particular primitive is unavailable.

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
remain available without the addon in `auto` and `off`. Their default compatible cleanup uses guarded
JavaScript quarantine when owned native tree removal is unavailable.
`cleanupSafety: "require-bounded"` selects no-replace quarantine and
descriptor-relative owned-tree removal when available, otherwise warns and
uses the existing compatible cleanup owner. Returned objects expose
`cleanupMechanism` so callers can distinguish `"native-bounded"` from
`"guarded-path"`.
On Linux, admission probes the exact `openat2` child-directory flags, including
`RESOLVE_NO_XDEV`, at runtime. An unavailable or denied probe selects compatible
JavaScript cleanup even in global `require` mode. Actual access, mode, and
identity failures retain their existing error or preservation behavior.
Already-created strict workspaces retain their binding
and descriptors across later mode changes.
Explicit global `require` still rejects a missing binding when requested
bounded cleanup attempts to load it.

[`stageFileInDirectory()`](staged-file.md) uses native retained-directory
operations on Linux/macOS when available and guarded Node staging otherwise,
including Windows. Receipts report descriptor-relative or guarded-pathname
`targeting` and the publication `method`. Portable cleanup preserves artifacts
after parent drift instead of claiming access to a renamed directory.

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

- Linux uses `openat2` with `RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS`, `renameat`, and `renameat2(RENAME_NOREPLACE)`. Owned-tree cleanup enumerates and unlinks through retained directory descriptors and rejects device crossings.
- macOS 15.4 and newer prefer `O_RESOLVE_BENEATH`; older kernels resolve components with `O_NOFOLLOW` and restart in-root symlinks from the pinned root descriptor. Both routes use an `F_GETPATH` post-open escape detector and report `best-effort` because directory rename races are not atomic with that check. Publication uses `renameat` for replacement and `renameatx_np(RENAME_EXCL)` for no-replace; owned-tree cleanup uses descriptor-relative `openat`/`unlinkat`.
- Windows uses handle-relative `NtCreateFile`, rejects reparse points during root-bounded traversal, uses `FileRenameInfoEx` with replacement selected explicitly by the TypeScript policy layer, and deletes owned trees through exact opened handles with `FileDispositionInfoEx`; symlink/reparse entries in owned trees are removed as leaves and never traversed. Descriptors crossing N-API are converted only by the host executable's paired `uv_get_osfhandle` and `uv_open_osfhandle` exports. A runtime without both exports is unsupported for these native operations; the binding never guesses a raw HANDLE or uses a foreign CRT descriptor table. Descriptor-producing operations also require that same host's synchronous libuv close and request-management APIs before exporting an owned descriptor.

Native primitives accelerate guarded writes, moves, sidecars, publication,
archives, and Windows security operations. Portable no-clobber moves normally
use exclusive hardlink creation followed by guarded source removal, preserving
the inode and refusing destination collisions atomically. Linux uses a
metadata-only source descriptor. For macOS/Windows files without content-open
permission, built-in JXA or PowerShell/.NET commands perform an atomic no-replace
rename instead. Command startup adds overhead. Moving publication retains the
hardlink fallback. Source removal captures and verifies a private POSIX entry
or deletes a verified Windows source-name handle. This is not one atomic move;
post-publication errors preserve the published name and report retained source
recovery locations. Filesystems without hardlinks use atomic command-based
no-replace rename; Linux needs isolated `/usr/bin/python3` and libc `renameat2`,
while macOS and Windows use their system runtimes. The destination is never
published with a replacing rename.
Copy policies fall back to verified byte copies with a warning when cloning is
unavailable; unavailable clone metadata remains `undefined`.

Windows portable security uses bounded built-in PowerShell/.NET commands.
Secure reads query an inherited descriptor, and private directories receive
their protected DACL at exclusive parent-relative creation. Failed security
queries and unsafe facts remain failures. See
[Native architecture](native.md#javascript-fallback-guarantees-and-delta) for
the mechanism differences.

The guarded JavaScript mutation path is detection-based, not containment-atomic.
If a same-privilege peer can replace a writable parent after its identity guard
but before Node resolves a pathname mutation, the mutation can land outside the
intended root before the post-operation guard throws. Use OS isolation when
that concurrent attacker is part of the threat model, and inspect available
mechanism receipts rather than treating loader mode as an atomicity guarantee.

`openBeneath()` returns `{ fd, containment }`. `containment` is
`"kernel-atomic"` for Linux `openat2` and `"best-effort"` for macOS and
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

The configuration bridge exists only to make shipped 0.4 settings visible and
predictable during the 0.5 upgrade; it does not restore the persistent worker.
The current Linux no-hardlink rename fallback is a separate, isolated one-shot
system command with no interpreter-path configuration.

## Related pages

- [Config](config.md)
- [Security model](security-model.md)
- [Writing](writing.md)
- [File locks](sidecar-lock.md)
- [Durability](durability.md)
- [Migrating to 0.5](migrating-to-0.5.md)
- [Migrating to 0.6](migrating-to-0.6.md)
