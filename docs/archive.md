# Archive extraction

`@openclaw/fs-safe/archive` extracts ZIP and TAR archives behind one API, with traversal checks, blocked-link-type rejection, and entry-count and byte budgets. When the native binding is available for the current platform, Rust streams ZIP, TAR, gzip, zstd, and bzip2 while TypeScript remains the sole policy owner; every accepted output is created fd-relative in a private staging root. Extraction then merges through the same safe-open boundary used by direct writes — a symlinked entry can't trick the merge into following an out-of-tree path.

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
  timeoutMs: 15_000,                  // hard budget; active destination mutation is joined
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
type ExtractArchiveOptions = {
  archivePath: string;          // absolute path to the archive
  destDir: string;              // absolute destination directory; must already exist
  timeoutMs: number;            // positive wall-clock budget; <= 0/non-finite disables it
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
accepted-entry plan back to Rust. Rust owns raw-stream admission, decompression,
and fd-relative `mkdirBeneath`/exclusive-open writes. This keeps filter policy identical
between native and JavaScript paths rather than reimplementing it in Rust.

ZIP extraction and bounded reads admit every physical central-directory record and its referenced local header before either decoder can normalize or collapse names. Raw names and valid Unicode Path names must pass traversal checks before stripping, filtering, or selecting a requested member; duplicate or colliding names reject with `entry-path`, even in unrelated or skipped members. Materially conflicting local/central or Unicode interpretations, malformed critical metadata, and ambiguous framing reject with `ArchiveFormatError`. Harmless separator and dot-component equivalence is allowed only after validation. Ordinary legacy filename decoding remains backend-selected.

`stripComponents` removes leading nonempty, non-`.` path components after
normalizing separators. For example, `./pkg/hello.txt` with
`stripComponents: 1` extracts to `hello.txt` on both backends. Entries with no
remaining components are skipped before the filter callback, but still count
toward `maxEntries` and undergo traversal validation. JavaScript TAR extraction
passes node-tar this accepted output path with its own stripping disabled, so
depth checks, collision checks, writes, and mode application agree.

An `entryFilter` sees the validated **canonical effective archive path before
stripping**, entry kind, and declared size. On every JavaScript and native
ZIP/TAR backend (including gzip and native zstd/bzip2), backslashes become `/`,
empty and `.` components are removed, and trailing separators are removed from
directory paths. For example, `./pkg//state\cache/value` is presented as
`pkg/state/cache/value`, even with `stripComponents: 1`. Case and Unicode
spelling are preserved. Local PAX `path`, GNU long-name, and supported ZIP
Unicode Path names use the same canonicalization.

Raw paths undergo traversal, absolute/drive-path, and NUL validation **before**
canonicalization; normalization cannot turn an unsafe path into an accepted
one. Stripping and output collision checks use this same canonical identity.
Filters that compare exact strings should use canonical pre-strip paths,
including directory names without a trailing `/`.
Returning `"skip"` rejects the whole archive unless `onFiltered` is
explicitly `"skip-entry"`. Runtime values other than `"reject-archive"` and
`"skip-entry"` reject before extraction starts instead of falling through to
skip behavior. Path traversal and archive-wide entry-count checks still apply
to skipped entries.
`maxEntryBytes` and `maxExtractedBytes` charge only entries accepted after
stripping and filtering. Skipping a large member does not consume these payload
budgets. The separate complete-stream decoded limit still applies to all TAR
content, including skipped or fully stripped members.

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

Both TAR implementations finish bounded admission before TypeScript policy
evaluation, so a rejected plan never starts extraction. The JavaScript path
owns the extraction file stream and aborts node-tar through a pipeline on
parser disagreement, validation, or timeout failure, destroying both ends
instead of leaving a paused parser to drain indefinitely.

TAR character devices, block devices, and FIFOs are presented to the filter as
`kind: "other"`. Accepted entries of these types reject with
`ArchiveSecurityError("entry-link")`; an explicit `"skip-entry"` filter can omit
them. GNU typeflag `D` (`GNUDumpDir`) is a directory on both backends, including
its filter kind, canonical path, and directory creation policy. Its declared
body size follows the existing TAR strip/filter payload budgets; dump contents
are not restored as files.

Unsupported logical TAR records, including volume headers (`V`), Solaris ACL
records (`A`), inodes (`I`), continuations (`M`), and unrecognized typeflags,
still undergo entry counting, raw/effective path validation, stripping, depth
and output collision checks in physical order. Each remaining record reaches
`entryFilter` once with its canonical pre-strip path, `kind: "other"`, and
declared effective size. A filter skip rejects with `"entry-filtered"` unless
`onFiltered: "skip-entry"` is explicit. Accepted unsupported records are safely
omitted and do not consume output payload budgets. This applies even when the
underlying TAR parser suppresses the record. GNU long names describe one such
record and are then cleared; local PAX on unsupported types and GNU sparse
`S` records retain their existing fail-closed format policy.

If `kind` is omitted, the helper calls `resolveArchiveKind(archivePath)` and throws if the extension is not recognized. Pass `kind` explicitly when the archive name doesn't carry the type (e.g. content-addressed names). Archive inputs must remain regular files from preview through descriptor admission; POSIX opens are no-follow and nonblocking, so a FIFO swap cannot stall before deadline checks resume. A positive finite `timeoutMs` is a wall-clock budget; zero, negative, `NaN`, and infinity disable the deadline. Non-mutating work rejects promptly when the budget expires. If a live destination mutation is already in flight, rejection waits only for that mutation and any rollback to finish; no later destination mutation can begin.

### Limits

```ts
type ArchiveExtractLimits = {
  maxArchiveBytes?: number;     // refuse if archivePath stat'd size exceeds this
  maxEntries?: number;          // refuse before extracting if entry count > this
  maxExtractedBytes?: number;   // cap total payload bytes accepted after strip/filter
  maxEntryBytes?: number;       // cap one accepted entry after strip/filter
  maxMetaEntryBytes?: number;   // refuse one PAX/GNU metadata body above this
  maxEntryPathComponents?: number; // bound output path depth after stripComponents
};
```

Defaults exist for each (`DEFAULT_MAX_ARCHIVE_BYTES_ZIP`, `DEFAULT_MAX_ENTRIES`, `DEFAULT_MAX_EXTRACTED_BYTES`, `DEFAULT_MAX_ENTRY_BYTES`, `DEFAULT_MAX_META_ENTRY_BYTES`, `DEFAULT_MAX_ENTRY_PATH_COMPONENTS`). An explicit zero remains zero rather than selecting the default. `maxEntries` counts every archive entry, including entries removed by `stripComponents` or an explicit filter. The path-component default is 256. It is evaluated after `stripComponents` and before TypeScript accepts an entry for either JavaScript or native extraction, so rejected entries cannot cause implicit parent-directory creation. The 1 MiB metadata default matches node-tar's `maxMetaEntrySize`; fs-safe passes the same resolved value to node-tar and the native TAR meter.

A limit violation throws `ArchiveLimitError`. Its constant and string code are:

| Constant | Code |
|---|---|
| `ARCHIVE_SIZE_EXCEEDS_LIMIT` | `archive-size-exceeds-limit` |
| `ENTRY_COUNT_EXCEEDS_LIMIT` | `archive-entry-count-exceeds-limit` |
| `EXTRACTED_SIZE_EXCEEDS_LIMIT` | `archive-extracted-size-exceeds-limit` |
| `DECODED_SIZE_EXCEEDS_LIMIT` | `archive-decoded-size-exceeds-limit` |
| `ENTRY_EXTRACTED_SIZE_EXCEEDS_LIMIT` | `archive-entry-extracted-size-exceeds-limit` |
| `META_ENTRY_SIZE_EXCEEDS_LIMIT` | `archive-meta-entry-size-exceeds-limit` |
| `ENTRY_PATH_COMPONENTS_EXCEEDS_LIMIT` | `archive-entry-path-components-exceeds-limit` |
| `MANIFEST_SIZE_EXCEEDS_LIMIT` | `archive-manifest-size-exceeds-limit` |

`MANIFEST_SIZE_EXCEEDS_LIMIT` is an active internal TAR admission limit, shared
by JavaScript and native extraction and bounded reads. Each logical member,
including ignored, filtered, and fully stripped members, charges
`64 + 2 * UTF-8 byte length of its effective pre-strip path` before emission or
retention. PAX/GNU metadata headers do not themselves charge a member cost.
The allowance is independent of `maxArchiveBytes`: derive a per-member path
allowance of `max(256, min(maxMetaEntryBytes, max(1, maxEntryPathComponents) * 256))`,
apply the same 64-byte overhead and doubled path cost, multiply by `maxEntries`,
and cap the total at 64 MiB using saturating arithmetic. Zero and very large
public limits remain deterministic. There is no public `maxManifestBytes`
option; this charged manifest budget supplements the decoded and metadata
limits rather than bounding the complete process heap.

Catch and branch on the code to surface a meaningful response to the caller.

Entry policy failures throw `ArchiveSecurityError`. Its entry-related codes
are `"entry-path"`, `"entry-link"`, and `"entry-filtered"`; destination-race
codes remain `"destination-not-directory"`, `"destination-symlink"`, and
`"destination-symlink-traversal"`.

## What it defends against

- **Path traversal:** entries with `..`, absolute paths, NUL bytes, or Windows drive-relative segments such as `C:secret` and `nested/C:secret` are rejected (`ArchiveSecurityError`). On Windows, path segments containing `:` are also rejected as alternate data stream names before either backend writes to the filesystem.
- **Symlink/hardlink entries:** rejected by default, including ZIP entries whose Unix mode says symlink while their name ends in a slash or their DOS directory bit is set. An explicit `entryFilter` with `onFiltered: "skip-entry"` can omit these entries. Some archives ship symlink/hardlink entries that point outside the destination once resolved; `extractArchive` does not follow them.
- **Ambiguous output names:** duplicate names and distinct names that collide after `stripComponents`, case normalization, or Unicode normalization are rejected instead of relying on backend- or volume-specific overwrite order.
- **TOCTOU during merge:** extraction first writes to a private temp dir, then merges into `destDir` using the same boundary checks as `root().write()`. Destination symlink swaps are checked with the selected platform mechanism; non-Linux routes retain the best-effort race window documented in the [security model](security-model.md#containment-guarantees-by-platform).
- **Zip bombs:** `maxExtractedBytes` and `maxEntryBytes` apply to *post-decompression* bytes, so highly-compressed payloads hit the cap before they exhaust disk.
- **Corrupt ZIP payloads:** streamed output must match both the central-directory CRC and declared uncompressed size before it can leave private staging.
- **Corrupt gzip streams:** truncated compressed bodies, missing trailers, and checksum failures reject before extraction publishes files or an entry read returns bytes, on both JavaScript and native backends.
- **Slow-loris archives:** `timeoutMs` is a hard wall-clock budget for non-mutating work. Extraction is aborted on overrun; if a destination mutation is already in flight, that mutation and rollback are joined before rejection so archive-controlled publication cannot continue afterward.
- **Metadata bombs:** a streaming pass-through reader rejects oversized PAX, GNU long-name, and GNU long-link bodies before either TAR implementation buffers them. It understands octal and base-256 fixed sizes and validates bounded local PAX bodies before using their size overrides for member framing. Original archive bytes remain unchanged.

### Raw TAR framing

Extraction and bounded reads admit the complete decoded TAR stream through the
raw meter before either backend's TAR parser runs. This applies to plain TAR,
gzip, and native-supported zstd/bzip2, without changing native-mode availability
or fallback policy. The existing TypeScript and Rust meters enforce the same
framing rules before parser normalization:

- Every nonzero header must have a valid unsigned octal checksum, delimited
  within its field. Checksum validation precedes metadata allocation and member
  policy. Fixed name, prefix, and linkname fields require strict UTF-8 and NUL
  padding. Raw hardlink (`1`) and symlink (`2`) headers require a nonempty
  linkname; every other type, including PAX/GNU metadata, requires an empty
  linkname. This check precedes metadata handling and member/filter policy.
- Directory (`5`), hardlink (`1`), and symlink (`2`) raw headers must declare
  zero body bytes, whether or not local PAX metadata is present. Valid zero-size
  links remain subject to the existing link/filter policy.
- EOF requires two consecutive, complete 512-byte zero blocks at a header
  boundary. A header after just one zero block, a missing/partial EOF marker,
  and any nonzero bytes after EOF reject. Additional zero padding after EOF may
  have any byte length within the decoded ceiling; zero blocks inside a declared
  member body are payload.
- Headers and padded bodies must be complete. Size fields accept unsigned
  octal with ASCII-space/NUL padding or supported positive base-256 encoding;
  malformed numbers and non-padding bytes after a NUL reject. Raw sizes and
  padded sizes must fit `Number.MAX_SAFE_INTEGER`, even with PAX overrides,
  before member budgets are considered.

Framing failures use `ArchiveFormatError("archive-header-invalid")`. PAX `x`
and GNU long-name/long-link `L`/`K` payloads retain their existing support and
metadata limits; the zero-body rule is not applied to all non-regular types.
PAX effective sizes still determine regular-member framing. Admission preserves
the input bytes, and all entry/path/byte limits and extraction deadlines remain
in force. Native inspection now completes this admission pass before parsing,
requiring one additional streaming read/decompression pass.
JavaScript admission reports an ordered logical-member manifest from the raw
meter, bounded by entry-count, manifest, and decoded limits. Policy runs once
over that manifest; extraction checks parser-visible members against the
accepted decisions before writing. Original member names and USTAR prefixes
are validated even when overridden, and non-padding bytes after a fixed path
field's NUL terminator reject rather than hiding an unsafe suffix.
Both meters enforce the 255-byte component ceiling under NFC and NFD before
metadata replaces a raw path, including Hangul decomposition expansion.
Native extraction and entry reads also drain their metered readers through
physical EOF after parser traversal, before completing directory modes,
publishing staged files, or returning the requested bytes. Finding the requested
member or reaching the parser's logical EOF cannot bypass trailing validation.

The raw meter enforces `maxEntries` before consuming each logical member's body,
including members later skipped by filtering or stripping. PAX/GNU metadata
headers do not count as members; their payloads use `maxMetaEntryBytes`.
The meter does not receive `maxEntryBytes` or `maxExtractedBytes`: those payload
budgets apply only after strip/filter acceptance, using declared effective
sizes and excluding block padding. JavaScript's entry checker and the native
accepted-plan builder retain this shared policy. Every TAR admission/parser
pass has a separate absolute decoded ceiling:
`maxExtractedBytes + maxArchiveBytes`, safely clamped to
`Number.MAX_SAFE_INTEGER` (768 MiB with defaults). It counts every admitted
decoded byte: headers, bodies, metadata, all block padding, both EOF blocks,
and zero padding after EOF. It bounds complete decoding before parser policy,
including all filtered/stripped content; cumulative metadata and zero tails
cannot bypass this bound. Exceeding this ceiling throws
`ArchiveLimitError("archive-decoded-size-exceeds-limit")`.

The same TypeScript helper derives the ceiling for JavaScript and every native
TAR pass. Before selecting a backend, it caps internal metadata/decoded limits at
`Number.MAX_SAFE_INTEGER` and logical entry counts at `2^32 - 1`. Larger finite
options such as `Number.MAX_VALUE` remain valid; high-level payload budgets keep
their large values. The decoded ceiling uses clamped `maxExtractedBytes` and
archive overhead with safe addition. Ordinary limits, including
zero and the existing defaulting/rounding rules, retain their behavior.
There is no new public option. This is an absolute decoded admission
cap, not a decompression-ratio policy; bounded stream/codec read-ahead remains.
After this complete preflight, the JavaScript backend disables node-tar's
independent ratio threshold so it cannot reject data that the native backend
accepts within the same absolute limits.

### Bounded local PAX support

Extraction and single-entry reads accept one nonempty local POSIX `x` header
(USTAR or GNU header format) immediately before one regular/contiguous file,
directory, symlink, or hardlink. `path`, `linkpath`, and `size` override that
member only. Effective paths still pass traversal validation before stripping,
then the output paths pass depth and collision checks. The filter receives the
canonical effective pre-strip path, followed by link policy checks. PAX never
permits link creation. Effective sizes drive framing, filters, and the existing output-byte
budgets; `maxEntries` still counts members, not their metadata headers.

Records must have exact byte lengths, ASCII keys, a final newline, and no
duplicate keys, embedded newlines, or unconsumed bytes. Structural `path` and
`linkpath` values and ownership names must be nonempty printable ASCII. A PAX
member's raw name, USTAR prefix, and raw link target must also be printable
ASCII; raw link targets must be present only on links, even when overridden.
Unicode
PAX structural text is deliberately unsupported because the underlying parsers
do not agree when UTF-8 is split across input chunks. `size`, `uid`, and `gid`
must be canonical unsigned decimal safe integers (zero is valid; signs, leading
zeros, fractions, and exponents are not). Padded member sizes must also fit the
safe integer range. Raw and effective directory/link sizes must both be zero;
non-directory paths ending with a separator and `linkpath` on non-links are
rejected rather than allowing parser-specific type or framing changes.

The descriptive allowlist is `mtime`, `atime`, `ctime` (signed decimal seconds
with optional fractional digits, within JavaScript's Date range), `uid`, `gid`,
`uname`, and `gname`. These attributes are accepted but not restored to the
destination. `LIBARCHIVE.xattr.*` and `SCHILY.xattr.*` with nonempty ASCII
alphanumeric/dot/underscore/hyphen suffixes are also accepted as inert metadata,
never restored as extended attributes. Their values are byte-counted and may
contain NUL or non-UTF8 bytes, including macOS provenance metadata; embedded
newlines are rejected because they can disrupt downstream record parsing.

Global `g`, old `X`, old GNU `N`, empty/dangling/repeated local headers, mixed
PAX/GNU extension chains, unknown keys, charset declarations, ACL extensions,
and all sparse extensions (including `GNU.sparse.*`, `SCHILY.filetype`,
`SCHILY.realsize`, and `SCHILY.size`) fail closed with
`ArchiveFormatError("archive-header-invalid")`. GNU sparse extension blocks are still
metered in 512-byte units before rejection, preserving metadata-limit errors
for excessive chains. The per-body `maxMetaEntryBytes` limit bounds PAX storage
and duplicate-key state; one local header per member prevents local metadata
chains without introducing a new limit or changing defaults.

### Bounded GNU long names and links

Both raw meters buffer GNU long-name `L` and long-link `K` bodies within
`maxMetaEntryBytes` before either TAR parser runs. A body must contain a nonempty
UTF-8 name, with either no NUL or exactly one terminal NUL. Embedded NULs,
additional terminal NULs, bytes after a NUL, and invalid UTF-8 reject with
`ArchiveFormatError("archive-header-invalid")`. The meters preserve original
archive bytes, including the optional terminator and block padding.

One logical member may have at most one `L` and one `K`, in either order.
Repeated metadata of either kind, mixed PAX/GNU chains in either direction,
and GNU metadata without a following member reject with the same format error.
Pending metadata is cleared only when its described member is admitted;
metadata records do not count toward `maxEntries`.

An `L` name undergoes raw-path validation before parser normalization, stripping,
or filtering; unsafe paths reject with `ArchiveSecurityError("entry-path")`.
The validated name remains pending until its described header arrives. An
effective name ending in `/` or `\` requires raw directory type `5` or `D`;
other types reject with `ArchiveFormatError` before filtering, preventing the
parsers from disagreeing about a member's type.
`K` validates encoding and NUL structure without authorizing link creation.
Normal link/filter policy still governs the described member. Canonical
pre-strip filter paths, decoded-stream ceilings, and physical EOF checks apply
to plain/gzip TAR and native zstd/bzip2 alike.

## `resolveArchiveKind`

```ts
import { resolveArchiveKind, type ArchiveKind } from "@openclaw/fs-safe/archive";

const kind = resolveArchiveKind("upload.zip"); // "zip"
const tar = resolveArchiveKind("upload.tar.gz"); // "tar"
const zstd = resolveArchiveKind("upload.tar.zst"); // "tar-zstd" when native is available
const unknown = resolveArchiveKind("upload.bin"); // null
```

Recognizes:

- `*.zip` → `"zip"`
- `*.tar`, `*.tar.gz`, `*.tgz` → `"tar"`
- `*.tar.zst`, `*.tar.zstd`, `*.tzst` → `"tar-zstd"` (native only)
- `*.tar.bz2`, `*.tbz2`, `*.tbz` → `"tar-bzip2"` (native only)

Returns `null` for unknown extensions; check the result before calling
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
and privately stages the archive input, rejects link, directory, and duplicate
entries, verifies ZIP CRC and declared size,
and throws `ArchiveLimitError` if the requested entry's output exceeds
`maxBytes`. For TAR, `maxBytes` applies only to that requested entry: a larger
unrequested member remains valid within the default archive admission limits.
TAR traversal uses default entry-count, compressed-input, and metadata limits,
plus the 768 MiB decoded ceiling derived from default extracted/archive byte
limits. It does not apply payload budgets to unrequested members. ZIP
inputs retain the archive subpath's 256 MiB compressed-input ceiling.
With a native binding it uses the same Rust decoders as extraction, including
zstd and bzip2 TAR. Without native it retains the JS ZIP/TAR/gzip implementation.

Requested paths and effective member names use extraction's canonical pre-strip
identity: backslashes become `/`, and repeated separators and `.` components
are removed after raw-path validation. For example, `./pkg//value` and
`pkg\value` both address `pkg/value`, including supported GNU/PAX and ZIP
Unicode Path names. Case and Unicode spelling are preserved. Requests ending
in `/` or `\` still reject as non-files. Canonical duplicate members reject
before an unrelated requested entry can be returned.

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

- `validateArchiveEntryPath(raw, opts)` — throws `ArchiveSecurityError` for `..`, absolute, NUL-containing, drive-relative, or otherwise unsafe entry paths, including alternate data stream names on Windows.
- `normalizeArchiveEntryPath(raw)` — converts backslashes in the entry path to forward slashes.
- `stripArchivePath(entryPath, n)` — normalize separators, drop empty and `.` components, then strip the leading N components, returning `null` if none remain.
- `resolveArchiveOutputPath({ destDir, entryPath })` — combines the entry path with the destination, after validation.
- `isWindowsDrivePath(value)` — detects drive-relative segments such as `C:secret` or `nested/C:secret` that should be rejected.

Validate attacker-controlled paths before calling normalization or stripping
helpers. After validation, `stripArchivePath(entryPath, 0)` returns the canonical
pre-strip identity used by extraction filters (or `null` for an empty path).

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
