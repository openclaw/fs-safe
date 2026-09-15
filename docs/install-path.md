# Install paths

Helpers for code that creates per-name install directories under a trusted base — typical for plugins, packages, snapshots, anywhere you want `<base>/<safe-name>/`. The combination of [`resolveSafeInstallDir`](#resolvesafeinstalldir) and [`assertCanonicalPathWithinBase`](#assertcanonicalpathwithinbase) gives you "compute the install path safely, then re-verify after creation."

```ts
import {
  assertCanonicalPathWithinBase,
  resolveSafeInstallDir,
  safeDirName,
  safePathSegmentHashed,
  safePathSegmentHashedV2,
} from "@openclaw/fs-safe/advanced";
```

## `resolveSafeInstallDir`

```ts
function resolveSafeInstallDir(params: {
  baseDir: string;
  id: string;
  invalidNameMessage: string;
  nameEncoder?: (id: string) => string;   // default safeDirName
}): { ok: true; path: string } | { ok: false; error: string };
```

Computes the absolute install directory for `id` under `baseDir`, after running `id` through `nameEncoder` (`safeDirName` by default). Verifies the result stays inside `baseDir` — anything that would escape returns `{ ok: false, error: invalidNameMessage }`.

```ts
const r = resolveSafeInstallDir({
  baseDir: "/srv/plugins",
  id: "@scope/my-plugin",
  invalidNameMessage: "invalid plugin name",
});
if (!r.ok) return reply(400, r.error);

await fs.mkdir(r.path, { recursive: true });
```

For untrusted IDs that must occupy separate install directories, pass
`nameEncoder: safePathSegmentHashedV2`. The default `safeDirName` and legacy
`safePathSegmentHashed` can map distinct IDs to the same directory; the boundary
check does not establish which ID owns an existing directory.

```ts
const r = resolveSafeInstallDir({
  baseDir: "/srv/plugins-v2",
  id: untrustedId,
  invalidNameMessage: "invalid plugin name",
  nameEncoder: safePathSegmentHashedV2,
});
```

The helper does **not** create the directory — it returns the path. Pair with `fs.mkdir`, [`Root.mkdir`](root.md), or `assertCanonicalPathWithinBase` before/after creation as needed.

## `assertCanonicalPathWithinBase`

Async. Verifies that a candidate absolute path's canonical real path stays inside the base. Useful as a post-`mkdir` check, or when you have an existing path you didn't compute yourself.

```ts
function assertCanonicalPathWithinBase(params: {
  baseDir: string;
  candidatePath: string;
  boundaryLabel: string;
}): Promise<void>;
```

Throws if the candidate resolves outside `baseDir` after `realpath`. The `boundaryLabel` is included in the error message ("Invalid path: must stay within {boundaryLabel}").

```ts
await assertCanonicalPathWithinBase({
  baseDir: "/srv/plugins",
  candidatePath: "/srv/plugins/my-plugin",
  boundaryLabel: "plugin install dir",
});
```

If the candidate does not exist, the helper validates the parent directory instead — useful for "the directory I'm about to create" semantics.

## Segment sanitizers

### `safeDirName`

Returns a directory-safe segment derived from `input` by replacing `/` and `\` with `__`. Trims whitespace; returns an empty string if the input was only whitespace.

```ts
safeDirName("@scope/my-plugin");       // "@scope__my-plugin"
safeDirName("../../etc");              // "..__..__etc"
safeDirName("plugin-v1");              // "plugin-v1"
safeDirName("");                       // ""
```

`safeDirName` does *not* try to be exhaustive about Windows-reserved names or special characters. It is purely a separator-stripping pass — `resolveSafeInstallDir` adds the boundary check on top so an `"../../etc"` input cannot escape `baseDir`.

Use `safePathSegmentHashedV2` when distinct untrusted IDs need separate names.

### `safePathSegmentHashedV2`

```ts
function safePathSegmentHashedV2(input: string): string;
```

Hashes every trimmed ID, including ordinary short names, into `id-v2-` followed
by 64 lowercase hexadecimal SHA-256 digits. The result is always 70 ASCII bytes,
contains no separators, and avoids Windows device names and ignored suffixes.
There is no readable prefix to truncate and no unchanged-name branch. Distinct
trimmed IDs, including an ID that looks like an encoded output, remain distinct
unless their full SHA-256 digests collide. The lowercase ASCII output also
preserves that distinction on case-insensitive and Unicode-normalizing volumes.

The stable V2 digest recipe is SHA-256 of the UTF-8 bytes of
`"@openclaw/fs-safe:install-path:v2\0"`, followed by the UTF-16LE bytes of
`input.trim()`, without a byte-order mark. The NUL-terminated prefix separates
this use of SHA-256 from other hash domains. UTF-16LE preserves exact JavaScript
code units, including lone surrogates. Inputs are not case-folded or Unicode
normalized. Surrounding whitespace, as removed by JavaScript `String.trim()`,
is the only intentional equivalence; internal whitespace remains significant.

```ts
const segment = safePathSegmentHashedV2("plugin/v1"); // id-v2-<64 hex digits>
safePathSegmentHashedV2(" plugin/v1 ") === segment;  // true
safePathSegmentHashedV2("Plugin/v1") === segment;    // false
```

This encoder computes a name; it does not authorize access or prove ownership
of a directory. Store the original trimmed ID in application-owned metadata and
verify it before reusing an existing install directory. Keep each install tree
on one encoding version. Switching to V2 changes existing paths: use a new base
directory or explicitly migrate directories after verifying their recorded IDs.
Do not silently fall back to a legacy path when the V2 path is missing.

### `safePathSegmentHashed`

Legacy readable encoding retained for path compatibility. It appends a short
content hash when sanitization changed the input or when the safe form is too
long; ordinary short names remain unchanged. Use V2 for new untrusted-ID mappings.

```ts
safePathSegmentHashed("plugin-v1");                  // "plugin-v1"  (unchanged short input)
safePathSegmentHashed("plugin/v1");                  // "plugin-v1-d9ef8af2eb"
safePathSegmentHashed("plugin\\v1");                 // "plugin-v1-bed33f465b"
safePathSegmentHashed("Über@");                       // "ber-e392bba2b3"
safePathSegmentHashed("");                           // "skill-e3b0c44298"
safePathSegmentHashed(".");                          // "skill-cdb4ee2aea"
```

The sanitization is more aggressive than `safeDirName`: any character not in `[A-Za-z0-9._-]` becomes `-`, runs of `-` collapse, leading and trailing `-` are stripped, the empty/`.`/`..` fallback is `"skill"`. Long results are truncated to 50 chars before the hash is appended.

The suffix is the first 10 hex characters of `sha256(trimmedInput)`. This is a
40-bit identifier, and the hash is not applied to every ID: short generated
outputs overlap with accepted literal inputs. Case variants can also share a
directory on case-insensitive filesystems. Distinct IDs can therefore alias
without a hash collision. Do not use this legacy encoder as an identity or
authorization boundary for untrusted IDs. Inputs that differ only by surrounding
whitespace intentionally map to the same output. Its output and the default
encoder selected by `resolveSafeInstallDir` remain unchanged for compatibility.

## Common patterns

### Install a plugin

```ts
import { resolveSafeInstallDir, assertCanonicalPathWithinBase, safePathSegmentHashedV2 } from "@openclaw/fs-safe/advanced";
import { extractArchive } from "@openclaw/fs-safe/archive";
import fs from "node:fs/promises";

const r = resolveSafeInstallDir({
  baseDir: "/srv/plugins-v2",
  id: untrustedName,
  invalidNameMessage: "invalid plugin name",
  nameEncoder: safePathSegmentHashedV2,
});
if (!r.ok) return reply(400, r.error);

await fs.mkdir(r.path, { recursive: true, mode: 0o755 });
await assertCanonicalPathWithinBase({
  baseDir: "/srv/plugins-v2",
  candidatePath: r.path,
  boundaryLabel: "plugin install dir",
});

await extractArchive({
  archivePath: pluginZip,
  destDir: r.path,
  kind: "zip",
  timeoutMs: 30_000,
});
```

### Per-version snapshot directories

```ts
const snap = resolveSafeInstallDir({
  baseDir: "/srv/snapshots",
  id: `${runId}-${version}`,
  invalidNameMessage: "invalid snapshot id",
  nameEncoder: safePathSegmentHashedV2,
});
if (!snap.ok) throw new Error(snap.error);
await fs.mkdir(snap.path, { recursive: true });
```

### Reject and log on bad input

```ts
const r = resolveSafeInstallDir({ baseDir, id, invalidNameMessage: "bad name" });
if (!r.ok) {
  logger.warn({ id, base: baseDir, error: r.error }, "rejected install attempt");
  return reply(400, r.error);
}
```

## See also

- [`root()`](root.md) — when the install dir becomes a root for further writes.
- [Filenames](filename.md) — `sanitizeUntrustedFileName` for file-name (not directory-name) sanitization.
- [Archive extraction](archive.md) — extract into the install dir computed by these helpers.
