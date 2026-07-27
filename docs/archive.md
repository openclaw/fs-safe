# Archive extraction

`@openclaw/fs-safe/archive` extracts ZIP and TAR archives behind one API, with traversal checks, blocked-link-type rejection, and entry-count and byte budgets. When the bundled native binding is available for the current platform, Rust streams ZIP, TAR, gzip, zstd, and bzip2 while TypeScript remains the sole policy owner; every accepted output is created fd-relative in a private staging root. Extraction then merges through the same safe-open boundary used by direct writes — a symlinked entry can't trick the merge into following an out-of-tree path.

The guarded JavaScript fallback uses optional runtime dependencies: `jszip` for
ZIP and `tar` for TAR/gzip. The native path does not use those packages. Installs
that omit optional dependencies can still import this subpath and use the
native path or pure path/limit helpers.

Some package managers and CI installs skip optional dependencies
(`--no-optional`, `--omit=optional`, or equivalent). If an archive helper throws
that an optional archive dependency is not installed, install `jszip` and/or
`tar` explicitly in the consuming package.

```ts
import { extractArchive, resolveArchiveKind } from "@openclaw/fs-safe/archive";
```

## `extractArchive`

```ts
await extractArchive({
  archivePath: "/srv/uploads/plugin.zip",
  destDir: "/srv/workspace/plugins/plugin",
  kind: "zip",                        // optional; resolveArchiveKind() can infer
  timeoutMs: 15_000,                  // hard ceiling for the whole extraction
  stripComponents: 0,                 // tar-style strip-leading-dirs
  entryModes: "clamp",                // default; use "preserve" for archive rwx bits
  entryFilter: ({ path, kind, size }) => "extract",
  onFiltered: "reject-archive",        // default; opt into "skip-entry" explicitly
  limits: {
    maxArchiveBytes: 256 * 1024 * 1024,
    maxEntries: 50_000,
    maxExtractedBytes: 512 * 1024 * 1024,
    maxEntryBytes: 256 * 1024 * 1024,
    maxMetaEntryBytes: 1024 * 1024,
    maxEntryPathComponents: 256,
  },
});
```

### Parameters

```ts
type ExtractArchiveParams = {
  archivePath: string;          // absolute path to the archive
  destDir: string;              // absolute destination directory; must already exist
  timeoutMs: number;            // wall-clock cap; throws on overrun
  kind?: ArchiveKind;           // "zip" | "tar" | "tar-zstd" | "tar-bzip2"
  stripComponents?: number;     // strip N leading dirs from entry paths
  tarGzip?: boolean;            // when archive is .tar.gz/.tgz
  limits?: ArchiveExtractLimits;
  logger?: ArchiveLogger;       // { info?, warn? }
  entryModes?: "clamp" | "preserve";
  entryFilter?: (entry: { path: string; kind: ArchiveEntryKind; size: number }) =>
    "extract" | "skip";
  onFiltered?: "reject-archive" | "skip-entry";
};
```

`entryModes` defaults to `"clamp"`: directories become `0o755`; files become
`0o644`, or `0o755` when the archived owner-execute bit is set. `"preserve"`
keeps archived read/write/execute bits. Both policies strip setuid, setgid, and
sticky bits, and neither applies archived ownership. TAR extraction disables
`tar`'s ownership and mode restoration and applies the selected modes in the
private staging tree; ZIP applies the same policy to `unixPermissions`.

Native extraction is deliberately split into two phases. Rust first reports an
entry manifest without creating paths. TypeScript validates paths, applies
`stripComponents`, filters, limits, and mode policy, then passes an explicit
accepted-entry plan back to Rust. Rust only performs decompression and the
fd-relative `mkdirBeneath`/exclusive-open writes. This keeps policy identical
between native and JavaScript paths rather than reimplementing it in Rust.

An `entryFilter` sees the validated archive path, entry kind, and declared
size. Returning `"skip"` rejects the whole archive unless `onFiltered` is
explicitly `"skip-entry"`. Path traversal and archive-wide entry-count checks
still apply to skipped entries.

