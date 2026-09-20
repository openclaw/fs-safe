# Exact file comparison

`sameFileContentsSync()` compares the bytes of two already-open regular files,
starting at offset zero. It uses bounded buffers and completes positive short
reads independently on each descriptor. A `true` result requires matching bytes
and observed EOF on both inputs; a difference can return `false` immediately.

```ts
import fs from "node:fs";
import { sameFileContentsSync } from "@openclaw/fs-safe/advanced";

const source = fs.openSync("/trusted/source.sqlite", "r");
try {
  const copy = fs.openSync("/trusted/copy.sqlite", "r");
  try {
    console.log(sameFileContentsSync(source, copy, { maxBytes: 256 * 1024 * 1024 }));
  } finally {
    fs.closeSync(copy);
  }
} finally {
  fs.closeSync(source);
}
```

## Signature

```ts
type SameFileContentsOptions = { maxBytes?: number };

function sameFileContentsSync(
  leftFd: number,
  rightFd: number,
  options?: SameFileContentsOptions,
): boolean;
```

Both descriptors must be open regular files. Nonregular inputs throw
`FsSafeError("not-file")`; underlying filesystem errors propagate unchanged.
Passing the same descriptor twice is allowed, but does not bypass validation,
the byte limit, or reads. File sizes are checked against the limit, but are not
used as proof that contents match or that EOF has been reached.

## Bounds and ownership

`maxBytes` is a limit for each file, not their combined size. It accepts a
non-negative safe integer or `Infinity`; omission imposes no caller-selected
limit. Invalid limits throw `RangeError` before filesystem work. Comparisons
cannot exceed `Number.MAX_SAFE_INTEGER` bytes because positions must remain
exactly representable.

A reported file size above the limit throws `FsSafeError("too-large")` before
reading. At the limit, the comparison reads at most one additional byte from
each input to prove EOF; any observed overflow throws the same error. A
matching prefix is never reported as complete equality. An early mismatch
does not scan the remaining bytes or promise to detect later errors or growth.
A zero-byte limit admits two empty files. Memory use is at most two 1 MiB
payload buffers, regardless of file size.

The operation neither changes the descriptors' current offsets nor closes
them, including on failure. It performs no writes, hashing, pathname lookup,
or identity comparison. Callers retain path admission, hardlink policy,
descriptor lifetime, and any before/after mutation-fingerprint checks. A
comparison is not a snapshot of concurrently modified files; applications
requiring stable contents must retain their existing coordination and checks.

Use [`readFileWindowFullySync()`](positional-read.md) for a selected byte
window and [bounded descriptor reads](advanced.md#files-and-identity) when the
caller needs the file contents in memory.
