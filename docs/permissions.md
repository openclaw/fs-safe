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

`inspectPathPermissions()` follows symlink targets for the effective mode but tells you whether the original path was a symlink. On POSIX it reports owner/group/world bits. On Windows it delegates to the ACL helpers below and also reports `ownerSid` plus `ownerTrusted` when ownership can be verified. `ownerTrusted` is true only for a local volume owned by the current user, LocalSystem, or built-in Administrators; remote filesystems fail closed. This remains a pathname reporting API with the fallbacks described below. `readSecureFile()` obtains descriptor-bound owner/DACL facts for the exact handle it reads, using native support or the packaged PowerShell/C# bridge in `auto` and `off` modes.

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
built-in Windows PowerShell/.NET query. The query addresses its JSON command by
module name and limits module discovery to PowerShell's bundled system modules.
It returns canonical SIDs and numeric access masks, so Unicode paths and account
names do not pass through lossy console display text. `inspectWindowsAcl()` uses native descriptor facts for
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
Injected executors must return the same structured success JSON as the built-in
query: valid `ownerSid` and `currentUserSid` strings, an explicit boolean
`remote`, and complete DACL facts (`complete`, `daclPresent`, and `aces`).
Missing or nonboolean locality leaves both inspectors unverified; only
`remote: false` establishes locality for owner trust. An explicit `remote: true`
retains the ACL report but never grants trusted ownership.
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
Custom executors may reject with any JavaScript value. The fallback display
formatter handles primitives directly and reads only string-valued `name` and
`message` data descriptors through a small, fixed prototype budget. It does not
coerce objects, invoke accessors, or inspect proxy targets; unavailable display
facts use a bounded generic reason. Command fields follow the same best-effort
data-descriptor rule. Raw string, `Buffer`, or genuine `Uint8Array` stderr
retains the sanitization above. Byte stderr is copied through captured
typed-array intrinsics into a private bounded snapshot before replacement-based
UTF-8 decoding; receiver properties, iterators, constructors, and altered
prototypes are not consulted. Detached or out-of-bounds byte views contribute
no stderr detail. These diagnostic limits do not relax permission policy:
incomplete owner or ACL inspection remains unverified, and `errorCause` remains
the exact rejected value even when no display metadata is safe to obtain.
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
Windows prefers the native binding. In native `auto` or `off` mode, a missing
binding or capability uses the packaged PowerShell/C# bridge with
the same raw ACE projection. Native `require` rejects either absence with
`FsSafeError("helper-unavailable")` and starts no command. An available native
query's failure is terminal. The existing coarse `inspectPathPermissions()` API
still owns its compatibility fallback and trust classification.

### Asynchronous batches

Use `readOwnerAndDaclBatch()` when several paths, such as a directory and its
ancestors, need inspection without blocking the caller's event loop:

```ts
import { readOwnerAndDaclBatch } from "@openclaw/fs-safe/permissions";

const facts = await readOwnerAndDaclBatch(stagingDirectories, { timeoutMs: 60_000 });
```

```ts
function readOwnerAndDaclBatch(
  paths: readonly string[],
  options?: { timeoutMs?: number },
): Promise<OwnerAndDaclResult[]>;
```

Results use the same raw fact shape and SID spelling as `readOwnerAndDacl()`.
They correspond one-for-one to input order, including duplicate paths. An empty
array returns `[]` without dispatch. Other platforms return an
`unsupported-platform` result for each path. Query failures, malformed facts,
or missing/reordered response rows reject the entire batch; no partial facts
are returned. Null DACLs, incomplete ACE lists and nonlocal observations remain
raw facts for the caller's policy to evaluate.

The call captures paths, options and native mode before awaiting. Windows
relative paths are anchored to the current directory or selected drive at
entry, without normalizing their remaining `.` or `..` components. Empty,
nonstring, sparse or NUL-containing path entries and Windows namespace aliases
reject before dispatch. The UTF-8 JSON input is limited to 16 MiB.