For example, a fleet restore can omit regenerated cache entries while rejecting
any other policy mismatch by default:

```ts
await extractArchive({
  archivePath: snapshotPath,
  destDir: restoreRoot,
  timeoutMs: 30_000,
  entryFilter: ({ path: entryPath, kind }) =>
    kind === "directory" && entryPath === "state/cache"
      ? "skip"
      : entryPath.startsWith("state/cache/")
        ? "skip"
        : "extract",
  onFiltered: "skip-entry",
  limits: { maxEntries: 50_000, maxEntryPathComponents: 64 },
});
```

If skipping was not explicitly part of the restore contract, omit
`onFiltered`; the first `"skip"` then rejects the complete archive with
`ArchiveSecurityError("entry-filtered")`.

Policy rejection is prompt on both implementations. The JavaScript TAR path
owns the file stream and aborts node-tar through a pipeline on filter, path,
link, limit, validation, or timeout failure, which destroys both ends instead
of leaving a paused parser to drain indefinitely. The native path finishes its
bounded manifest read before TypeScript policy evaluation, so a rejected plan
never starts the extraction worker.

If `kind` is omitted, the helper calls `resolveArchiveKind(archivePath)` and throws if the extension is not recognized. Pass `kind` explicitly when the archive name doesn't carry the type (e.g. content-addressed names).

### Limits

```ts
type ArchiveExtractLimits = {
  maxArchiveBytes?: number;     // refuse if archivePath stat'd size exceeds this
  maxEntries?: number;          // refuse before extracting if entry count > this
  maxExtractedBytes?: number;   // refuse mid-stream if total extracted bytes > this
  maxEntryBytes?: number;       // refuse a single entry larger than this
  maxMetaEntryBytes?: number;   // refuse one PAX/GNU metadata body above this
  maxEntryPathComponents?: number; // bound output path depth after stripComponents
};
```

Defaults exist for each (`DEFAULT_MAX_ARCHIVE_BYTES_ZIP`, `DEFAULT_MAX_ENTRIES`, `DEFAULT_MAX_EXTRACTED_BYTES`, `DEFAULT_MAX_ENTRY_BYTES`, `DEFAULT_MAX_META_ENTRY_BYTES`, `DEFAULT_MAX_ENTRY_PATH_COMPONENTS`). The path-component default is 256. It is evaluated after `stripComponents` and before TypeScript accepts an entry for either JavaScript or native extraction, so rejected entries cannot cause implicit parent-directory creation. The 1 MiB metadata default matches node-tar's `maxMetaEntrySize`; fs-safe passes the same resolved value to node-tar and the native TAR meter.

A limit violation throws `ArchiveLimitError`. The error's code is one of:

```ts
ARCHIVE_LIMIT_ERROR_CODE.ARCHIVE_SIZE_EXCEEDS_LIMIT
ARCHIVE_LIMIT_ERROR_CODE.ENTRY_COUNT_EXCEEDS_LIMIT
ARCHIVE_LIMIT_ERROR_CODE.EXTRACTED_SIZE_EXCEEDS_LIMIT
ARCHIVE_LIMIT_ERROR_CODE.ENTRY_EXTRACTED_SIZE_EXCEEDS_LIMIT
ARCHIVE_LIMIT_ERROR_CODE.META_ENTRY_SIZE_EXCEEDS_LIMIT
ARCHIVE_LIMIT_ERROR_CODE.ENTRY_PATH_COMPONENTS_EXCEEDS_LIMIT
```

Catch and branch on the code to surface a meaningful response to the caller.

Entry policy failures throw `ArchiveSecurityError`. Its entry-related codes
are `"entry-path"`, `"entry-link"`, and `"entry-filtered"`; destination-race
codes remain `"destination-not-directory"`, `"destination-symlink"`, and
`"destination-symlink-traversal"`.

## What it defends against

