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
| `@openclaw/fs-safe/copy` | [Directory copying and cloning](copy.md), clone-source creation, filesystem probes, and clone metadata. |
| `@openclaw/fs-safe/guest` | [Guest filesystem protocol](guest.md): Python source and exit constants for caller-owned transports. |
| `@openclaw/fs-safe/config` | Process-global native helper and lock defaults. |
| `@openclaw/fs-safe/path` | `isPathInside`, `safeRealpathSync`, `isWithinDir`, error helpers. |
| `@openclaw/fs-safe/output` | Guarded staging/finalization for libraries that require an absolute output path. |
| `@openclaw/fs-safe/json` | `tryReadJson`, `readJson`, `readJsonIfExists`, `writeJson`, sync variants. |
| `@openclaw/fs-safe/store` | `fileStore()`, `fileStoreSync()`, and `jsonStore<T>()`. |
| `@openclaw/fs-safe/secret` | Secret file read/write helpers. |
| `@openclaw/fs-safe/pipe` | Native-owned, reopenable anonymous pipes for one-shot child input. |
| `@openclaw/fs-safe/atomic` | `replaceFileAtomic`, `writeTextAtomic`, `replaceDirectoryAtomic`, `movePathWithCopyFallback`. |
| `@openclaw/fs-safe/durability` | Pinned directories, strict sync, durable directory creation, exclusive publication, and streaming SHA-256. |
| `@openclaw/fs-safe/temp` | `tempWorkspace`, `withTempWorkspace`, sync variants, `resolveSecureTempRoot`. |
| `@openclaw/fs-safe/secure-temp-root` | [Secure temp root](temp.md#secure-temp-root) resolution without workspace/store imports. |
| `@openclaw/fs-safe/secure-file` | `readSecureFile` for pinned absolute file reads with permissions checks. |
| `@openclaw/fs-safe/file-lock` | `acquireFileLock`, `withFileLock`, `createFileLockManager`, and related lock types. |
| `@openclaw/fs-safe/watch` | [Guarded filesystem observation](watch.md) with advisory native hints and polling. |
| `@openclaw/fs-safe/permissions` | POSIX mode helpers, Windows ACL inspection/remediation, raw owner/ACE facts, and private-directory creation. |
| `@openclaw/fs-safe/walk` | `walkDirectory`, `walkDirectorySync`, related types. Budget-bounded, not root-bounded. |
| `@openclaw/fs-safe/archive` | `extractArchive`, `readArchiveEntry`, kind resolution, policy types, limits, and preflight helpers. |
| `@openclaw/fs-safe/advanced` | Lower-level composition helpers: path scopes, root-file open, install paths, local-root readers, temp-file targets, sibling-temp writes, regular-file helpers, `pathExists`, `withTimeout`, and related advanced types. This surface is less stable than the focused public subpaths. |
| `@openclaw/fs-safe/errors` | `FsSafeError`, `FsSafeErrorCode`. |
| `@openclaw/fs-safe/types` | Shared types: `DirEntry`, `PathStat`, `BasePathOptions`, … |
| `@openclaw/fs-safe/test-hooks` | [Test-only hooks](testing.md#hooks-api) for injecting races; registration requires `NODE_ENV=test` or `VITEST=true`. |

## Runtime dependencies

`@openclaw/fs-safe` bundles an import-free WASM build of its Rust TAR parser and zstd/bzip2 codecs for guarded [archive extraction and bounded entry reads](archive.md). Plain TAR, gzip, zstd, and bzip2 work in `off` and missing-native `auto`, including installs with all optional dependencies omitted; gzip uses Node's built-in decoder. These archive fallbacks need no runtime interpreter, download, or consumer compiler. ZIP fallback uses lazily loaded optional `jszip` and reports a missing-dependency error without it. Public subpaths remain safe to import with all optional dependencies omitted, but imports do not prove native availability. Native `require` remains strict, and an available native operation's failure never triggers a WASM retry.

There are no peer dependencies. Exact-version optional packages carry the eight
native targets and npm-compatible OS, CPU, and Linux libc filters install only
the matching binary. Windows ARM64 Node selects
`@openclaw/fs-safe-win32-arm64-msvc`; x64 Node on the same host selects the x64
package. Consumers do not run a Rust build, download code at
runtime, or execute a postinstall step. Omitting optional dependencies keeps
fallback-capable operations working in `auto` or `off`. Native-only
features, including strict owned-tree temp cleanup, retained-directory staging,
and atomic `rename-noreplace` (including the default no-clobber `Root.move()`),
remain unavailable. Operations without a safe fallback fail with `helper-unavailable`
when the matching package is absent, incompatible, or disabled.
No-clobber `Root.move()` preserves a native loader failure in the error's
`cause`, including the original missing-library or incompatible-glibc diagnostic.

Upgrading an existing 0.5 consumer? Follow [Migrating to 0.6](migrating-to-0.6.md)
before deploying with native mode `require` or native-only features.

### Older Linux kernels and seccomp

The native addon supports kernels without `openat2` (before Linux 5.6) and
containers returning `ENOSYS` or probe-time `EPERM` for that syscall. Beneath
opens use a guarded no-follow component walk and report `best-effort`.
Nested no-clobber moves retain native parent admission and exact identity checks;
keep native mode enabled. If `renameat2(RENAME_NOREPLACE)` is also unsupported,
Linux `auto` uses [move fallbacks](writing.md#fs-move-from-to-options), including
a directory rename that can replace a concurrently created empty directory.
Native `require` refuses these fallbacks. Strict bounded cleanup still
requires `openat2` with `RESOLVE_NO_XDEV` and reports `helper-unavailable`
without it. See [Linux capability behavior and limits](native.md#linux-without-openat2).

### Windows security fallback

Windows raw owner/DACL inspection, private-directory creation, and secure-file
reads work without the addon in `auto` or `off` mode when system Windows
PowerShell and its .NET `Add-Type` compilation support are available. The package
ships a readable, fixed `.ps1` driver and adjacent `.cs` source and invokes the
driver with Windows PowerShell `-File`. Paths are passed as data. The fallback
does not generate helper scripts at runtime or use an encoded launcher.
The driver addresses built-in commands by module name and limits module
discovery to PowerShell's bundled system modules, avoiding broad command
discovery scans during each helper startup.

Normal PowerShell execution policy and Microsoft Defender policy must permit
the packaged scripts, including their use of `Add-Type`. The package does not
bypass restrictions, change policies, or add exclusions. Unsupported or
disallowed command execution fails closed.

The fallback preserves private DACLs at creation and inspects the same open
handle that supplies secure-file bytes. Each capability emits a path-free
`FS_SAFE_NATIVE_FALLBACK` warning once per process; each call adds PowerShell
startup and compilation overhead. Execution or compilation failure also fails
closed. Native `require` still rejects a missing binding or capability, and an
available native operation's error never triggers a command retry. See
[Permissions](permissions.md) and [Secure file reads](secure-file.md).

## Native helper policy

### Supported native platforms

Prebuilt bindings cover Linux x64/arm64 (GNU glibc **2.28 or newer**, or musl),
macOS x64/arm64, and Windows x64/arm64. The GNU baseline includes RHEL 8, Rocky Linux 8,
and AlmaLinux 8. A compatible Node 22+ runtime and the kernel/filesystem features
required by each operation are still necessary; a loadable addon alone does not
guarantee every native capability. Systems older than glibc 2.28 are outside the
GNU binary support floor.

A missing or incompatible optional binding (including `ERR_DLOPEN_FAILED` from
glibc) does not prevent importing fs-safe. In `auto`, supported JavaScript/WASM
fallbacks remain available. Native-only operations such as the default
no-clobber `Root.move()` still fail closed with `helper-unavailable`; `require`
also rejects fallback-capable operations and retains the binding load error as
the cause.

### Loading modes

Configure `auto` (default), `off`, or `require` before first use with
`configureFsSafeNative()` or `FS_SAFE_NATIVE_MODE`. See
[Native helper policy](native-helper.md#modes) for mode selection, loader lifetime,
and strict failure behavior. Temp workspace `cleanupSafety` is a separate policy;
see the [temp workspace contract](temp.md#private-temp-workspaces).

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
