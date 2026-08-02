# Install paths

Helpers for code that creates per-name install directories under a trusted base — typical for plugins, packages, snapshots, anywhere you want `<base>/<safe-name>/`. The combination of [`resolveSafeInstallDir`](#resolvesafeinstalldir) and [`assertCanonicalPathWithinBase`](#assertcanonicalpathwithinbase) gives you "compute the install path safely, then re-verify after creation."

```ts
import {
  assertCanonicalPathWithinBase,
  resolveSafeInstallDir,
  safeDirName,
  safePathSegmentHashed,
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

For ids whose default-sanitized form might collide (e.g. `"foo/bar"` and `"foo\\bar"` both map to `"foo__bar"`), pass `nameEncoder: safePathSegmentHashed` to append a content hash:

```ts
const r = resolveSafeInstallDir({
  baseDir: "/srv/plugins",
  id: untrustedId,
  invalidNameMessage: "invalid plugin name",
  nameEncoder: safePathSegmentHashed,
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

For stricter sanitization, use `safePathSegmentHashed`.

### `safePathSegmentHashed`

Returns a directory-safe segment **plus** a short content hash when sanitization changed the input or when the safe form is too long. Use this when input collisions matter:

```ts
safePathSegmentHashed("plugin-v1");                  // "plugin-v1"  (unchanged short input)
safePathSegmentHashed("plugin/v1");                  // "plugin-v1-d9ef8af2eb"
safePathSegmentHashed("plugin\\v1");                 // "plugin-v1-bed33f465b"
safePathSegmentHashed("Über@");                       // "ber-e392bba2b3"
safePathSegmentHashed("");                           // "skill-e3b0c44298"
safePathSegmentHashed(".");                          // "skill-cdb4ee2aea"
```

The sanitization is more aggressive than `safeDirName`: any character not in `[A-Za-z0-9._-]` becomes `-`, runs of `-` collapse, leading and trailing `-` are stripped, the empty/`.`/`..` fallback is `"skill"`. Long results are truncated to 50 chars before the hash is appended.

The suffix is the first 10 hex characters of `sha256(trimmedInput)`. It makes
collisions between distinct trimmed inputs unlikely, but it is a 40-bit
identifier rather than a mathematical uniqueness guarantee. Inputs that differ
only by surrounding whitespace intentionally map to the same output.

## Common patterns

### Install a plugin

```ts
import { resolveSafeInstallDir, assertCanonicalPathWithinBase, safePathSegmentHashed } from "@openclaw/fs-safe/advanced";
import { extractArchive } from "@openclaw/fs-safe/archive";
import fs from "node:fs/promises";

const r = resolveSafeInstallDir({
  baseDir: "/srv/plugins",
  id: untrustedName,
  invalidNameMessage: "invalid plugin name",
  nameEncoder: safePathSegmentHashed,
});
if (!r.ok) return reply(400, r.error);

await fs.mkdir(r.path, { recursive: true, mode: 0o755 });
await assertCanonicalPathWithinBase({
  baseDir: "/srv/plugins",
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
