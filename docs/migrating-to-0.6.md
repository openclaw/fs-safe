---
title: Migrating to 0.6
description: "Upgrade checklist for the platform-native package split."
---

# Migrating from 0.5 to 0.6

Version 0.6 moves native bindings out of the root `@openclaw/fs-safe` tarball
and into exact-version platform packages. This removes unrelated operating
system and architecture binaries from each installation.

## Keep optional dependencies enabled for native mode

Package managers select one binding by OS, CPU, and Linux libc. A normal
install needs no command change:

```bash
pnpm add @openclaw/fs-safe
```

If a deployment currently installs 0.5 with `--omit=optional`, `--no-optional`,
or an equivalent lockfile policy, change that policy before upgrading when it
uses native mode `require` or any native-only feature. Version 0.5 kept its
binding in the root tarball; version 0.6 intentionally does not.

Omitting optional dependencies remains supported for fallback-capable APIs in
`auto` mode. It disables native-only features such as zstd/bzip2 TAR handling,
retained-directory staging, atomic `rename-noreplace`, and Windows private
directory creation. Native mode `require` reports `helper-unavailable` when the
matching package is absent or incompatible.

## Deployment checklist

1. Remove any option or policy that omits optional dependencies when native
   support is required.
2. Regenerate every lockfile or shrinkwrap file consumed by deployment.
3. Verify that the lock contains the matching `@openclaw/fs-safe-*` package.
4. Run a native-required operation on every deployed OS/libc target.
5. Keep an `FS_SAFE_NATIVE_MODE=off` lane when the guarded JavaScript fallback
   is part of the application contract.

No Rust toolchain, postinstall build, or runtime download is introduced. See
[Native helper policy](native-helper.md) for the exact fallback boundary.
