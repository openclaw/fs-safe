# Positional reads

Use `readFileWindowFully()` and `readFileWindowFullySync()` to read a bounded
window from an already-open file. They fill a caller-owned `Buffer`, completing
short reads until the buffer is full or the file reaches EOF, and return the
number of bytes read. They never allocate a payload buffer, close the descriptor,
or change its current offset.

```ts
import { root } from "@openclaw/fs-safe";
import { readFileWindowFully } from "@openclaw/fs-safe/advanced";

const workspace = await root("/srv/workspace");
await using opened = await workspace.open("large.log");
const buffer = Buffer.allocUnsafe(4096);
const bytesRead = await readFileWindowFully(opened.handle, buffer, 8192);
const window = buffer.subarray(0, bytesRead);
```

## Signatures

```ts
type ReadFileWindowOptions = { signal?: AbortSignal };

function readFileWindowFully(
  handle: import("node:fs/promises").FileHandle,
  buffer: Buffer,
  position: number,
  options?: ReadFileWindowOptions,
): Promise<number>;

function readFileWindowFullySync(
  fd: number,
  buffer: Buffer,
  position: number,
): number;
```

`position` and the exclusive window end (`position + buffer.length`) must be
non-negative safe integers. Invalid ranges throw `RangeError` before reading.
A zero-length buffer returns zero without I/O. Reading at or beyond EOF also
returns zero. If EOF occurs within the window, only the returned prefix is
written; the remaining buffer bytes stay unchanged. Always slice by the returned
count before using an unsafe-allocated buffer.

These helpers use the caller's open descriptor directly. They do not establish
path containment, file identity, file-type admission, or a snapshot of concurrently
modified contents. Use [`Root.open()`](root.md#reads) to admit untrusted paths,
and keep the handle open and the buffer available until the operation settles.
Underlying I/O errors propagate unchanged.

## Cancellation

The async variant accepts `signal`. A pre-aborted signal rejects before I/O.
In-flight cancellation is checked after the pending read settles and before
another read starts, preserving the signal's reason. Bytes already read remain
in the buffer; cancellation does not roll them back. Once the promise settles,
the caller can reuse the buffer or close its handle without a hidden read still
running.

For a whole-file read that rejects files exceeding a byte limit, use the
[bounded descriptor readers](advanced.md#files-and-identity) instead. Positional
reads stop successfully at the requested window and do not probe for extra data.
