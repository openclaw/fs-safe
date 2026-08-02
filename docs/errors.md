# Errors

Every failure that's the library's job to surface lands as an `FsSafeError` with a closed `code` union you can branch on. Catch by code, not by message text — messages may change, codes will not.

```ts
import { FsSafeError, type FsSafeErrorCode } from "@openclaw/fs-safe";
```

## Shape

```ts
class FsSafeError extends Error {
  readonly name: "FsSafeError";
  readonly code: FsSafeErrorCode;
  readonly category: "policy" | "operational";
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: FsSafeErrorCode,
    message: string,
    options?: { cause?: unknown; details?: Readonly<Record<string, unknown>> },
  );
}
```

`cause` is available through the standard `Error` `cause` property when the failure was triggered by a `NodeJS.ErrnoException` (e.g. a wrapped `EACCES`). Inspect it for the original `code` / `errno` / `syscall` if you need finer-grained reporting.

`details` is an operation-specific receipt, not an alternate error code. For
example, `publishFileExclusive()` uses it to report the failing phase, created
target identity, cleanup decision, and failed directory-sync outcome. Narrow
by `code` and a documented details field before consuming it; do not assume all
`FsSafeError` instances carry the same keys.

`replaceFileAtomic({ copyFallbackRestore: "restore-original" })` reports a
failed copy fallback with the exported `ReplaceFileAtomicRestoreFailureDetails`
shape:

```ts
type ReplaceFileAtomicRestoreFailureDetails = {
  cleanup: "restored" | "restore-failed";
};
```

Both outcomes use `code: "helper-failed"`. `"restored"` means the original
snapshot was written back and fsynced through the pinned destination handle.
`"restore-failed"` means both the replacement and recovery failed; `cause` is
an `AggregateError` containing both failures. A snapshot that exceeds
`maxRestoreBytes` fails earlier with `too-large` and does not overwrite the
destination.

`category` separates caller-policy failures from operational failures:

- `"policy"` — unsafe input or target state rejected by a safety policy, such as `outside-workspace`, `symlink`, `hardlink`, or `too-large`.
- `"operational"` — routine filesystem outcomes or environment/runtime failures, such as `not-found`, `not-empty`, `not-removable`, helper startup, platform support, timeout, or unverifiable permissions.

Routine absence or inability to remove a path does not by itself indicate a
filesystem boundary violation. Branch on the specific code when the distinction
between those operational outcomes matters.

## Code union

```ts
type FsSafeErrorCode =
  | "already-exists"
  | "denied-path"
  | "device-path"
  | "hardlink"
  | "helper-failed"
  | "helper-unavailable"
  | "insecure-permissions"
  | "invalid-path"
  | "not-empty"
  | "not-file"
  | "not-found"
  | "not-owned"
  | "not-removable"
  | "outside-workspace"
  | "path-alias"
  | "path-mismatch"
  | "permission-unverified"
  | "secret-exists"
  | "symlink"
  | "timeout"
  | "too-large"
  | "unsupported-platform";
```

## Code reference

| Code | When it fires | Common causes |
|---|---|---|
| `already-exists` | `create()`, `createJson()`, `move({ overwrite: false })`. | Target file or directory already at the destination. |
| `denied-path` | A root mutation matched `denyMutations.paths` or `denyMutations.prefixes`. | Caller configured application-sensitive paths that must not be written, removed, moved, or created. |
| `device-path` | A read/open target is a known unsafe device or process-fd path. | `/dev/zero`, `/dev/random`, `/dev/stdin`, `/dev/fd/*`, `/proc/*/fd/*`, or a Windows reserved device name. |
| `hardlink` | Read or copy with `hardlinks: "reject"` saw `nlink > 1`. | File is hardlinked — possibly an alias of an out-of-tree inode. |
| `helper-failed` | A native mechanism or multi-step operational helper failed. | Inspect `cause` and any operation-specific `details`; retrying may be unsafe if the operation partially completed. |
| `helper-unavailable` | Required native binding could not be loaded. | Unsupported platform, missing/incompatible bundled binary, or `FS_SAFE_NATIVE_MODE=require`. `auto` falls back where possible; `require` fails closed. |
| `insecure-permissions` | A secure file or path permission check found a mode/ACL that allows broader access than requested. | File or directory is group/world writable/readable; Windows ACL grants broad read. |
| `invalid-path` | Input was empty, contained NUL, was an unparseable URL, or otherwise unusable. | Caller didn't validate input; input was a network path on Windows. |
| `not-empty` | `remove()` on a non-empty directory. | Use `replaceDirectoryAtomic` or remove children first. |
| `not-file` | Read or copy targeted a non-regular file. | Target was a directory, FIFO, socket, device. |
| `not-found` | The target does not exist (or its parent does not, with `mkdir: false`). | Typical missing-file case. |
| `not-owned` | A secure file owner check failed. | File is owned by another UID. |
| `not-removable` | `remove()` couldn't `unlink`/`rmdir` for a reason other than non-empty. | Permissions, device busy, immutable bit. |
| `outside-workspace` | Path resolves outside the configured root. | `..` traversal; absolute path outside the root; symlink resolved out. |
| `path-alias` | A path alias check failed (e.g. canonical-real-path moved out of the root). | Symlink resolution lands outside the root. |
| `path-mismatch` | Post-open identity check failed: the opened fd does not match the resolved path. | TOCTOU — something else swapped the path between resolve and open. |
| `permission-unverified` | A secure file check could not verify required permissions. | Windows ACL inspection failed; POSIX ownership/mode was unavailable. |
| `secret-exists` | `createSecretFileAtomic()` found an existing final path. | First-writer-wins secret creation lost a race or the credential was already initialized. |
| `symlink` | Path component is a symlink, policy is `reject`. | Caller followed a symlink they shouldn't have, or `symlinks: "reject"` is set. |
| `timeout` | An operation with a wall-clock budget overran. | Secure file read or timed operation exceeded `timeoutMs`. |
| `too-large` | A read or bounded walk exceeded its configured budget. | Caller gave a too-permissive file or traversal limit. |
| `unsupported-platform` | The requested operation is not supported on the current platform. | E.g. POSIX-only helper invoked on Windows. |

