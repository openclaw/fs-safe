# External outputs

`@openclaw/fs-safe/output` covers the case where another library insists on
writing to an absolute path you give it. Browser downloads, renderers, media
tools, and native libraries often have this shape:

```ts
import { writeExternalFileWithinRoot } from "@openclaw/fs-safe/output";

await writeExternalFileWithinRoot({
  rootDir: "/srv/workspace/downloads",
  path: "reports/today.pdf",
  write: async (filePath) => {
    await download.saveAs(filePath);
  },
});
```

The external writer receives a staged path instead of the final destination.
The default private-workspace mode finalizes through `Root.copyIn()`. An
opt-in sibling mode stages in the destination directory and atomically renames
the completed file over the target.

## Signature

```ts
function writeExternalFileWithinRoot<T = void>(
  options: ExternalFileWriteOptions<T>,
): Promise<ExternalFileWriteResult<T>>;

type ExternalFileWriteOptions<T = void> = {
  rootDir: string;
  path: string; // relative or absolute, but must stay under rootDir
  write: (filePath: string) => Promise<T>;
  maxBytes?: number;
  mode?: number;
  staging?: "workspace" | "sibling"; // default: "workspace"
  fallbackFileName?: string;          // safe staged-name fallback
};

type ExternalFileWriteResult<T = void> = {
  path: string; // final absolute path under the canonical root
  result: T;    // value returned by write()
};
```

The requested `path` must name a file. Missing destination parents are created
by the helper because the operation is "produce this output file under the
root"; callers should choose the filename before calling this API.

Use `maxBytes` when the external producer can create arbitrarily large files,
and `mode` when the finalized file needs a specific POSIX mode. Both staging
modes enforce them after the producer returns and before committing the target.
Requested basenames containing C0/C1 controls or Windows-invalid characters go
through the package's filename sanitizer; `fallbackFileName` supplies the name
when nothing remains. This removes traversal, device-name, and invalid-character
hazards but does not trim Windows-normalized trailing dots or spaces; reject or
rewrite those when cross-platform filename uniqueness matters.
The same sanitized basename is used for producer staging, guarded internal
temps, the final rename target, and the returned `path`; raw and staged names
never diverge.

## Choosing a staging mode

`staging: "workspace"` is the default. The producer writes in private temp
storage, then fs-safe copies through the guarded root boundary. Choose it when
the temp and destination filesystems may differ, or when an externally produced
partial file must never appear in the destination directory. The final target
still appears only after guarded finalization.

`staging: "sibling"` gives the producer a randomized temp path in the target
directory. Choose it only when that directory itself is the approved writable
boundary and same-filesystem atomic replacement is required. After the callback
returns, fs-safe pins and validates the staged regular file, rejects hardlinks
and size-limit violations, applies `mode`, fsyncs it, and atomically renames it
over the target. Existing files and symlink entries are replaced without
following their contents or referents. The parent identity is guarded across
the operation and the parent directory is synchronized best-effort after
rename. If an error leaves the sibling temp in place and immediate cleanup
fails, its verified identity remains registered for a best-effort process-exit
cleanup retry.

## Why not pass the final path to the library?

If a target parent can be swapped after validation, handing an external library
the final path can make the library write outside the intended root before
fs-safe has a chance to finalize or reject the operation. Workspace staging
keeps the trust-boundary write inside fs-safe's root-aware copy/atomic-write
path. Sibling staging intentionally shifts the writable boundary to the
destination directory, while keeping pathname validation, staged-file identity
checks, and the final rename under fs-safe's control.

## Browser download example

```ts
const outputPath = requestedOutputPath || sanitizeBrowserSuggestedName(suggestedFilename);

await writeExternalFileWithinRoot({
  rootDir: downloadsRoot,
  path: outputPath,
  maxBytes: 512 * 1024 * 1024,
  write: async (filePath) => {
    await download.saveAs(filePath);
  },
});
```

The chosen path may be absolute if it is already inside `downloadsRoot`, or
relative to `downloadsRoot`. Traversal, symlink parent escapes, hardlinked final
targets, over-large staged files, and missing temp files surface as
`FsSafeError`s.

This helper is not the right fit when the final filename depends on inspecting
the produced bytes. In that case, write to a private temp workspace, sniff or
validate the file, choose the final name, then copy or write into the root with
the normal root APIs.

## See also

- [Root writes](writing.md) — `write`, `copyIn`, `move`, and `mkdir`.
- [Temp workspaces](temp.md) — private scratch directories for longer workflows.
- [`pathScope()`](path-scope.md) — validation-only helper when you must pass an
  absolute path directly to another library.
