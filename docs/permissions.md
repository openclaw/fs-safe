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

`inspectPathPermissions()` follows symlink targets for the effective mode but tells you whether the original path was a symlink. On POSIX it reports owner/group/world bits. On Windows it delegates to the ACL helpers below and also reports `ownerSid` plus `ownerTrusted` when ownership can be verified. `ownerTrusted` is true only for a local volume owned by the current user, LocalSystem, or built-in Administrators; remote filesystems fail closed. This remains a pathname reporting API with the fallbacks described below. `readSecureFile()` queries descriptor-bound owner/DACL facts for the exact handle it reads, using the addon or the built-in Windows system-command fallback.

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

The fallback Windows inspector reads the owner and DACL together through one
built-in Windows PowerShell/.NET query. It returns canonical SIDs and numeric
access masks, so Unicode paths and account names do not pass through lossy
console display text. `inspectWindowsAcl()` uses native descriptor facts for
complete local ACLs with nonzero inherited ACEs (or empty/null DACLs) when the
optional Windows binding is available. It applies
the same classifier to native facts and the fallback query, returning canonical
SIDs in its `principal` fields with normalized rights tokens. Explicit `env` or
`exec` options retain the query path. Disabled or unavailable native helpers,
remote or incomplete descriptors, leaf symbolic links, and native query errors
use the fallback. Explicit ACEs and zero-mask entries also retain the query so
.NET continues to own its ACE ordering and normalization.
Structured ACLs containing only canonical SIDs are classified directly from
the current-user SID without requiring a separate account-name lookup.
The advanced options retain `currentUserSid` as an explicit classification
override and `principalTranslationFailed: true` as an immediate unverified
result. The optional `principalSids` translation cache is still accepted but
is no longer needed because the query returns SIDs directly.
The existing classifier assigns principals to trusted, world, or group;
trusted defaults include the current user, SYSTEM, and Administrators.
The built-in query has a fixed 30-second process deadline. A command failure or timeout returns an
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
The parser and remediation command builders remain on the advanced surface for
CLIs processing captured `icacls` output or presenting an explicit repair.
Runtime inspection does not parse that display text. A null DACL reports
unrestricted access; an empty DACL grants nothing. Inherit-only ACEs do not
apply to the inspected object, and deny ACEs never subtract coarse grants or
claim effective-access evaluation. Unsupported ACE layouts remain unverified.

When the native binding is available, `inspectPathPermissions()`
reads the owner and DACL directly with Windows security APIs. It classifies the
current user, LocalSystem, and built-in Administrators as trusted and reports
the world/group read/write facts consumed by secure reads. Descriptor forms it
cannot classify equivalently fall back to the structured .NET query; `mode: "off"` exercises that fallback deterministically.

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
When the native binding or capability is unavailable or forced off, Windows
uses a bounded built-in Windows PowerShell/.NET command. It reads the raw OS
security descriptor and retains ACE order and flags without .NET access-rule
normalization. This synchronous API waits for the command, which has a
30-second deadline and a bounded output budget. A warning is emitted once
because system-command inspection is slower. Failed commands and invalid
descriptor responses reject; they do not produce empty or trusted ACL facts.
The existing coarse `inspectPathPermissions()` API still owns its separate
compatibility fallback and trust classification.

## Private directories

```ts
import path from "node:path";
import { createPrivateDirectory } from "@openclaw/fs-safe/permissions";

const sqliteDirectory =
  "C:\\Users\\me\\AppData\\Local\\OpenClaw\\private-databases";
await createPrivateDirectory(sqliteDirectory);
await openSqlite(path.join(sqliteDirectory, "sessions.sqlite"));
```

On Windows, this creates the directory and applies a protected owner +
LocalSystem + Administrators full-control DACL atomically. The addon is the
fast path. When it or its capability is unavailable or forced off, a bounded
built-in Windows PowerShell/.NET command uses the same OS handle operations;
the directory is created privately, without a later pathname permission repair.
Both mechanisms retain the parent and exact created-directory handles
through ACL and final pathname validation. If validation fails, it attempts only
nonrecursive deletion through the created handle, preserving any pathname
replacement. If cleanup also fails, the error retains the original failure and
includes the cleanup failure.

Directory association checks compare the complete 64-bit volume serial and
128-bit `FILE_ID_INFO` identity, including on ReFS. If that identity class is
unavailable, the operation fails closed without a narrower file-index fallback.
Validation confirms that the created directory is local, its DACL is protected
from inheritance, and its final public pathname opens the same local directory.

This is a point-in-time pathname association check. The function closes its
handles before returning; callers must keep the pathname's ancestry trusted
during subsequent use, including opening SQLite databases in the example above.
The immediate parent and final directory must not be reparse points. Earlier
ancestor reparse points can be followed; this API does not reject every reparse
point in the full ancestry.

Path components ending in a space or period are rejected before filesystem
operations to avoid differing Win32 and native pathname interpretations. This
also rejects explicit `.` and `..` components, including spellings such as
`.\private` and `parent\..\private`, as a compatibility restriction. Simple
relative names without these components remain supported.

This API is Windows-only; it fails with `FsSafeError("helper-unavailable")` on
other platforms. Missing or disabled addons use the system-command fallback,
with a warning once about its additional process overhead. Existing paths still
reject with `EEXIST`, and unsafe or unverifiable state still rejects. The command
has a 30-second deadline and needs the built-in Windows PowerShell/.NET host.
An interrupted command can leave its privately created directory for caller
cleanup; it never guesses ownership to remove a pathname after interruption.
POSIX callers should create private
directories through their existing trusted-root creation policy rather than a
pathname-only compatibility shim. Existing Windows permission inspection still
retains its structured .NET compatibility fallback.

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
- [Migrating to 0.5](migrating-to-0.5.md) — historical native-helper migration.
