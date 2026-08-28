# Permissions

`@openclaw/fs-safe/permissions` contains the curated mode and permission inspection helpers used by secure file reads and by applications that want to report actionable permission problems.

```ts
import {
  formatPermissionDetail,
  formatPermissionRemediation,
  inspectPathPermissions,
} from "@openclaw/fs-safe/permissions";

const perms = await inspectPathPermissions("/var/lib/app/auth.token");
console.log(formatPermissionDetail("/var/lib/app/auth.token", perms));
if (perms.ok && (perms.groupReadable || perms.worldReadable)) {
  console.log(
    formatPermissionRemediation({
      targetPath: "/var/lib/app/auth.token",
      perms,
      isDir: false,
      posixMode: 0o600,
    }),
  );
}
```

## POSIX helpers

```ts
safeStat(path);
inspectPathPermissions(path, options?);
formatPermissionDetail(path, check);
formatPermissionRemediation({ targetPath, perms, isDir, posixMode });
modeBits(mode);
formatOctal(bits);
isWorldWritable(bits);
isGroupWritable(bits);
isWorldReadable(bits);
isGroupReadable(bits);
```

POSIX remediation strings shell-quote paths with whitespace or metacharacters
and protect option-like paths with `--`, so they can be presented as commands
without letting the inspected pathname add shell syntax.

`inspectPathPermissions()` follows symlink targets for the effective mode but tells you whether the original path was a symlink. On POSIX it reports owner/group/world bits. On Windows it delegates to the ACL helpers below and also reports `ownerSid` plus `ownerTrusted` when ownership can be verified. `ownerTrusted` is true only for a local volume owned by the current user, LocalSystem, or built-in Administrators; remote filesystems fail closed. Secure reads and callers that protect credential-bearing execution require `ownerTrusted === true`.

## Advanced Windows ACL helpers

The low-level Windows ACL parser and `icacls` command builders live in `@openclaw/fs-safe/advanced`:

```ts
import {
  createIcaclsResetCommand,
  formatIcaclsResetCommand,
  formatWindowsAclSummary,
  inspectWindowsAcl,
  parseIcaclsOutput,
  resolveWindowsUserPrincipal,
  summarizeWindowsAcl,
} from "@openclaw/fs-safe/advanced";

inspectWindowsAcl(path, { env, exec });
parseIcaclsOutput(output, targetPath);
summarizeWindowsAcl(entries, env);
formatWindowsAclSummary(summary);
formatIcaclsResetCommand(targetPath, { isDir, env });
createIcaclsResetCommand(targetPath, { isDir, env });
resolveWindowsUserPrincipal(env);
```

The fallback Windows inspector calls `icacls.exe <path>` using its supported
path-only inspection syntax and classifies principals as trusted, world, or
group. Trusted defaults include the current user, SYSTEM, and Administrators.
Built-in PowerShell, `icacls.exe`, and `whoami.exe` invocations have a fixed
30-second per-process deadline. A command failure or timeout returns an
unverified result (`source: "unknown"`) so callers fail closed. Advanced callers
that inject a custom `exec` implementation own that executor's deadline.
Failed owner and ACL inspections retain `error` text and an optional
`errorDetail: PermissionCommandFailure` with `command`, integer `durationMs`,
`timedOut`, `exitCode`, `signal`, and `stderr`. The type is exported from both
`@openclaw/fs-safe/permissions` and `@openclaw/fs-safe/advanced`. Built-in
execution measures elapsed time; injected execFile-shaped failures receive
best-effort command diagnostics. Plain errors have no `errorDetail`.
Display reasons and stderr escape control characters and are limited to 400
characters, including a trailing `…` when truncated. Diagnostics do not copy
stdout or read target file contents. The separate `errorCause` retains the
original exception for restricted local diagnosis; do not serialize or expose
it as display text.
The parser is on the advanced surface so tests and CLIs can process captured
`icacls` output without spawning a process.

When the bundled native binding is available, `inspectPathPermissions()`
reads the owner and DACL directly with Windows security APIs. It classifies the
current user, LocalSystem, and built-in Administrators as trusted and reports
the world/group read/write facts consumed by secure reads. Descriptor forms it
cannot classify equivalently fall back to the established owner/.NET and
`icacls` path; `mode: "off"` exercises that fallback deterministically.

## Policy-free owner and DACL facts

