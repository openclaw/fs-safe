# Platform filesystem capabilities

These synchronous capabilities load the native helper only when called. All
three entry points import on every supported platform.

## Linux write leases

`tryAcquireWriteLease(fd)` from `@openclaw/fs-safe/file-lock` returns a frozen
`FileWriteLease`, or `null` when another open descriptor prevents acquisition
(`EAGAIN` or `EBUSY`). Other failures throw `FsSafeError`; unsupported systems
throw `unsupported-platform` and unavailable helpers throw `helper-unavailable`.

The caller owns the descriptor, must keep it open until release, and must install
its own process-wide `SIGIO` handler **before** acquiring a lease. Prefer a
disposable child process when an application cannot own that signal. The API
does not install a signal handler. A competing open starts the kernel's lease
break; `isHeld()` then returns false, including during a pending downgrade.
Release promptly so the competing opener can proceed.

`lease.fd` is the borrowed descriptor. `lease.release()` and
`lease[Symbol.dispose]()` settle once without closing it; `isHeld()` returns
false after release. Never close or reuse the fd before settling the lease.
Lease acquisition does not replace the caller's path identity and age checks.

## Darwin ACL inspection

`inspectDarwinAcl(path)` from `@openclaw/fs-safe/permissions` opens the final
component without following symlinks, then inspects a descriptor-bound security
snapshot. Its `DarwinAclInspection` result is one of:

- `{ kind: "none" }` for a proven absent or empty extended ACL.
- `{ kind: "present", inheritsToFiles, inheritsToDirectories }` for an ACL with
  entries, including when both inheritance flags are false.
- `{ kind: "unknown", reason }` when opening or inspection fails, the helper
  is unavailable, or the native facts are incomplete. Other platforms return
  `reason: "unsupported-platform"`.

Unknown is never evidence of absence. The two inheritance booleans report flag
presence, not effective permissions or volume ownership enforcement. Intermediate
path components follow ordinary path resolution; this is inspection, not a Root
confinement capability.

## Windows test fixtures

The following exports from `@openclaw/fs-safe/test-hooks` are for tests, not
production policy. They require the Windows native helper and reject final
reparse points. Other platforms throw `unsupported-platform`.

- `holdWindowsSharingLock(path)` returns a frozen disposable with idempotent
  `close()`. Its native owner holds a non-inheritable handle with read/write
  sharing, omitting delete sharing, until closed or collected.
- `setWindowsFileAttributes(path, { readOnly?, hidden?, system? })` updates the
  supplied bits through the opened handle and preserves unspecified attributes.
- `readWindowsFileExtents(path)` returns `{ vcn, lcn, clusters }[]`, all bigint.
  Empty or resident files may have no extents; `lcn: -1n` denotes sparse clusters.
  Enumeration validates each response and fails on incomplete or invalid data.
  It is an observation, not a snapshot against concurrent file modification.

Use Node's `fs.statfsSync(path).bsize` for Windows cluster size. Windows CI
compares it directly against `GetDiskFreeSpaceW`'s sectors-per-cluster times
bytes-per-sector on NTFS. CI does not provide ReFS; this does not establish ReFS
clone sharing. The extent reader reports mappings independently of the clone
implementation.