- **Path traversal:** entries with `..`, absolute paths, or Windows drive prefixes are rejected (`ArchiveSecurityError`).
- **Symlink/hardlink entries:** rejected by default. Some archives ship symlink/hardlink entries that point outside the destination once resolved; `extractArchive` does not follow them.
- **TOCTOU during merge:** extraction first writes to a private temp dir, then merges into `destDir` using the same boundary checks as `root().write()`. Destination symlink swaps are checked with the selected platform mechanism; non-Linux routes retain the best-effort race window documented in the [security model](security-model.md#containment-guarantees-by-platform).
- **Zip bombs:** `maxExtractedBytes` and `maxEntryBytes` apply to *post-decompression* bytes, so highly-compressed payloads hit the cap before they exhaust disk.
- **Slow-loris archives:** `timeoutMs` is a hard wall-clock budget. Extraction is aborted on overrun.
- **Metadata bombs:** a fixed-header pass-through reader rejects oversized PAX, GNU long-name, and GNU long-link bodies before either TAR implementation buffers them. It understands octal and base-256 size fields without interpreting metadata content.

PAX headers can override the next entry's size from inside their content. The
fixed-header meter deliberately never interprets that content, so PAX and GNU
sparse entries are rejected with
`ArchiveFormatError("archive-header-invalid")` rather than guessing. GNU sparse
extension blocks are still metered in 512-byte units before rejection, ensuring
malformed or excessive chains cannot bypass the metadata ceiling. GNU long-name
and long-link entries remain supported because their fixed header size fully
determines their layout.

## `resolveArchiveKind`

```ts
import { resolveArchiveKind, type ArchiveKind } from "@openclaw/fs-safe/archive";

const kind = resolveArchiveKind("upload.zip"); // "zip"
const tar = resolveArchiveKind("upload.tar.gz"); // "tar"
const zstd = resolveArchiveKind("upload.tar.zst"); // "tar-zstd" when native is available
const unknown = resolveArchiveKind("upload.bin"); // undefined
```

Recognizes:

- `*.zip` → `"zip"`
- `*.tar`, `*.tar.gz`, `*.tgz` → `"tar"`
- `*.tar.zst`, `*.tar.zstd`, `*.tzst` → `"tar-zstd"` (native only)
- `*.tar.bz2`, `*.tbz2`, `*.tbz` → `"tar-bzip2"` (native only)

Returns `undefined` for unknown extensions; check the result before calling
`extractArchive` if the filename is caller-controlled. A recognized zstd or
bzip2 TAR extension with no native binding throws the typed
`FsSafeError("helper-unavailable")` with installation guidance. This includes
`mode: "off"`; those two formats have no JavaScript fallback.

For a service whose input contract requires zstd, configure native mode before
the first archive call so a packaging mistake fails at the boundary:

```ts
import { configureFsSafeNative } from "@openclaw/fs-safe/config";
import { extractArchive } from "@openclaw/fs-safe/archive";

configureFsSafeNative({ mode: "require" });
await extractArchive({
  archivePath: "/srv/restore/snapshot.tar.zst",
  destDir: "/srv/restore/staging",
  kind: "tar-zstd",
  timeoutMs: 60_000,
});
```

## `readArchiveEntry`

`readArchiveEntry(archivePath, entryPath, { maxBytes, kind? })` reads one
regular-file entry into a bounded `Buffer` without extracting a tree. It pins
and privately stages the archive input, rejects link and directory entries,
and throws `ArchiveLimitError` if decompressed bytes exceed `maxBytes`. ZIP
inputs retain the archive subpath's 256 MiB compressed-input ceiling.
With a native binding it uses the same Rust decoders as extraction, including
zstd and bzip2 TAR. Without native it retains the JS ZIP/TAR/gzip implementation.

```ts
const rawManifest = await readArchiveEntry(uploadPath, "package/manifest.json", {
  maxBytes: 64 * 1024,
});
const manifest = JSON.parse(rawManifest.toString("utf8")) as PluginManifest;
validatePluginManifest(manifest);
```

## Lower-level building blocks

The archive subpath also exports the helpers `extractArchive` is built on. Most callers will not need them, but they are stable and documented:

| Function | Purpose |
|---|---|
| `withStagedArchiveDestination(opts)` | Creates a private staging dir outside the destination, calls your `run(stagingDir)`, then cleans it up. |
| `mergeExtractedTreeIntoDestination(opts)` | The merge step alone — staged tree → destination through boundary checks. |
| `prepareArchiveDestinationDir(destDir)` | Canonicalizes and asserts the destination directory. |
| `prepareArchiveOutputPath(opts)` | Resolves a single entry's output path against the staging dir. |
| `loadZipArchiveWithPreflight(opts)` | Loads a JSZip with size/entry-count preflight before unzipping. |
| `readZipCentralDirectoryEntryCount(path)` | Returns the entry count from a ZIP's central directory without reading any payloads. |
| `createTarEntryPreflightChecker(opts)` | Returns a per-entry checker for use as a `tar.x` `onReadEntry` hook. |

These let you build custom extractors that share the same safety machinery — for example, a streaming uploader that wants to refuse archives with too many entries before reading any payloads.

## Path helpers

`archive-entry` exports a handful of low-level helpers for entry-path normalization:

```ts
import {
  isWindowsDrivePath,
  normalizeArchiveEntryPath,
  resolveArchiveOutputPath,
  stripArchivePath,
  validateArchiveEntryPath,
} from "@openclaw/fs-safe/archive";
```

- `validateArchiveEntryPath(raw, opts)` — throws `ArchiveSecurityError` for `..`, absolute, drive-prefixed, or otherwise unsafe entry paths.
- `normalizeArchiveEntryPath(raw)` — POSIX-normalizes the entry path (forward slashes, no `.` segments).
- `stripArchivePath(entryPath, n)` — strip the leading N path components, returning `null` if not enough remain.
- `resolveArchiveOutputPath({ destDir, entryPath })` — combines the entry path with the destination, after validation.
- `isWindowsDrivePath(value)` — detects `C:\…` style entries that should be rejected.

## Common patterns

### Extract an upload, surface budget violations

```ts
import { extractArchive, ArchiveLimitError, ARCHIVE_LIMIT_ERROR_CODE } from "@openclaw/fs-safe/archive";

try {
  await extractArchive({
    archivePath: upload.path,
    destDir: targetDir,
    kind: "zip",
    timeoutMs: 30_000,
    limits: {
      maxArchiveBytes: 100 * 1024 * 1024,
      maxEntries: 10_000,
      maxExtractedBytes: 200 * 1024 * 1024,
      maxEntryBytes: 50 * 1024 * 1024,
    },
  });
} catch (err) {
  if (err instanceof ArchiveLimitError) {
    return reply(413, { code: err.code, message: err.message });
  }
  throw err;
}
```

### Decide kind from MIME, not filename

```ts
const kind: ArchiveKind = mime === "application/zip" ? "zip" : "tar";
await extractArchive({ archivePath, destDir, kind, timeoutMs: 10_000 });
```

### Stage to private dir, then commit as a directory

```ts
import { withTempWorkspace } from "@openclaw/fs-safe/temp";
import { replaceDirectoryAtomic } from "@openclaw/fs-safe/atomic";

await withTempWorkspace({ rootDir: "/srv/site/tmp", prefix: "extract-" }, async (ws) => {
  await extractArchive({
    archivePath: upload.path,
    destDir: ws.dir,
    timeoutMs: 30_000,
  });
  await replaceDirectoryAtomic({
    stagedDir: ws.dir,
    targetDir: "/srv/site/plugin",
  });
});
```

## See also

- [Atomic writes](atomic.md) — `replaceDirectoryAtomic` for staged directory replacement.
- [Temp workspaces](temp.md) — extract into a private workspace and commit as one step.
- [Errors](errors.md) — `FsSafeError` codes the underlying writes can raise.
- [Migrating to 0.5](migrating-to-0.5.md) — clamp-default and native-format upgrade checklist.
- [`extractArchive` source](https://github.com/openclaw/fs-safe/blob/main/src/archive.ts).
