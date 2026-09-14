# Install

`fs-safe` is published to npm as `@openclaw/fs-safe`. It targets Node 22 or newer, ships ESM only, and works on macOS, Linux, and Windows.

## Package managers

```bash
pnpm add @openclaw/fs-safe
```

```bash
npm install @openclaw/fs-safe
```

```bash
yarn add @openclaw/fs-safe
```

```bash
bun add @openclaw/fs-safe
```

## Node version

Minimum **Node 22**. The package uses `fs.promises`, `fs.constants.O_NOFOLLOW` where available, and `node:stream/promises`. Earlier Node releases will fail at import time.

Verify the runtime:

```bash
node --version
# v22.0.0 or newer
```

## Bun runtime

Bun 1.4.2 can run the same public APIs and load the matching native package.
On macOS and Linux, fs-safe uses its Rust N-API addon to call the system
`realpath` implementation for native resolution. Ordinary resolution follows
Node's component walk, including lexical normalization of expanded symlink
targets, in Rust, with a 1,024-link expansion limit that returns `ELOOP` for
excessive or cyclic expansion. This works around Bun path-resolution defects that
otherwise reject restrictive permissions and confuse literal POSIX backslashes
with directory separators. The OS still resolves symlinks and canonical file
names; fs-safe retains its confinement and file-identity checks.

This works with `bun --jitless` and needs no runtime FFI or JIT. Use native mode
`auto` or `require` with the matching addon installed. `FS_SAFE_NATIVE_MODE=off`
still disables all addon loading; `auto` without the addon falls back to Bun's
resolver. Those configurations retain Bun 1.4.2's limitations with restrictive
permissions, sockets, literal backslashes, and symlink/parent traversal. Use
Node if you need full compatibility without the addon. On Bun POSIX, `require`
also rejects canonicalization when the addon or its canonicalizer is unavailable.

Node and Windows use their existing runtime canonicalizers. On Windows, Bun's
recursive directory creation receives an absolute spelling that preserves raw
path components, working around its rejection of existing relative `.` and `..`
directories. Windows native descriptor-relative operations require Bun to expose
the paired libuv descriptor bridge from its host executable; a missing or partial
bridge fails explicitly with `ENOTSUP`. Public paths and caller-supplied filesystem
adapters remain unchanged.