## Branching

```ts
import { FsSafeError } from "@openclaw/fs-safe";

try {
  await fs.write("../escape.txt", "x");
} catch (err) {
  if (!(err instanceof FsSafeError)) throw err;
  switch (err.code) {
    case "outside-workspace":
      return reply(400, "path escapes workspace");
    case "already-exists":
      return reply(409, "exists");
    case "too-large":
      return reply(413, "too large");
    case "not-found":
      return reply(404, "missing");
    case "symlink":
    case "device-path":
    case "hardlink":
    case "path-mismatch":
    case "path-alias":
      return reply(400, "unsafe path");
    default:
      throw err;
  }
}
```

The compiler will flag missing cases when you exhaust the union — keep your switch up-to-date as the library adds new codes.

## Distinguishing from `NodeJS.ErrnoException`

Some failures bubble up as native Node errors (e.g. `EACCES`, `EPERM`, `EISDIR`, `EBUSY`) when they don't map cleanly to a library code. Inspect both:

```ts
import { FsSafeError } from "@openclaw/fs-safe";

try {
  await op();
} catch (err) {
  if (err instanceof FsSafeError) {
    handleFsSafe(err);
    return;
  }
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "EACCES" || code === "EPERM") {
    handleAccess();
    return;
  }
  throw err;
}
```

A common pattern is to wrap your domain code in a single try/catch that maps both shapes to your application's typed error format.

On Windows, access-denied failures from native operations use `EPERM` to match Node/libuv and the JavaScript fallback. Older fs-safe versions could report `EACCES` for the same native condition, so consumers spanning versions should accept both codes.

## Specialty errors

A handful of helpers throw their own typed errors instead of `FsSafeError`:

- `JsonFileReadError` — thrown by [`readJson`](json.md). Carries `cause` so you can distinguish missing (`ENOENT`) from invalid (`SyntaxError`).
- `ArchiveLimitError` — thrown by [`extractArchive`](archive.md) when an archive size, entry count, path depth, metadata, or extracted-byte budget is exceeded. The `code` field uses the string values exposed by `ARCHIVE_LIMIT_ERROR_CODE` (for example `archive-entry-path-components-exceeds-limit`).
- `ArchiveSecurityError` — thrown by extraction when entry policy or destination safety fails. Entry codes are `entry-path`, `entry-link`, and `entry-filtered`; destination codes cover non-directory, symlink, and symlink-traversal failures.

These are exported from their respective subpaths.

## Why `FsSafeError`?

Two reasons it isn't a richer hierarchy of subclasses:

1. **Switch on `code`, don't `instanceof` a tree.** `code` is a closed string union the TypeScript compiler can exhaust-check. Subclasses make `instanceof` ladders that drift over time.
2. **One catch handler.** Library callers often want a single "is this an `fs-safe` failure?" gate before deciding what to do — `instanceof FsSafeError` plus a switch is the cleanest expression of that.

## See also

- [`root()`](root.md) — every method documents the codes it can throw.
- [Reading](reading.md) — read-path codes.
- [Writing](writing.md) — write-path codes.
- [Archive extraction](archive.md) — `ArchiveLimitError` and `ArchiveSecurityError`.
