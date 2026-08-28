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
- rejects directories and, by default, symlink paths
- opens the file before reading and verifies the opened fd still matches the path and realpath
- optionally requires the real path to live under one of `trust.trustedDirs`
- rejects hard-to-verify or unsafe permissions unless `permissions.allowInsecure` is set
- rejects files owned by another POSIX uid
- enforces `maxBytes` before and after reading
- closes the handle on success, error, and timeout

On POSIX, unsafe permissions mean group/world writable, and group/world readable unless `permissions.allowReadableByOthers` is true. On Windows, the helper uses the ACL inspection helpers from [`permissions`](permissions.md) and refuses the read if ACLs cannot be verified.

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

`permissions.allowInsecure` is a migration escape hatch. Prefer fixing permissions and using [`formatPermissionRemediation`](permissions.md) to show the user what to run. `trust.allowNetworkPath` is off by default because UNC paths are remote authority, not local filesystem input. `inject` is for tests and platform adapters; production callers usually leave it unset.

## Errors

`readSecureFile()` throws `FsSafeError` with codes such as:

| Code | Meaning |
|---|---|
| `invalid-path` | `filePath` was not a local absolute path. |
| `not-found` | The path could not be stat'd before open. |
| `not-file` | The opened target is not a regular file. |
| `symlink` | The path is a symlink and `trust.allowSymlink` is false. |
| `path-mismatch` | The path or realpath changed between open and verification. |
| `outside-workspace` | `realPath` is outside `trust.trustedDirs`. |
| `permission-unverified` | Required mode/ACL checks could not be completed. |
| `insecure-permissions` | Mode bits or ACLs grant broader access than allowed. |
| `not-owned` | POSIX owner uid is not the current process uid. |
| `too-large` | File size or bytes read exceeded `maxBytes`. |
| `timeout` | `timeoutMs` elapsed while reading. |

Windows inspection failures remain operational `permission-unverified` errors
and still refuse the read. Their message includes the underlying reason when
available. `details` includes `ownerError` for owner-query failures and, when
command diagnostics are available, `command`, `durationMs`, `timedOut`,
`exitCode`, `signal`, and `stderr`. Reasons and stderr are control-character
escaped and limited to 400 characters each (including a truncation marker).
No stdout or target file contents are copied into these display diagnostics.
The original inspection exception is retained as `cause`; built-in command
errors also retain their original execFile exception in the cause chain.
Treat causes as restricted local diagnostic data. No retries are performed,
and verification order and rejection conditions are unchanged.

## See also

- [Permissions](permissions.md) — standalone POSIX mode and Windows ACL checks.
- [Secret files](secret-file.md) — mode-0600 credential read/write helpers.
- [Reading](reading.md) — root-bounded relative reads.
