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
  producerIsolation?: "private-directory"; // opt-in for sibling staging
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

`maxBytes` must be a non-negative safe integer or positive `Infinity`; zero is an active cap and `Infinity` disables it. Invalid values reject before the producer or filesystem staging runs.

Use `maxBytes` when the external producer can create arbitrarily large files,
and `mode` when the finalized file needs a specific POSIX mode. Both staging
modes enforce them after the producer returns and before committing the target.
Requested basenames containing C0/C1 controls or Windows-invalid characters go
through the package's filename sanitizer; `fallbackFileName` supplies the name
when nothing remains. This removes traversal, device-name, and invalid-character
hazards but does not trim Windows-normalized trailing dots or spaces; reject or
rewrite those when cross-platform filename uniqueness matters.
`staging: "workspace"` passes the sanitized basename to the producer.
`staging: "sibling"` embeds that basename in its randomized temporary name.
When the complete temporary component would exceed 255 bytes as written or under NFC or NFD,
only the embedded tail is shortened, preserving its extension when possible;
short callback paths remain unchanged. The final target and returned `path` use
the destination basename, sanitized
when needed as described above. Guarded temporary files used only inside
fs-safe have independent names so their length does not grow with the
destination basename.

## Choosing a staging mode

`staging: "workspace"` is the default. The producer writes in private temp
storage, then fs-safe copies through the guarded root boundary. Choose it when
the temp and destination filesystems may differ, or when an externally produced
partial file must never appear in the destination directory. The final target
still appears only after guarded finalization.

By default, `staging: "sibling"` gives the producer a randomized temp path in
the target directory. Choose it only when that directory itself is the approved writable
boundary and same-filesystem atomic replacement is required. After the callback
returns, fs-safe pins and validates the staged regular file, rejects hardlinks
and size-limit violations, applies `mode`, fsyncs it, and atomically renames it
over the target. Existing files and symlink entries are replaced without
following their contents or referents. The parent identity is guarded across
the operation and the parent directory is synchronized best-effort after
rename. If an error leaves the sibling temp in place and immediate cleanup
fails, its verified identity remains registered for a best-effort process-exit
cleanup retry.

Sibling staging shares the [callback sibling owner](temp.md#sibling-temp-writes):
it checks exact pre-open, descriptor, and current-path identities, retains the
descriptor through publication, and never chmods or reads a replacement by path.
Without producer isolation, cleanup preserves unverified paths, including partial
output when the callback throws before admission. Native-off and Windows
operation remain supported with the platform limits and non-atomic
rename/unlink identity checks described there.
When `mode` is omitted, output-sibling staging preserves the producer's mode.

Add `producerIsolation: "private-directory"` to sibling staging when the
producer can leave partial output before throwing. It receives an initially
absent file path inside a private child workspace under the target parent, on
the target filesystem. Directory cleanup ownership is captured before the
callback. A callback exception triggers owned workspace cleanup, including
partial output, subject to directory identity checks and I/O failures.
After success, an available native helper uses guarded no-replace `Root.move`.
With native mode off, the helper opens and identity-fences the completed regular
file, creates the randomized sibling through an atomic no-clobber hard link,
verifies its temporary two-link state, then removes the private name. This keeps
the handoff zero-copy while preserving the ordinary retained-descriptor, mode,
file-sync, and final-rename lifecycle. Escaping symlinks still fail with
`path-alias`; filesystems without hard-link support fail with
`helper-unavailable`.

Exact bigint parent and workspace identities are rechecked before moving
output to the sibling path to reject observed replacements. Cleanup uses the
existing [`withTempFile` ownership contract](temp.md#withtempfile). A moved or replaced parent or workspace can
leave original or replacement paths behind; the option does not promise
cleanup through a retained directory after a rename. The existing Windows and
JavaScript pathname-guard limitations remain, with no additional permissions or
durability guarantee. Native-off publication is supported only where hard links
are available. See the [producer-isolation contract](temp.md#sibling-temp-writes)
for cleanup and pathname-race details. The option affects only `staging: "sibling"`;
with `staging: "workspace"`, it is redundant and harmless because the producer
already uses a private workspace. Omitting it leaves both staging defaults
unchanged.

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
