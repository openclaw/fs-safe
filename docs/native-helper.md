---
title: Native helper policy
description: "How fs-safe loads its platform-specific native filesystem primitives and how auto, require, and off affect guarded fallbacks."
---

# Native helper policy

`@openclaw/fs-safe` declares exact-version optional packages for Linux
x64/arm64 (glibc or musl), macOS x64/arm64, Windows x64/arm64, and FreeBSD x64/arm64.
The FreeBSD 14.4+ bindings expose the [qualified subset](native.md#freebsd-14-4-and-newer).
Package-manager
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

See [Archive extraction](archive.md) for native, bundled WASM, and ZIP backends.
Native archive-operation failures are terminal; `auto` does not retry them through a
fallback. `require` rejects missing bindings or required capabilities.

A loaded binding may provide only a subset of native operations. Each operation
checks its required capabilities before native dispatch: missing capabilities
select the existing guarded fallback in `auto`, or report `helper-unavailable`
in `require`. A failure from an available native method is still an operation
failure; it is not treated as a missing capability.

Windows owner/DACL inspection, private-directory creation, and secure reads can
use [PowerShell fallbacks](install.md#windows-security-fallback) in `auto` and
`off`; `require` stays strict, and native operation failures remain terminal.
Bun macOS/Linux canonicalization uses the addon under its
[runtime requirements](install.md#bun-runtime).

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

Temp workspaces have an independent `cleanupSafety` policy: `"compatible"`
can use guarded JavaScript cleanup even in native `require` mode;
`"require-bounded"` rejects before child creation without the required cleanup
capabilities. See the [temp workspace contract](temp.md#private-temp-workspaces).
[Retained-directory staging](staged-file.md) requires native support on Linux/macOS
and is unsupported on Windows.

## Native boundary

The internal Darwin descriptor ACL inspector requires its matching native
capability in both `auto` and `require`; `off`, a missing package, or an older
binding without `inspectDarwinAcl` rejects with `helper-unavailable`. Inspection
failure or malformed facts reject with `permission-unverified`; there is no
mode-bit or pathname fallback for this capability. See
[Darwin clone normalization](native.md#the-beneath-model) for descriptor-bound
admission and terminal errors after a clone payload exists.

The native layer exposes policy-free filesystem mechanisms: beneath-root
open/mkdir/link, replace and no-replace rename, identity reads, archive decode/execution,
clone/copy/hash workers, POSIX canonicalization, and Windows security descriptor calls. The TypeScript
layer owns policy, retries, filters, budgets, modes, cleanup, error
normalization, and the decision to fall back.

Platform mechanisms and containment limits are documented in the
[security model](security-model.md#containment-guarantees-by-platform) and
[native architecture](native.md#the-beneath-model).

Linux root lookups reject negative descriptor sentinels before borrowing a handle or resolving a relative path; they never substitute the process working directory for an admitted root. Public Root operations already supply retained, admitted handles.

On Linux and macOS, native asynchronous file-copy admission rejects negative source and parent descriptors before creating a stage, preserving source-before-parent error ordering. Callers must keep nonnegative source and parent descriptors open until the operation settles.

Low-level Unix query, hash, copy, clone, staging, and owned-tree cleanup calls also reject negative descriptors before using them, preserving each operation's path-validation, cancellation, and cleanup order. Descriptor-relative mutations never accept a working-directory sentinel as a retained capability. On modern macOS, beneath opens reject negative roots with `EBADF` before calling `openat`, rather than returning `EIO` after an OS failure or working-directory operation. This check does not establish the validity of arbitrary nonnegative integers: callers must supply live descriptors and retain them until synchronous calls return or asynchronous operations settle.

`replaceDirectoryAtomic()` requires `renameNoReplaceWithIdentity` before it
creates a missing target parent. On POSIX the dedicated entry point keeps the
existing pre-dispatch exact receipt fence but dispatches direct-child names
through the retained parents without another receipt, duplicate, reopen, or
macOS `F_GETPATH`; the documented final source-name substitution window remains
there. Deeper names retain guarded parent traversal.

No-clobber `Root.move()` requires descriptor-relative parent admission. On Linux,
`auto` can use identity-checked link/unlink for files or plain descriptor-relative
rename for directories when `RENAME_NOREPLACE` is unsupported. Directory fallback
can replace an empty directory created concurrently; `require` stays strict.
See the [move contract](writing.md#fs-move-from-to-options) and the
[fallback contract](native.md#javascript-fallback-guarantees-and-delta).

Guarded JavaScript mutations can have out-of-root effects before a post-check
detects a hostile parent swap. Native `require` does not require a kernel-atomic
resolver: inspect the operation's `containment` and use OS isolation for hostile
concurrent actors. The [security model](security-model.md#native-root-mutation-capabilities)
is authoritative for operation and platform guarantees.

## Migration from the Python helper

The Python configuration bridge has been removed. Old Python environment
settings are ignored without a warning, so an old `require` or `off` setting
does not select the corresponding native policy. Configure
`FS_SAFE_NATIVE_MODE` or `configureFsSafeNative()` explicitly. Follow the
[0.5 migration checklist](migrating-to-0.5.md#2-replace-python-helper-configuration)
for the removed settings and current precedence.

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
