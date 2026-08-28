---
title: Native helper policy
description: "How fs-safe loads its bundled native filesystem primitives and how auto, require, and off affect guarded fallbacks."
---

# Native helper policy

`@openclaw/fs-safe` itself contains seven prebuilt binaries for Linux x64/arm64 (glibc or musl), macOS x64/arm64, and Windows x64. The loader selects `dist/native/<target>/fs-safe-native.node` without optional platform packages, downloads, postinstall scripts, or a consumer Rust build. Carrying every target makes the npm tarball larger, but every installation receives the same complete artifact.

```ts
import { configureFsSafeNative } from "@openclaw/fs-safe/config";

configureFsSafeNative({ mode: "auto" });    // default
configureFsSafeNative({ mode: "off" });     // guarded JavaScript only
configureFsSafeNative({ mode: "require" }); // fail closed when the binding is unavailable
```

The equivalent environment variables are `FS_SAFE_NATIVE_MODE` and `OPENCLAW_FS_SAFE_NATIVE_MODE`. Accepted values are `auto`, `off`, `require`, `true`, `false`, `on`, `never`, `required`, `1`, and `0`.

## Modes

| Mode | Behavior |
|---|---|
| `auto` | Prefer native primitives when the current bundled binary loads; otherwise silently use the guarded JavaScript path. |
| `off` | Do not load a bundled binary. Use the guarded JavaScript path deterministically. |
| `require` | Throw `FsSafeError("helper-unavailable")` instead of falling back when an operation needs the native binding and it cannot load. |

Configure the mode once during startup. Loading is lazy and cached; changing from `auto` to `require` after a failed load changes failure policy but does not repeatedly probe the binary.

[`stageFileInDirectory()`](staged-file.md) always requires native support on
Linux/macOS and rejects before creation when off, unavailable, or missing the
required capability. Windows is unsupported for this lifecycle. This does not
change the mode policy of existing fallback-capable APIs.

## Native boundary

The bundled native layer exposes policy-free filesystem mechanisms: beneath-root
open/mkdir/link, replace and no-replace rename, identity reads, archive decode/execution,
clone/copy/hash workers, and Windows security descriptor calls. The TypeScript
layer owns policy, retries, filters, budgets, modes, cleanup, error
normalization, and the decision to fall back.

- Linux uses `openat2` with `RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS`, `renameat`, and `renameat2(RENAME_NOREPLACE)`.
- macOS 15.4 and newer prefer `O_RESOLVE_BENEATH`; older kernels resolve components with `O_NOFOLLOW` and restart in-root symlinks from the pinned root descriptor. Both routes use an `F_GETPATH` post-open escape detector and report `best-effort` because directory rename races are not atomic with that check. Publication uses `renameat` for replacement and `renameatx_np(RENAME_EXCL)` for no-replace.
- Windows uses handle-relative `NtCreateFile`, rejects reparse points, and uses `FileRenameInfoEx` with replacement selected explicitly by the TypeScript policy layer.

Native primitives back create-only and replacing pinned writes, async sidecar creation,
guarded publication, archive acceleration, and direct Windows ACL operations.
Equivalent JavaScript paths remain available for documented fallback-capable
features. See [Native architecture](native.md#javascript-fallback-guarantees-and-delta)
for the exact difference.

The guarded JavaScript mutation path is detection-based, not containment-atomic.
If a same-privilege peer can replace a writable parent after its identity guard
but before Node resolves a pathname mutation, the mutation can land outside the
intended root before the post-operation guard throws. Select `require` rather
than `auto` or `off` when that concurrent attacker is part of the threat model.

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