An available native capability runs all queries in one isolated process using
the current runtime executable. Its resolved native mode is forwarded explicitly;
Node preload and module-search environment overrides are not inherited. An
available native query's failure is terminal. In `auto` when the binding or
capability is absent, or in `off`, one packaged PowerShell process reads the
path array from stdin and compiles the existing C# bridge once. Native `require`
rejects missing support before launching a process. No route launches one
process per path or wraps synchronous parent-process queries in promises.

`timeoutMs` defaults to 60,000 and applies to the whole process, including
startup and fallback compilation. It must be an integer from 1 through
2,147,483,647. Combined stdout and stderr are limited to 16 MiB. Success waits
for process exit and both output pipes to close. Timeout and transport failure
request termination, then retain the existing one-second settlement grace.
The error's `processExitConfirmed` field, also retained in its cause receipt,
distinguishes observed exit from an unconfirmed termination attempt. An
unconfirmed child can still be reading after rejection; the operation returns
no facts and owns no output files or artifact cleanup. Neither timing out nor
receiving a successful kill request is reported as confirmed exit.

The PowerShell fallback encodes and budgets each result while collecting it,
instead of retaining every descriptor graph until the entire batch finishes.
An encoded response that would exceed 16 MiB rejects with `too-large` before
inspecting later paths. A query failure observed earlier retains its original
error, and no partial facts are returned. Duplicate paths remain independent
observations. This bounds accumulated encoded results, not total process memory:
the current descriptor and row, decoded input, and runtime overhead still exist.

Batch observations are point-in-time pathname facts, not a snapshot or a
retained filesystem capability. The caller still owns ancestry trust, principal
policy and authorization for subsequent operations. Existing singular queries
and other command operations retain their 30-second deadline, 1 MiB output
budget and documented failure behavior.

## Private directories

```ts
import path from "node:path";
import { createPrivateDirectory } from "@openclaw/fs-safe/permissions";

const sqliteDirectory =
  "C:\\Users\\me\\AppData\\Local\\OpenClaw\\private-databases";
await createPrivateDirectory(sqliteDirectory);
await openSqlite(path.join(sqliteDirectory, "sessions.sqlite"));
```

On Windows, this creates the directory and applies a
protected owner + LocalSystem + Administrators full-control DACL directly with
an atomic security descriptor. The native route launches no command. When its
binding or capability is unavailable, native `auto` and `off` modes use the
packaged PowerShell/C# bridge. Both routes retain the parent and exact created-directory handles
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

This API is Windows-only; it fails closed with `FsSafeError("helper-unavailable")`
on other platforms. Native `require` also fails if the binding or capability is
missing and never starts a command. An available native operation's failure is
terminal. POSIX callers should create private
directories through their existing trusted-root creation policy rather than a
pathname-only compatibility shim. Existing Windows permission inspection still
retains its structured .NET compatibility fallback.

The raw owner/DACL and private-directory fallbacks each emit one path-free
`FS_SAFE_NATIVE_FALLBACK` warning per process. PowerShell startup and C#
compilation add overhead to each call; install the native package for frequent
operations. These routes run the package's readable, fixed scripts under normal
system PowerShell policy; see the [Windows security fallback prerequisites](install.md#windows-security-fallback).
If command support is unavailable, disallowed, or fails, the operation rejects.
Private-directory creation never falls back to inherited permissions.
The asynchronous creation command has a 30-second deadline. After a timeout or
transport failure, fs-safe requests termination and waits at most one further
second before rejecting and closing its output pipes. The error distinguishes
observed process exit from an unconfirmed termination attempt. If the OS refuses
termination, the command can still create the directory after rejection. An
already-created object retains its protected DACL, but pathname validation and
owned-handle cleanup may not finish. An error therefore does not prove the
pathname is absent; a retry can report `EEXIST`. Before retrying or using the
pathname, establish that the earlier operation stopped and verify any existing
directory's security. The library does not attempt pathname-based cleanup.

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