`readOwnerAndDacl()` exposes the direct Windows descriptor facts needed by a
consumer that owns a principal allowlist. It deliberately does not decide
which SID is trusted or calculate effective access. For example, snapshot
staging can reject an incomplete descriptor and ignore inherit-only ACEs before
applying its own exact SID policy:

```ts
import { readOwnerAndDacl } from "@openclaw/fs-safe/permissions";

const facts = readOwnerAndDacl(stagingDirectory);
if (facts.status === "unsupported-platform") {
  throw new Error(`Windows ACL facts unavailable on ${facts.platform}`);
}
if (!facts.isLocal || !facts.daclPresent || !facts.complete) {
  throw new Error("staging DACL cannot be evaluated completely");
}

for (const ace of facts.aces) {
  if (ace.flags.inheritOnly) continue;
  if (!trustedSids.has(ace.sid)) {
    throw new Error(`unexpected staging principal: ${ace.sid}`);
  }
  evaluateMaskAndDenyOrder(ace.aceType, ace.mask);
}
```

On Windows the supported result contains `ownerSid`, `currentUserSid`,
`daclPresent`, `isLocal`, `complete`, `unsupportedAceTypes`, and ordered basic
allow/deny `aces`. `currentUserSid` is the process token's `TokenUser` SID, so
callers can compare it with the owner or their own allowlist without fs-safe
applying trust policy. Each ACE has `{ sid, mask, aceType, flags }`; `flags`
retains the raw byte and decoded
`objectInherit`, `containerInherit`, `noPropagateInherit`, `inheritOnly`,
`inherited`, `successfulAccess`, and `failedAccess` facts. SID strings are
lowercase Windows SID notation. `daclPresent: false` represents a null DACL,
which grants unrestricted access; it must not be mistaken for an empty DACL.

Object-specific and other ACE layouts are not guessed: they are omitted,
`complete` becomes false, and their numeric types appear in
`unsupportedAceTypes`, allowing a security-sensitive caller to fail closed.
Non-Windows systems return `{ status: "unsupported-platform", platform }`.
Windows requires the bundled native binding; if it is unavailable or forced
off, the call throws `FsSafeError("helper-unavailable")`. The existing coarse
`inspectPathPermissions()` API still owns its compatibility fallback and trust
classification.

## Private directories

```ts
import path from "node:path";
import { createPrivateDirectory } from "@openclaw/fs-safe/permissions";

const sqliteDirectory =
  "C:\\Users\\me\\AppData\\Local\\OpenClaw\\private-databases";
await createPrivateDirectory(sqliteDirectory);
await openSqlite(path.join(sqliteDirectory, "sessions.sqlite"));
```

On Windows with native support, this creates the directory and applies a
protected owner + LocalSystem + Administrators full-control DACL directly with
an atomic security descriptor; no PowerShell or `icacls` process is launched.
This API is Windows-only and native-only; it fails closed with
`FsSafeError("helper-unavailable")` on other platforms, when native mode is off,
or when the binding is unavailable. POSIX callers should create private
directories through their existing trusted-root creation policy rather than a
pathname-only compatibility shim. Existing Windows permission inspection still
retains its .NET/`icacls` compatibility fallback.

Use `createIcaclsResetCommand()` when you need a structured command and argv pair. Use `formatIcaclsResetCommand()` when you only need a remediation string for a user-facing message.

## Types

```ts
type PermissionCheck = {
  ok: boolean;
  isSymlink: boolean;
  isDir: boolean;
  mode: number | null;
  bits: number | null;
  source: "posix" | "windows-acl" | "unknown";
  worldWritable: boolean;
  groupWritable: boolean;
  worldReadable: boolean;
  groupReadable: boolean;
  ownerSid?: string;
  ownerTrusted?: boolean;
  ownerError?: string;
  aclSummary?: string;
  error?: string;
};
```

`ok: false` means the path itself could not be inspected. `ok: true` with `source: "unknown"` means basic stat information was available, but the platform-specific permission source could not be verified.

## See also

- [Secure file reads](secure-file.md) — fd-pinned reads that enforce these checks.
- [Errors](errors.md) — permission-related `FsSafeError` codes.
- [Native architecture](native.md) — direct Windows security descriptor mechanisms.
- [Migrating to 0.5](migrating-to-0.5.md) — native-only feature checklist.
