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

`@openclaw/fs-safe` lists `jszip` and `tar` as optional dependencies for [archive extraction](archive.md). They are loaded lazily and only required when ZIP/TAR helpers run. Installs that omit optional dependencies can still import and use every non-archive subpath; archive calls fail with a clear missing-optional-dependency message.

There are no peer dependencies. The single npm package bundles all seven native binaries, so consumers do not run a native build, download platform code, or execute a postinstall step. Shipping every target increases the tarball size compared with per-platform packages, intentionally trading bandwidth for deterministic installation.

Upgrading an existing consumer? Follow [Migrating to 0.5](migrating-to-0.5.md)
before choosing a native mode or accepting the new archive clamp default.

## Native helper policy

The bundled native binaries provide fd-relative open/link/mkdir primitives,
atomic no-replace rename, and file identity checks. The default is `auto`: use
the matching binary when it loads, otherwise silently keep the guarded
JavaScript path. Platforms without one of the seven bundled targets therefore
continue through the documented fallback in `auto` mode.

```ts
import { configureFsSafeNative } from "@openclaw/fs-safe/config";

configureFsSafeNative({ mode: "auto" });    // default
configureFsSafeNative({ mode: "off" });     // guarded JavaScript only
configureFsSafeNative({ mode: "require" }); // fail closed if unavailable
```

Environment variables are read at runtime:

```bash
FS_SAFE_NATIVE_MODE=off      # auto | off | require
```

`OPENCLAW_FS_SAFE_NATIVE_MODE` is also accepted.

Disabling native loading keeps the public API working through Node path
operations guarded by lexical and canonical checks plus identity verification.
Use `require` when native-backed operations must fail instead of falling back.
The exact boundary is documented in [native helper policy](native-helper.md).

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
