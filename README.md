# 🛡️ @openclaw/fs-safe

![fs-safe banner](docs/assets/readme-banner.jpg)

[![npm](https://img.shields.io/npm/v/@openclaw/fs-safe.svg?color=10b981&label=npm)](https://www.npmjs.com/package/@openclaw/fs-safe)
[![ci](https://github.com/openclaw/fs-safe/actions/workflows/ci.yml/badge.svg)](https://github.com/openclaw/fs-safe/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/@openclaw/fs-safe.svg?color=10b981)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/@openclaw/fs-safe.svg?color=10b981)](LICENSE)
[![docs](https://img.shields.io/badge/docs-fs--safe.io-10b981)](https://fs-safe.io)

Capability-style filesystem roots for Node.js apps that handle untrusted relative paths.

Think Go's `os.Root` / `OpenInRoot` or Rust's [`cap-std`](https://github.com/bytecodealliance/cap-std), but for Node. Hand `root()` a trusted directory and you get back a handle whose every method resolves relative paths against it and defends against `..`, symlink swaps, hardlink aliases, and TOCTOU rename races. The exact containment strength is reported per mechanism: Linux native opens are kernel-atomic; macOS, Windows, and JavaScript paths are best-effort.

```ts
import { root } from "@openclaw/fs-safe";

const fs = await root("/safe/workspace");
await fs.write("notes/today.txt", "hello\n");   // ok
await fs.write("../escape.txt", "x");            // throws FsSafeError("outside-workspace")
```

That's the whole pitch. `root()` is the product; the rest of the package — JSON stores, atomic writes, secret files, archive extraction, temp workspaces — is supporting cast for the same boundary.

Full docs and reference at **[fs-safe.io](https://fs-safe.io)**.

## Contents

[Why this exists](#why-this-exists) · [Not a sandbox](#not-a-sandbox) · [Install](#install) · [0.5 migration](docs/migrating-to-0.5.md) · [Python migration](#migrating-from-the-python-helper) · [Quick start](#quick-start) · [Reading](#reading) · [Subpaths](#subpaths) · [Failure semantics](#failure-semantics-in-the-name) · [Directory durability](#directory-durability) · [Atomic writes](#atomic-writes) · [External outputs](#external-outputs) · [Stores](#stores) · [Secure absolute reads](#secure-absolute-file-reads) · [Walking](#directory-walking) · [Archive extraction](#archive-extraction) · [Path scopes](#advanced-path-scopes) · [Errors](#errors) · [Safety model](#safety-model) · [Limitations](#limitations)

## Why this exists

Most Node code that has to touch caller-controlled paths reaches for:

```ts
path.resolve(root, input).startsWith(root)
```

That validates a *string*. It does not pin the file you opened, defend against a symlink retarget between check and use, reject hardlinked aliases of out-of-tree inodes, or verify that a write landed where you intended after a rename. The pieces to do those things exist scattered across the ecosystem — [`write-file-atomic`](https://www.npmjs.com/package/write-file-atomic) for atomic writes, `tar` / `jszip` for archive extraction, various `safefs`-style convenience wrappers — but none of them give you one root handle with traversal-resistant semantics across every operation.

The same idea has landed in other languages. Go [added `os.Root` and `OpenInRoot`](https://go.dev/blog/osroot); Rust has had [`cap-std`](https://github.com/bytecodealliance/cap-std) for years. Node's `fs` is path-string-oriented and exposes flags like `O_NOFOLLOW` but not an ergonomic "operate inside this root" API. `fs-safe` fills that gap.

| | Root boundary | Atomic writes | Symlink/hardlink defense | TOCTOU resistance | Archive extraction |
|---|---|---|---|---|---|
| `path.resolve().startsWith()` | string check only | – | – | – | – |
| [`write-file-atomic`](https://www.npmjs.com/package/write-file-atomic) | – | ✓ | – | – | – |
| Go [`os.Root`](https://go.dev/blog/osroot) / Rust [`cap-std`](https://github.com/bytecodealliance/cap-std) | ✓ | platform | ✓ | ✓ | – |
| **`@openclaw/fs-safe`** | **✓** | **✓** | **✓** | **Linux atomic; others best-effort** | **✓ (ZIP/TAR; native zstd/bzip2)** |

## Not a sandbox

This is a **library-level guardrail**, not OS-level isolation. It does not replace containers, seccomp, AppArmor, or filesystem permissions. It is for code that already runs with the privileges of its workspace and wants to stop trivial path tricks from escaping it. If your threat model is a hostile process, you need OS isolation; if your threat model is "an agent, plugin, upload handler, or CLI will eventually be tricked into writing somewhere it shouldn't," `fs-safe` catches that. The [security model](docs/security-model.md) describes the exact Linux, macOS, Windows, and JavaScript fallback guarantees and race boundaries.

## Install

```sh
pnpm add @openclaw/fs-safe
```

Node 22 or newer. Core root/path/json/temp helpers avoid framework dependencies. Archive helpers use optional `jszip` and `tar` dependencies for ZIP/TAR support; installs that omit optional dependencies can still use every non-archive subpath.

The package bundles prebuilt native bindings for seven supported targets. They
supply fd-relative and atomic no-replace primitives that Node does not expose
directly. Configure the lazy loader before first use when you need a strict
environment policy:

```ts
import { configureFsSafeNative } from "@openclaw/fs-safe";

configureFsSafeNative({ mode: "auto" });    // default: native when available
configureFsSafeNative({ mode: "off" });     // guarded JavaScript only
configureFsSafeNative({ mode: "require" }); // fail closed if the binding is unavailable
```

Equivalent env var: `FS_SAFE_NATIVE_MODE=auto|off|require`. All seven binaries
ship inside `@openclaw/fs-safe`; there are no platform packages, postinstall
steps, downloads, or consumer Rust builds. This makes the tarball larger than
a per-platform package, but makes installation deterministic. On a platform
without a bundled binary, `auto` silently retains lexical and canonical root
checks, no-follow opens, guarded temp+rename writes, and post-write identity
verification. See the [native
helper policy](docs/native-helper.md) for the exact boundary and deployment
tradeoff, and [native architecture](docs/native.md) for the platform mechanisms
and policy ownership model.

Open results report the mechanism's containment class as `"kernel-atomic"` or
`"best-effort"`. Linux native `openBeneath()` is kernel-atomic; macOS, Windows,
and guarded JavaScript results are best-effort. See the [security model](docs/security-model.md#containment-guarantees-by-platform) before using that fact in higher-level policy.

## Migrating from the Python helper

Version 0.5 replaces the persistent Python worker with bundled prebuilt native
bindings. The modes map directly: `configureFsSafePython({ mode: "auto" })`
becomes `configureFsSafeNative({ mode: "auto" })`, and likewise for `off` and
`require`. Replace `FS_SAFE_PYTHON_MODE` with `FS_SAFE_NATIVE_MODE`; remove
`pythonPath`, `FS_SAFE_PYTHON`, and interpreter provisioning because the native
loader does not spawn Python.

Version 0.5 retains the old function and documented `FS_SAFE_PYTHON*`
and OpenClaw Python environment names emit one `FS_SAFE_PYTHON_DEPRECATED`
warning and map the old mode to its native equivalent. They are migration
bridges for shipped 0.4 consumers, not an alternate helper contract. Update
startup configuration as part of the 0.5 upgrade rather than relying on the
warning path. Follow the [0.5 migration checklist](docs/migrating-to-0.5.md).

## Quick start

```ts
import { root } from "@openclaw/fs-safe";

const fs = await root("/safe/workspace", {
  hardlinks: "reject",
  symlinks: "reject",
  mkdir: true,
  mode: 0o600,
});

await fs.write("notes/today.txt", "hello\n");
const text = await fs.readText("notes/today.txt");
const config = await fs.readJson("config.json");
await fs.copyIn("uploads/upload.png", "/tmp/upload.png");
await fs.move("notes/today.txt", "notes/archive/today.txt", { overwrite: true });
await fs.remove("notes/archive/today.txt");
```

`root()` takes the trusted directory; relative paths in subsequent calls are resolved against it. Defaults you pass to `root()` apply to every call below; per-call options override them.

When you need metadata or a `FileHandle`:

```ts
const { buffer, realPath, stat } = await fs.read("notes/today.txt");
const opened = await fs.open("notes/today.txt");
```

`create()` is the don't-clobber variant of `write()` and throws `already-exists` when the target already exists:

```ts
await fs.create("notes/README.md", "seed\n"); // throws if it already exists
```

`write()` replaces file contents by default; pass `{ overwrite: false }` or use `create()` when an existing file should be an error. `move()` defaults to no clobber because it can otherwise delete an unrelated target while also consuming the source. Pass `{ overwrite: true }` when replacing the target is intended.

Use `ensureRoot()` when a computed relative directory target resolves to the root itself (`""` or `"."`) and you want the operation to be accepted. `root()` still requires the trusted root directory to already exist.

## Reading

Pick the narrowest read shape that gives you what you need:

```ts
await fs.readJson("config.json"); // parsed value; validate it at your boundary
await fs.readText("notes/today.txt");
await fs.readBytes("image.png");
await fs.read("notes/today.txt"); // { buffer, realPath, stat }
const opened = await fs.open("large.log"); // FileHandle for streaming
```

For streams, use `open()` and the returned `FileHandle`:

```ts
await using opened = await fs.open("large.log");
{
  const stream = opened.handle.createReadStream();
  // consume stream
}
```

Root reads default to `DEFAULT_ROOT_MAX_BYTES` (16 MiB). Pass a larger `maxBytes`
for expected large reads, or `Number.POSITIVE_INFINITY` when the caller has a
separate size budget.

`reader()` returns a callback that reads absolute or relative paths through the same root boundary. It is useful for APIs that accept a `(path) => Promise<Buffer>` loader. Absolute paths outside the root are rejected with `outside-workspace`. `readAbsolute()` has the same absolute-path behavior directly.

When you need a writable `FileHandle`, use `openWritable()` and prefer `await using` for cleanup:

```ts
await using opened = await fs.openWritable("logs/current.log", { writeMode: "append" });
{
  await opened.handle.appendFile("line\n");
}
```

`nonBlockingRead` is the only I/O scheduling knob in `RootDefaults`; it applies to read/open operations because it changes how file descriptors are opened. Filesystem safety policy remains explicit through `hardlinks`, `symlinks`, and `denyMutations`.

```ts
const locked = await root("/srv/workspace", {
  denyMutations: {
    paths: ["/srv/workspace/.env"],
    prefixes: ["/srv/workspace/.ssh"],
  },
});

await locked.write(".env", "token"); // FsSafeError code "denied-path"
```

`stat()`, `exists()`, and `list()` are boundary-checked, but they cannot pin a later operation to the same filesystem object. Use `read()`, `open()`, `write()`, `create()`, `copyIn()`, `move()`, or `remove()` for operation-local identity checks, and inspect `containment` when the platform distinction matters.

## Subpaths

The main entry point collects the common root, config, output, lock, native-mode,
and error exports. Prefer focused subpaths when a consumer needs a narrower
contract. Low-level helpers that OpenClaw needs to compose higher-level APIs are grouped under
`@openclaw/fs-safe/advanced` instead of being separate public leaf contracts.

| Subpath | Contents |
|---|---|
| `@openclaw/fs-safe/root` | `root()`, `Root`, `RootDefaults`, and root-bounded walking with pruning/error markers |
| `@openclaw/fs-safe/config` | process-global native helper and lock defaults |
| `@openclaw/fs-safe/path` | canonical path checks: `isPathInside`, `safeRealpathSync`, `isNotFoundPathError`, `isSymlinkOpenError` |
| `@openclaw/fs-safe/json` | `tryReadJson`, `readJson`, `readJsonIfExists`, `writeJson`, sync variants |
| `@openclaw/fs-safe/output` | `writeExternalFileWithinRoot` for external libraries that need a temp output path |
| `@openclaw/fs-safe/store` | `fileStore`, `fileStoreSync`, and `jsonStore` |
| `@openclaw/fs-safe/secret` | sync/async strict and try-style secret reads, atomic replace, and create-only secret writes |
| `@openclaw/fs-safe/atomic` | `replaceFileAtomic`, `replaceFileAtomicSync`, `replaceDirectoryAtomic`, `movePathWithCopyFallback` |
| `@openclaw/fs-safe/durability` | pinned directory identities, strict directory sync, durable nested-directory creation, exclusive publication, streaming SHA-256, provenance receipts, and sync-failure policy |
| `@openclaw/fs-safe/temp` | `tempWorkspace`, `tempWorkspaceSync`, `withTempWorkspace`, `resolveSecureTempRoot` |
| `@openclaw/fs-safe/secure-file` | fd-pinned absolute file reads with owner, mode, ACL, trusted-dir, size, and timeout checks |
| `@openclaw/fs-safe/file-lock` | async/sync sidecar locks, root-bounded sidecars, ownership verification, and stale policy |
| `@openclaw/fs-safe/permissions` | POSIX mode and Windows ACL inspection, raw owner/ACE facts, private-directory creation, and remediation helpers |
| `@openclaw/fs-safe/walk` | budget-bounded directory walking with symlink policy, filters, and truncation accounting; not root-bounded |
| `@openclaw/fs-safe/archive` | policy-driven ZIP/TAR extraction, clamp/filter policy, metadata/path-depth limits, native gzip/zstd/bzip2, and bounded entry reads |
| `@openclaw/fs-safe/advanced` | lower-level composition helpers such as path scopes, root-file open, bounded descriptor reads, install paths, filename sanitizing, temp-file targets, sibling-temp writes, local-root readers, regular-file helpers, `pathExists`, and `withTimeout`; less stable than focused public subpaths |
| `@openclaw/fs-safe/errors` | `FsSafeError`, closed codes/categories, causes, and operation-specific details receipts |
| `@openclaw/fs-safe/types` | shared types: `DirEntry`, `PathStat`, … |
| `@openclaw/fs-safe/test-hooks` | hooks the test suite uses to inject races; registration requires `NODE_ENV=test` or `VITEST=true` |

## Failure semantics in the name

When two helpers behave differently on the same input, the difference is in the name, not the docs.

```ts
import { readJson, tryReadJson } from "@openclaw/fs-safe/json";

await tryReadJson("./config.json"); // returns null on missing or invalid
await readJson("./manifest.json");  // throws on missing or invalid
```

For one-off structured reads under a trusted root, `readRootJsonObjectSync()`
performs the root-bounded open and JSON object validation in one step. Use
`readRootStructuredFileSync()` when the parser lives outside fs-safe, such as
JSON5-backed plugin manifests.

## Directory durability

```ts
import { ensureDurableDirectory, pinDirectory } from "@openclaw/fs-safe/durability";

const receipt = await ensureDurableDirectory({
  directoryPath: "/srv/backups/sqlite",
  mode: 0o700,
});
const pinned = await pinDirectory(receipt);
try {
  await publishSnapshot();
  const outcome = await pinned.sync();
  // `unsupported` is explicit on platforms without directory flushing.
  console.log(outcome.status);
} finally {
  await pinned.close();
}
```

The durability subpath pins a directory descriptor to its pathname identity,
detects symlink/FIFO/replacement races, and synchronizes every new parent edge
when creating a nested directory. Strict sync propagates real I/O failures and
reports known Windows directory-flush limitations explicitly. Separate
best-effort helpers preserve operations that do not promise crash durability.

`publishFileExclusive()` adds no-clobber hardlink/copy/rename strategies and a
typed post-creation receipt. Its `onSyncFailure` policy defaults to
`"rollback"`; backup writers can choose `"preserve"` to keep a complete target
when parent-directory sync fails, then inspect `details.directorySync` and
retry or record the weaker durability state.

See [Directory durability](docs/durability.md) for the receipt, pin lifecycle,
publication policy, creation callback, and platform contract.

## Atomic writes

`replaceFileAtomic()` writes a sibling temp file, applies its exact mode through the still-open descriptor, optionally fsyncs it, and renames it over the destination. It never follows the published destination path to set file permissions. Mode preservation, pinned-destination hardlink rejection, rename retry / copy fallback on `EPERM`, bounded original-content restoration after a torn fallback, parent-directory fsync, and a `beforeRename` hook for backup or observer flows are all opt-in. `movePathWithCopyFallback()` stages cross-device moves before commit and removes only the copied source entries, so concurrent source additions or replacements are preserved.

```ts
import { replaceFileAtomic } from "@openclaw/fs-safe/atomic";

await replaceFileAtomic({
  filePath: "/safe/workspace/state.json",
  content: JSON.stringify(state, null, 2),
  mode: 0o600,
  syncTempFile: true,
  syncParentDir: true,
});
```

`replaceFileAtomicSync()` covers the synchronous case with the same options shape. Both accept an injectable `fileSystem` for tests. Async adapters use `chmod()` on the `FileHandle` returned by their required `open()` operation; custom sync adapters using `mode` or `preserveExistingMode` provide the optional descriptor-bound `fchmodSync` operation.

## External outputs

Use `writeExternalFileWithinRoot()` when a browser download, renderer, media
tool, or native library needs an absolute path to write to:

```ts
import { writeExternalFileWithinRoot } from "@openclaw/fs-safe/output";

await writeExternalFileWithinRoot({
  rootDir: "/safe/workspace/downloads",
  path: "reports/today.pdf",
  staging: "sibling",
  write: async (filePath) => {
    await download.saveAs(filePath);
  },
});
```

The callback receives a staged path, not the final destination. The default
`"workspace"` mode uses private temp storage plus `Root.copyIn()` for
cross-device-tolerant finalization. `"sibling"` stages in the target directory,
fsyncs the completed file, and atomically renames it over the target. Choose it
when the destination directory is itself the writable boundary and atomic
replacement matters.

Use it when the final filename is known before the external writer runs. If the
filename depends on sniffing the produced bytes, write to a private temp
workspace first, then finalize through the normal root APIs after validation.

## Stores

Use `fileStore().json()` for small state files that need explicit fallback
reads, atomic writes, and optional sidecar locking around read-modify-write
updates:

```ts
import { fileStore } from "@openclaw/fs-safe/store";

const files = fileStore({ rootDir: "/safe/workspace/state", private: true });
const store = files.json("settings.json", { lock: true });

await store.updateOr({ enabled: false }, (current) => ({ ...current, enabled: true }));
```

`jsonStore({ filePath })` is the absolute-path convenience wrapper for the same
primitive.

Use `update()` when missing state is part of your model; use `updateOr()` for
the common merge-into-defaults case. Standalone helpers use options bags
because they do not carry a bound root and often need multiple authority, path,
and policy knobs.

Sidecar locks fail closed on stale holders by default. Opt-in `remove-if-unchanged`
recovery requires caller approval and serializes snapshot verification and unlink
with an exclusive reclaim guard so a replacement lock cannot be deleted; see the
[file lock docs](docs/sidecar-lock.md).

Use `fileStore()` for cache/blob/media-style directories where callers
need safe relative paths, size limits, atomic replacement, stream writes, and
TTL cleanup behind one root. Pass `private: true` for credentials, auth
profiles, tokens, and per-agent private state; private mode keeps the same
store shape while routing writes through the secret-file atomic path.

```ts
import { fileStore } from "@openclaw/fs-safe/store";

const media = fileStore({
  rootDir: "/safe/workspace/media",
  maxBytes: 5 * 1024 * 1024,
  mode: 0o600,
});

await media.write("inbound/photo.jpg", bytes);
await media.writeJson("state/photo.json", { id: "photo" });
const cached = await media.readJsonIfExists("state/photo.json");
const opened = await media.open("inbound/photo.jpg");
await media.pruneExpired({ ttlMs: 10 * 60 * 1000, recursive: true });
```

The `store` subpath also includes durable JSON queue helpers for the common
"one JSON file per work item" pattern: atomic entry writes, pending-entry loads,
acknowledgement via `.delivered` markers, failed-entry moves, and stale temp
cleanup. Retry, dedupe, and transport semantics stay with the caller.

`tempWorkspace()` exposes `write()`, `writeText()`, `writeJson()`, `copyIn()`, and `read()` for
single-file scratch workflows without hand-rolled path joins, plus a `store: FileStore` view of
the workspace dir for the richer cases (`writeStream`, `readJsonIfExists`, `store.json<T>(rel)`).

`tempFile()` is the smaller one-file temp helper. It is intentionally an
advanced primitive: use `tempWorkspace()` for the stable temp surface and reach
for `tempFile()` only when you need a raw file target.

```ts
import { tempFile } from "@openclaw/fs-safe/advanced";

await using target = await tempFile({ prefix: "download", fileName: "payload.bin" });
await fs.promises.writeFile(target.path, bytes);
const checksumPath = target.file("payload.sha256");
```

## Secure absolute file reads

Use `readSecureFile()` when the caller gives you an absolute credential path
instead of a root-relative workspace path. It opens the file first, validates the
same handle it will read from, checks trusted directories, owner, POSIX mode or
Windows ACLs, hardlink count, size, and optional timeout, then reads through the
pinned handle.

```ts
import { readSecureFile } from "@openclaw/fs-safe/secure-file";

const { buffer } = await readSecureFile({
  filePath: "/var/lib/app/token",
  label: "auth token",
  trust: { trustedDirs: ["/var/lib/app"] },
  io: { maxBytes: 16 * 1024, timeoutMs: 5_000 },
});
```

Use `permissions: { allowInsecure: true }` only for migration or explicit local-development
flows where a warning is preferable to refusing the file.

## Directory walking

`walkDirectory()` and `walkDirectorySync()` replace ad-hoc recursive
`readdir()` loops with entry and depth budgets, a symlink policy, and stable
relative paths.

```ts
import { walkDirectory } from "@openclaw/fs-safe/walk";

const scan = await walkDirectory("/safe/workspace", {
  maxDepth: 4,
  maxEntries: 10_000,
  symlinks: "skip",
  include: (entry) => entry.kind === "file",
});

for (const file of scan.entries) {
  console.log(file.relativePath);
}
```

Check `scan.truncated` before treating the result as complete, and `scan.failedDirs` to tell an incomplete scan (a directory that could not be read) from an empty one before pruning state from the listing.

For caller-controlled paths, `Root.walk()` is the root-bounded async iterator.
It supports entry/depth budgets, in-root symlink following, cancellation, and a
truncation marker (or typed error) when a budget is reached. Its `entryFilter`
can return `"skip-subtree"` to prune a directory, and
`onDirectoryError: "skip-and-report"` yields typed `"directory-error"` markers
while preserving entries from readable subtrees.

## Archive extraction

`extractArchive()` handles ZIP and TAR behind one API, with traversal checks, blocked-link-type rejection, and entry-count and byte budgets.

```ts
import { extractArchive, resolveArchiveKind } from "@openclaw/fs-safe/archive";

const kind = resolveArchiveKind(uploadPath);
if (!kind) throw new Error(`unsupported archive: ${uploadPath}`);

await extractArchive({
  archivePath: uploadPath,
  destDir: "/safe/workspace/plugin",
  kind,
  timeoutMs: 15_000,
  limits: {
    maxArchiveBytes: 256 * 1024 * 1024,
    maxEntries: 50_000,
    maxExtractedBytes: 512 * 1024 * 1024,
    maxEntryBytes: 256 * 1024 * 1024,
    maxEntryPathComponents: 64,
  },
});
```

Extraction stages into a private directory and merges through the same safe-open boundary used by direct writes, so a symlinked entry can't trick the merge into following an out-of-tree path.

## Advanced path scopes

For code that already has a trusted absolute path and wants lower-level boundary
validation without going through `root()`:

```ts
import { pathScope } from "@openclaw/fs-safe/advanced";

const uploads = pathScope("/safe/uploads", { label: "uploads directory" });
const files = await uploads.files(["photo.jpg"]);
const target = await uploads.writable("report.pdf");
```

## Errors

Every failure surfaces as an `FsSafeError` with a closed `code` union you can branch on:

```ts
import { FsSafeError } from "@openclaw/fs-safe/errors";

try {
  await fs.write("../escape.txt", "x");
} catch (err) {
  if (err instanceof FsSafeError && err.code === "outside-workspace") {
    // handle
  }
  throw err;
}
```

Codes are grouped by category:

```ts
if (err instanceof FsSafeError) {
  if (err.category === "policy") {
    // Unsafe caller input or filesystem state rejected by a safety policy.
  } else {
    // Routine filesystem outcome or runtime/environment problem.
  }
}
```

Routine filesystem outcomes such as `not-found`, `not-empty`, and
`not-removable` are operational; they do not indicate that a filesystem
boundary policy was violated.

Current `FsSafeErrorCode` values are `already-exists`, `denied-path`, `device-path`, `hardlink`, `helper-failed`, `helper-unavailable`, `invalid-path`, `insecure-permissions`, `not-empty`, `not-file`, `not-found`, `not-owned`, `not-removable`, `outside-workspace`, `path-alias`, `path-mismatch`, `permission-unverified`, `secret-exists`, `symlink`, `timeout`, `too-large`, and `unsupported-platform`.

## Safety model

- root-bounded APIs resolve paths against a configured root and reject canonical escapes
- reads reject known unsafe device paths, open with `O_NOFOLLOW` where available, then verify fd identity matches the path identity before returning the buffer or handle
- create-only writes, sidecar acquisition, and exclusive publication prefer fd-relative native primitives, with verified guarded JavaScript fallbacks
- `remove`, `mkdir`, `move`, `stat`, and `list` retain guarded JavaScript implementations with pre/post identity checks
- archive extraction stages into a private directory and merges through the same boundary checks used by direct writes

## Limitations

- Windows native opens are handle-relative and reject reparse points; operations without native wiring use the guarded Node implementation.
- Hardlink rejection depends on platform metadata. Treat it as defense-in-depth, not authorization.
- `fs-safe` does not validate file contents or archive payload semantics beyond filesystem safety constraints. Schemas, signatures, and authorization belong in the layer above.

## License

MIT.
