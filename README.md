# 🛡️ @openclaw/fs-safe

![fs-safe banner](docs/assets/readme-banner.jpg)

[![npm](https://img.shields.io/npm/v/@openclaw/fs-safe.svg?color=10b981&label=npm)](https://www.npmjs.com/package/@openclaw/fs-safe)
[![ci](https://github.com/openclaw/fs-safe/actions/workflows/ci.yml/badge.svg)](https://github.com/openclaw/fs-safe/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/@openclaw/fs-safe.svg?color=10b981)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/@openclaw/fs-safe.svg?color=10b981)](LICENSE)
[![docs](https://img.shields.io/badge/docs-fs--safe.io-10b981)](https://fs-safe.io)

Capability-style filesystem roots for Node.js apps that handle untrusted relative paths.

Platform-specific additions include [Linux write leases, Darwin ACL inspection,
and Windows test fixtures](docs/platform-capabilities.md).

Think Go's `os.Root` / `OpenInRoot` or Rust's [`cap-std`](https://github.com/bytecodealliance/cap-std), but for Node. Hand `root()` a trusted directory and you get back a handle whose every method resolves relative paths against it and defends against `..`, symlink swaps, hardlink aliases, and TOCTOU rename races. The exact containment strength is reported per mechanism: Linux `openat2` opens are kernel-atomic; guarded Linux fallback, macOS, Windows, and JavaScript paths are best-effort.

```ts
import { root } from "@openclaw/fs-safe";

const fs = await root("/safe/workspace");
await fs.write("notes/today.txt", "hello\n");   // ok
await fs.write("../escape.txt", "x");            // throws FsSafeError("outside-workspace")
```

That's the whole pitch. `root()` is the product; the rest of the package — JSON stores, atomic writes, secret files, archive extraction, temp workspaces — is supporting cast for the same boundary.

Full docs and reference at **[fs-safe.io](https://fs-safe.io)**. For synchronous plugin captures, [guarded file copies and batches](docs/copy.md#synchronous-guarded-file-copies) return owned destination descriptors while preserving per-file checks.

## Contents

[Why this exists](#why-this-exists) · [Not a sandbox](#not-a-sandbox) · [Install](#install) · [0.6 migration](docs/migrating-to-0.6.md) · [Python migration](#migrating-from-the-python-helper) · [Quick start](#quick-start) · [Reading](#reading) · [Subpaths](#subpaths) · [Failure semantics](#failure-semantics-in-the-name) · [Directory durability](#directory-durability) · [Atomic writes](#atomic-writes) · [External outputs](#external-outputs) · [Stores](#stores) · [Secure absolute reads](#secure-absolute-file-reads) · [Walking](#directory-walking) · [Archive extraction](#archive-extraction) · [Path scopes](#advanced-path-scopes) · [Errors](#errors) · [Safety model](#safety-model) · [Limitations](#limitations)

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
| **`@openclaw/fs-safe`** | **✓** | **✓** | **✓** | **Linux openat2 atomic; others best-effort** | **✓ (ZIP/TAR/gzip/zstd/bzip2)** |

## Not a sandbox

This is a **library-level guardrail**, not OS-level isolation. It does not replace containers, seccomp, AppArmor, or filesystem permissions. It is for code that already runs with the privileges of its workspace and wants to stop trivial path tricks from escaping it. If your threat model is a hostile process, you need OS isolation; if your threat model is "an agent, plugin, upload handler, or CLI will eventually be tricked into writing somewhere it shouldn't," `fs-safe` catches that. The [security model](docs/security-model.md) describes the exact Linux, macOS, Windows, and JavaScript fallback guarantees and race boundaries.

## Install

```sh
pnpm add @openclaw/fs-safe
```

Requires Node.js 22 or newer. Bun 1.4.2 is also supported with the
[Bun runtime requirements](docs/install.md#bun-runtime), including the matching
Rust addon on macOS and Linux. See
[Installation](docs/install.md) for supported platforms and optional dependencies.

Configure native policy before first use:

```ts
import { configureFsSafeNative } from "@openclaw/fs-safe";

configureFsSafeNative({ mode: "auto" });    // default: native when available
configureFsSafeNative({ mode: "off" });     // disable the addon; use supported fallbacks
configureFsSafeNative({ mode: "require" }); // fail closed if the operation's native capability is unavailable
```

`FS_SAFE_NATIVE_MODE=auto|off|require` selects the same policy. Native-only
operations fail with `helper-unavailable` when their capability is unavailable.
Guarded JavaScript mutations are best-effort: a hostile peer can redirect a
pathname mutation before its post-check detects the escape. `require` selects
hardened native paths where documented, but does not make every operation
kernel-atomic. Read the [native helper policy](docs/native-helper.md) and
[operation/platform matrix](docs/security-model.md#native-root-mutation-capabilities)
when concurrent mutation is in scope.

## Migrating from the Python helper

Version 0.5 replaced the Python worker with prebuilt native bindings. Follow the
[0.5 migration checklist](docs/migrating-to-0.5.md) to replace the removed Python
configuration with native mode selection; current archive changes are covered
in the [0.6 migration guide](docs/migrating-to-0.6.md).

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

`root()` requires an existing trusted directory. Its defaults apply to each
operation; per-call options handle exceptions. See the [Root reference](docs/root.md).

`write()` replaces contents by default. Use `create()` or `overwrite: false`
when an existing destination should be an error. `move()` defaults to no clobber
and requires native support. On Linux, `auto` can replace a concurrently created
empty directory if no-replace rename is unsupported; use native `require` for
strict refusal. See the [move fallback contract](docs/writing.md#fs-move-from-to-options).
Pass `overwrite: true` when replacement is intended.

Staged JavaScript copies and creates also work when hardlinks are refused
(including Android/Termux), using a verified empty placeholder before atomic
replacement. See the [visibility and concurrency tradeoffs](docs/writing.md#publication-without-hardlinks).

See [Writing](docs/writing.md) for copy sources, mutation authority, symlink
policy, writable handles, and bounded removal, and [Creation](docs/creation.md)
for private permissions, atomic creation, and durability options.

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

See [Reading](docs/reading.md) for absolute-path loaders, aliases, and read
budgets, and [Writing](docs/writing.md#openwritable-for-streaming) for writable
handles. Inspection results from `stat()`, `exists()`, `list()`, and `entries()`
are advisory; use the operation methods for identity checks at the time of I/O.

## Subpaths

The main entry point collects the common root, config, output, lock, native-mode,
and error exports. Prefer focused subpaths when a consumer needs a narrower
contract. Low-level helpers that OpenClaw needs to compose higher-level APIs are grouped under
`@openclaw/fs-safe/advanced` instead of being separate public leaf contracts.

See the [complete subpath catalogue](docs/install.md#subpath-exports) for every entry point and its contents.

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

Use the [Directory durability](docs/durability.md) reference for directory
receipts, pinned synchronization, and exclusive publication policies, including
whether a completed target is preserved after a parent-directory sync failure.

## Atomic writes

`replaceFileAtomic()` writes a sibling temp and renames it over the destination.
File and parent-directory synchronization are opt-in:

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

See [Atomic writes](docs/atomic.md) for synchronous adapters, fallback recovery,
mutation authority, and publication receipts. Retained lifecycles have separate
contracts: [staged files](docs/staged-file.md), [entry publication](docs/entry-publication.md),
and [staged symlinks](docs/staged-symlink.md).

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

The callback receives a staged path. Choose workspace or sibling staging and
producer isolation using the [staging-mode guide](docs/output.md#choosing-a-staging-mode).

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

See [JSON stores](docs/json-store.md) for single-path stores and update semantics,
[File stores](docs/file-store.md) for blobs, streams, and private state, and
[File locks](docs/sidecar-lock.md) for coordination and stale-lock recovery.
The store subpath also provides [durable JSON queues](docs/store.md#durable-json-queues).
Use [temp workspaces](docs/temp.md) for scoped scratch files and cleanup policies.

## Exact file comparison

For exact comparison of already-open files, use
[`sameFileContentsSync()`](docs/file-contents.md) from `advanced`. It compares
bytes through both EOFs with bounded memory and preserves the borrowed
descriptors' positions and ownership.

## Secure absolute file reads

Use [`readSecureFile()`](docs/secure-file.md) for an absolute credential path.
It validates permissions, ownership, identity, and size through the opened handle.
See [Windows fallback prerequisites](docs/install.md#windows-security-fallback)
when native support is unavailable.

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

[`Root.entries()`](docs/entries.md) lists immediate children without following
child symlinks:

```ts
for await (const entry of fs.entries("plugins", { maxEntries: 1_000 })) {
  console.log(entry.name, entry.isSymbolicLink);
}
```

Use `Root.walk()` for root-bounded recursive traversal of caller-controlled
paths. Standalone `walkDirectory()` and `walkDirectorySync()` provide best-effort
inventories; inspect `truncated` and `failedDirs` before treating a scan as complete.
See [Directory walking](docs/walk.md) for budgets, ordering, filtering, and
cancellation contracts.

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

Use [`pathScope()`](docs/path-scope.md) for lower-level boundary validation over
a trusted absolute path.

## Errors

Boundary and policy failures use `FsSafeError` with a closed `code` union.
Parsing, callbacks, and underlying I/O can also throw other error types:

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

For `FsSafeError`, `category` distinguishes policy rejections from operational
filesystem or runtime failures. See [Errors](docs/errors.md) for codes, receipts,
and other error families; check the error type before branching on its code.

## Safety model

Root operations combine confinement, no-follow opens, and identity checks.
The [security model](docs/security-model.md) describes guarantees and race limits
for native and JavaScript mechanisms on each platform.

## Limitations

- Windows native opens are handle-relative and reject reparse points; operations without native wiring use the guarded Node implementation.
- Hardlink rejection depends on platform metadata. Treat it as defense-in-depth, not authorization.
- `fs-safe` does not validate file contents or archive payload semantics beyond filesystem safety constraints. Schemas, signatures, and authorization belong in the layer above.

## License

MIT.