The upstream fix is tracked in [Bun #42374](https://github.com/oven-sh/bun/pull/42374).
The adapter can be removed when the supported Bun baseline includes that fix.
Run native compatibility checks with `pnpm test:bun:native` after building the
package and addon. See [contributing](contributing.md) for the Node/pnpm toolchain
and the broader diagnostic suite.

## TypeScript

Types ship with the package — no `@types/openclaw__fs-safe` needed. The `exports` map in `package.json` provides typed entries for every subpath:

```ts
import { root, FsSafeError } from "@openclaw/fs-safe";
import { writeJson } from "@openclaw/fs-safe/json";
import { extractArchive } from "@openclaw/fs-safe/archive";
```

A working `tsconfig.json` for consumers:

```jsonc
{
  "compilerOptions": {
    "target": "es2022",
    "module": "node18",
    "moduleResolution": "node16",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  }
}
```

## Subpath exports

Use the main entry for the common surface, or the focused subpaths when you want a leaner import or to depend on a narrower contract:

| Subpath | Contents |
|---|---|
| `@openclaw/fs-safe` | Common root, config, output, lock, native-mode, and error exports. |
| `@openclaw/fs-safe/root` | `root()`, `Root`, `RootDefaults`, and root-walk types. |
| `@openclaw/fs-safe/config` | Process-global native helper and lock defaults. |
| `@openclaw/fs-safe/path` | `isPathInside`, `safeRealpathSync`, `isWithinDir`, error helpers. |
| `@openclaw/fs-safe/output` | Guarded staging/finalization for libraries that require an absolute output path. |
| `@openclaw/fs-safe/json` | `tryReadJson`, `readJson`, `readJsonIfExists`, `writeJson`, sync variants. |
| `@openclaw/fs-safe/store` | `fileStore()`, `fileStoreSync()`, and `jsonStore<T>()`. |
| `@openclaw/fs-safe/secret` | Secret file read/write helpers. |
| `@openclaw/fs-safe/atomic` | `replaceFileAtomic`, `writeTextAtomic`, `replaceDirectoryAtomic`, `movePathWithCopyFallback`. |
| `@openclaw/fs-safe/durability` | Pinned directories, strict sync, durable directory creation, exclusive publication, and streaming SHA-256. |
| `@openclaw/fs-safe/temp` | `tempWorkspace`, `withTempWorkspace`, sync variants, `resolveSecureTempRoot`. |
| `@openclaw/fs-safe/secure-file` | `readSecureFile` for pinned absolute file reads with permissions checks. |
| `@openclaw/fs-safe/file-lock` | `acquireFileLock`, `withFileLock`, `createFileLockManager`, and related lock types. |
| `@openclaw/fs-safe/permissions` | POSIX mode helpers, Windows ACL inspection/remediation, raw owner/ACE facts, and private-directory creation. |
| `@openclaw/fs-safe/walk` | `walkDirectory`, `walkDirectorySync`, related types. Budget-bounded, not root-bounded. |
| `@openclaw/fs-safe/archive` | `extractArchive`, `readArchiveEntry`, kind resolution, policy types, limits, and preflight helpers. |
| `@openclaw/fs-safe/advanced` | Lower-level composition helpers: path scopes, root-file open, install paths, local-root readers, temp-file targets, sibling-temp writes, regular-file helpers, `pathExists`, `withTimeout`, and related advanced types. This surface is less stable than the focused public subpaths. |
| `@openclaw/fs-safe/errors` | `FsSafeError`, `FsSafeErrorCode`. |
| `@openclaw/fs-safe/types` | Shared types: `DirEntry`, `PathStat`, `BasePathOptions`, … |
| `@openclaw/fs-safe/test-hooks` | Test-only hooks for injecting races. Active under `NODE_ENV=test`. |

## Runtime dependencies

`@openclaw/fs-safe` bundles an import-free WASM build of its Rust TAR parser for guarded JavaScript TAR/gzip [archive extraction](archive.md), including installs with optional dependencies omitted. ZIP fallback uses lazily loaded optional `jszip` and reports a missing-dependency error without it. Public subpaths remain safe to import with all optional dependencies omitted, but imports do not prove native availability.

There are no peer dependencies. Exact-version optional packages carry the seven
native targets and npm-compatible OS, CPU, and Linux libc filters install only
the matching binary. Consumers do not run a native build, download code at
runtime, or execute a postinstall step. Omitting optional dependencies keeps
non-archive fallback-capable operations working in `auto` or `off`. Native-only
features, including strict owned-tree temp cleanup, retained-directory staging,
atomic `rename-noreplace` (including the default no-clobber `Root.move()`),
zstd/bzip2 TAR handling, and Windows private-directory creation, remain
unavailable. Operations without a safe fallback fail with `helper-unavailable`
when the matching package is absent, incompatible, or disabled.

Upgrading an existing 0.5 consumer? Follow [Migrating to 0.6](migrating-to-0.6.md)
before deploying with native mode `require` or native-only features.

## Native helper policy

The platform native binaries provide fd-relative open/link/mkdir primitives,
atomic no-replace rename, and file identity checks. The default is `auto`: use
the matching binary when it loads, otherwise use the guarded JavaScript path
where a safe fallback exists. Native-only operations fail with
`helper-unavailable`.

```ts
import { configureFsSafeNative } from "@openclaw/fs-safe/config";

configureFsSafeNative({ mode: "auto" });    // default
configureFsSafeNative({ mode: "off" });     // guarded JavaScript; reject native-only operations
configureFsSafeNative({ mode: "require" }); // fail closed if unavailable
```

Environment variables are read at runtime:

```bash
FS_SAFE_NATIVE_MODE=off      # auto | off | require
```

`OPENCLAW_FS_SAFE_NATIVE_MODE` is also accepted.

Disabling native loading keeps fallback-capable operations working through Node path
operations guarded by lexical and canonical checks plus identity verification.
Use `require` when native-backed operations must fail instead of falling back.
Temp workspaces retain compatible JavaScript quarantine cleanup in `auto` and
`off`. Set `cleanupSafety: "require-bounded"` to reject before child creation
unless native no-replace quarantine and descriptor-bounded tree removal are
available. See the [temp workspace contract](temp.md#private-temp-workspaces). The exact boundary
for other operations is documented in [native helper policy](native-helper.md).

## Verify the install

```ts
import { root, FsSafeError } from "@openclaw/fs-safe";
import os from "node:os";
import path from "node:path";

const dir = path.join(os.tmpdir(), "fs-safe-smoke");
await import("node:fs/promises").then((fs) => fs.mkdir(dir, { recursive: true }));

const fs = await root(dir);
await fs.write("hello.txt", "ok\n");
console.log(await fs.readText("hello.txt"));

try {
  await fs.write("../escape.txt", "x");
} catch (err) {
  if (err instanceof FsSafeError) console.log("blocked:", err.code);
}
```

If the script prints `ok` followed by `blocked: outside-workspace`, your install is healthy.

## Next

- [Quickstart](quickstart.md) — write, read, atomic, temp.
- [Security model](security-model.md) — what the boundary defends against.
- [Errors](errors.md) — the closed code union you'll be catching.
