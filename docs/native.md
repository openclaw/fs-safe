---
title: Native architecture
description: "The bundled native bindings, fd-relative beneath model, platform mechanisms, loader security, and JavaScript fallback contract."
---

# Native architecture

`@openclaw/fs-safe` bundles native bindings that supply mechanisms Node does
not expose directly. The Rust layer is deliberately not a second policy engine.
TypeScript owns trusted-root selection, path validation, archive filtering,
budgets, modes, identity fencing, cleanup decisions, and error normalization.
Rust receives already-decided relative operations and performs the smallest
platform syscall sequence that can preserve the boundary.

Every operation that has an equivalent safe Node implementation keeps that
guarded JavaScript path. Native loading is lazy; installs do not compile Rust,
run postinstall code, or fetch binaries. The npm tarball carries all seven
supported targets, so it is larger than a per-platform package by design.
Native-only formats and creation-time Windows DACL guarantees fail explicitly
instead of substituting a weaker implementation.

## The beneath model

A trusted directory descriptor is the capability. Native operations accept
that descriptor plus a validated relative path and never reconstruct authority
from a process working directory. Newly created files use exclusive creation,
and TypeScript compares descriptor, pathname, and expected identities before
accepting results.

Conceptually, a caller grants authority to an already-open root—not to a path
string that can be reinterpreted later:

```text
validated Root handle
  └─ relative components (untrusted)
       └─ open/link/mkdir beneath the handle
            └─ compare descriptor + pathname + expected identity
```

The TypeScript layer validates and decides. The native layer never decides
whether a path, archive entry, mode, owner, or cleanup policy is acceptable.

- Linux uses `openat2(RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS)`, fd-relative
  `mkdirat`/`linkat`/`renameat`/`renameat2`, `FICLONE`, and `copy_file_range`.
- macOS 15.4 and newer first use `openat(O_RESOLVE_BENEATH)`; older kernels walk
  components with `openat(O_NOFOLLOW)` and restart in-root symlinks from the
  pinned root. Both routes apply an `F_GETPATH` post-open containment detector,
  but directory rename races mean the result remains `best-effort`, not
  race-atomic. macOS uses `renameatx_np(RENAME_EXCL)` and permits
  `fclonefileat` in an owned, non-shared parent. The clone is normalized inside
  a private staging directory: flags, ACLs, extended attributes, and broad mode
  bits are cleared before no-replace publication.
- Windows uses handle-relative `NtCreateFile` with `OBJ_DONT_REPARSE` and
  `FILE_OPEN_REPARSE_POINT`, then explicitly rejects reparse points. Rename and
  hardlink operations stay rooted in already-open handles. Owner/DACL reads
  use `GetSecurityInfo`; private directories receive their protected DACL in
  the `CreateDirectoryW` call itself.

## Archives

Rust streams ZIP and TAR payloads, including gzip, zstd, and bzip2. It first
returns a bounded manifest. TypeScript applies the shared path, filter, strip,
mode, and byte policies and returns an index-bound extraction plan. Rust then
creates only those planned entries beneath a private staging descriptor.

A fixed-512-byte pass-through meter sits between decompression and the TAR
crate. It reads only header type and octal/base-256 size fields. It never parses
metadata content. Oversized GNU long-name/link metadata is rejected before
buffering; PAX size overrides and GNU sparse entries are rejected as
unmeterable rather than guessed. The JavaScript node-tar path receives the same
`maxMetaEntryBytes` value and a matching fixed-header preflight.

## Publication and hashing

Exclusive publication tries a hardlink, then a copy-on-write clone, Linux
`copy_file_range`, and finally the existing asynchronous JavaScript byte loop.
All routes preserve `wx` semantics and the same source/target identity and
SHA-256 fencing. Native hashing and Linux whole-file copying run on N-API async
workers rather than the JavaScript event loop.

## Mode semantics

| Mode | Native loading | Fallback |
|---|---|---|
| `auto` | Try once, cache the result | Use guarded JavaScript when unavailable |
| `require` | Try once, cache the result | Throw `FsSafeError("helper-unavailable")` |
| `off` | Never attempt a binding load | Always use guarded JavaScript |

The one exception is functionality with no safe JavaScript implementation:
zstd/bzip2 TAR and Windows private-directory creation fail with
`helper-unavailable` when native support is absent or off.

## JavaScript fallback guarantees and delta

Public policy does not change with the selected mechanism: traversal and link
rejection, archive filters/limits/modes, exclusive target creation, source and
target identity fencing, publication cleanup receipts, and secret/lock policy
remain TypeScript-owned. What changes is the syscall strength or availability:

| Capability | Native path | Guarded JavaScript path |
|---|---|---|
| Root-relative opens/mutations | Descriptor-relative beneath operations. Pinned writes create parents and publish both replacement and no-replace targets relative to open directory descriptors. Linux reports `kernel-atomic`; macOS and Windows report `best-effort`. macOS uses `O_RESOLVE_BENEATH` when available plus an `F_GETPATH` detector, while Windows rejects reparse traversal in the object-manager call. | Reports `best-effort`: component-wise alias checks, no-follow opens where Node exposes them, private temp/rename, and post-operation identity verification. A same-privilege peer can replace a writable parent after a guard assertion but before Node resolves the pathname mutation; the mutation may land outside the intended root before the post-check detects it. |
| ZIP/TAR/gzip | Rust streaming decode and fd-relative output creation. | JSZip/node-tar into a private stage, then the same guarded merge policy. |
| Zstd/bzip2 TAR | Supported. | Unsupported; typed `helper-unavailable`. |
| Publication copy | Clone, Linux `copy_file_range`, async native SHA-256. | Exclusive `wx` byte loop and Node SHA-256 with the same content/identity fences. |
| `rename-noreplace` | Atomic platform no-replace rename. | Unsupported; no emulation by check-then-rename. |
| Windows DACL read | Direct `GetSecurityInfo`; the public facts API exposes ordered basic allow/deny ACE SIDs, masks, and decoded flags without trust policy. | Established .NET/`icacls` inspection fallback for coarse permission checks; raw ACE facts are native-only. |
| Windows private directory | Creation-time protected DACL. | Unsupported; no weaker pathname-only substitute. |

Use `off` in CI to keep the fallback contract exercised. Use `require` when a
deployment depends on the stronger mechanism or a native-only feature; do not
infer native loading from timing.

## Loader security

Importing fs-safe never executes a child process. Linux libc selection uses
the Node process report, conventional musl library filenames, and the ELF
`PT_INTERP` field of `process.execPath`. If all probes are inconclusive, the
loader conservatively attempts the bundled glibc binary and lets normal module
loading fail into `auto` fallback. The loader requires only
`dist/native/<target>/fs-safe-native.node`; it never probes optional packages,
downloads code, or runs a postinstall step. A missing or incompatible binary
silently selects the JavaScript fallback in `auto`, throws typed
`helper-unavailable` in `require`, and is never inspected in `off`. Tests reject
`child_process`, `exec`, or `spawn` usage in the loader.

## Related pages

- [Native helper policy](native-helper.md)
- [Security model](security-model.md)
- [Archive extraction](archive.md)
- [Durability](durability.md)
- [Permissions](permissions.md)
- [Migrating to 0.5](migrating-to-0.5.md)
