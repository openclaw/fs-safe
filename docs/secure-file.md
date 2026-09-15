# Secure file reads

`readSecureFile()` is for absolute file paths that should be treated like credentials or other sensitive local inputs. It is stricter than `fs.readFile()` and different from `root().read()`: the file path is absolute, but the read is still fd-pinned and permission-checked before bytes are returned.

```ts
import { readSecureFile } from "@openclaw/fs-safe/secure-file";

const { buffer, realPath, permissions } = await readSecureFile({
  filePath: "/var/lib/app/auth.token",
  label: "auth token",
  trust: { trustedDirs: ["/var/lib/app"] },
  io: { maxBytes: 16 * 1024, timeoutMs: 5_000 },
});
```

## Checks

The helper:

- requires a local absolute path and rejects UNC/network paths by default
- rejects every non-regular preview and, by default, symlink paths
- opens POSIX paths no-follow and nonblocking before reading, then verifies the opened fd still matches the path and realpath; a FIFO swap cannot block before `timeoutMs` owns the byte read
- optionally requires the real path to live under one of `trust.trustedDirs`
- rejects hardlink aliases using descriptor, pathname, and realpath link counts, then rechecks the descriptor after reading before returning bytes
- rejects hard-to-verify or unsafe permissions unless `permissions.allowInsecure` is set
- rejects files owned by another POSIX uid
- enforces `maxBytes` before and after reading
- closes the handle on success, error, and timeout

On POSIX, unsafe permissions mean group/world writable, and group/world readable unless `permissions.allowReadableByOthers` is true. On Windows, the helper queries owner, DACL, and locality from the same open descriptor that supplies the bytes. The native query returns the 32-bit volume serial and 64-bit file-index projection used by Node, which must equal Node's bigint descriptor receipt before its ACL facts are trusted. This avoids JavaScript number rounding but does not represent the full 128-bit file identity available on ReFS. Only the current user, LocalSystem, and built-in Administrators are trusted owner classes.

Windows secure reads require the matching current optional native package. A missing or stale helper, fd-to-handle conversion failure, denied `READ_CONTROL`, remote handle, incomplete descriptor, or unsupported ACE form rejects with `permission-unverified` before content is read. A malformed or different handle identity rejects with `path-mismatch`. There is no pathname-command fallback for `readSecureFile()`; the standalone reporting APIs in [`permissions`](permissions.md) retain their documented fallbacks. `permissions.allowInsecure` remains the explicit escape hatch and bypasses the ACL query.

Descriptor, pathname, and realpath identity checks use bigint stats internally to avoid JavaScript number rounding. The returned `stat` remains a normal Node `Stats` object with numeric fields. A zero Windows device or inode is unverified, never a match: the helper re-inspects that identity once using the same descriptor or pathname, then rejects persistent ambiguity with `path-mismatch`. A definite mismatch rejects immediately; retries retain known identity components and still enforce symlink policy.

## Options

```ts
type SecureFileReadOptions = {
  filePath: string;
  label?: string;
  trust?: {
    trustedDirs?: string[];
    allowSymlink?: boolean;
    allowNetworkPath?: boolean;
  };
  permissions?: {
    allowInsecure?: boolean;
    allowReadableByOthers?: boolean;
  };
  inject?: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    exec?: PermissionExec;
  };
  io?: {
    maxBytes?: number;
    timeoutMs?: number;
  };
};
```

`io.maxBytes` must be a non-negative safe integer or positive `Infinity`; zero is an active cap and `Infinity` disables the cap. Invalid limits reject before filesystem admission.

`permissions.allowInsecure` is a migration escape hatch. Prefer fixing permissions and using [`formatPermissionRemediation`](permissions.md) to show the user what to run. `trust.allowNetworkPath` is off by default because UNC paths are remote authority, not local filesystem input. `inject` is for tests and platform adapters; production callers usually leave it unset.

On an actual Windows process with effective `platform: "win32"`, `inject.env` and `inject.exec` do not replace descriptor inspection. They remain available to simulated Windows checks on non-Windows hosts.

`permissions.allowInsecure` bypasses only permission checks. Neither it nor `inject.platform` changes filesystem identity verification, which always uses the actual process platform. `trust.allowSymlink` permits an alias but still requires its target and realpath to match the opened descriptor.

## Errors

`readSecureFile()` throws `FsSafeError` with codes such as:

| Code | Meaning |
|---|---|
| `invalid-path` | `filePath` was not a local absolute path, or a Windows `filePath`/trusted directory used an alternate-stream or filesystem-namespace alias. |
| `not-found` | The path could not be stat'd before open. |
| `not-file` | The opened target is not a regular file. |
| `symlink` | The path is a symlink and `trust.allowSymlink` is false. |
| `hardlink` | The descriptor, pathname, or realpath has more than one link. |
| `path-mismatch` | The path or realpath changed between open and verification, or filesystem identity could not be verified after bounded re-inspection. |
| `outside-workspace` | `realPath` is outside `trust.trustedDirs`. |
| `permission-unverified` | Required mode/ACL checks could not be completed, including when descriptor-bound Windows inspection is unavailable. |
| `insecure-permissions` | Mode bits or ACLs grant broader access than allowed. |
| `not-owned` | POSIX owner uid is not the current process uid. |
| `too-large` | File size or bytes read exceeded `maxBytes`. |
| `timeout` | `timeoutMs` elapsed while reading. |

Windows descriptor-inspection failures are operational `permission-unverified`
errors and refuse the read. The original native exception is retained as
`cause`; treat causes as restricted local diagnostic data. No pathname or ACL
content is copied into the display message. Test adapters that simulate Windows
on another operating system retain the standalone pathname inspector's
structured command diagnostics (`ownerError`, `command`, `durationMs`,
`timedOut`, `exitCode`, `signal`, and bounded escaped `stderr`). Actual Windows
secure reads do not start those commands. No retries are performed.

## See also

- [Permissions](permissions.md) — standalone POSIX mode and Windows ACL checks.
- [Secret files](secret-file.md) — mode-0600 credential read/write helpers.
- [Reading](reading.md) — root-bounded relative reads.
