# Anonymous pipes

`@openclaw/fs-safe/pipe` exposes a synchronous, native anonymous pipe for
one-shot input to a child process. Both ends are reopenable through
`/proc/self/fd/N` on Linux and `/dev/fd/N` on Darwin and FreeBSD. This supports
programs that open an inherited descriptor as a pathname.

```ts
import { createPipe, type OwnedPipeSync } from "@openclaw/fs-safe/pipe";

const pipe: OwnedPipeSync = createPipe();
try {
  // Pass pipe.reader.fd as a numeric child_process spawn stdio entry.
  // Keep both owners alive until their respective users finish.
} finally {
  pipe.reader.close();
  pipe.writer.close();
}
```

The frozen result has `reader` and `writer` members of the existing
`OwnedFileDescriptorSync` type (`readonly fd: number`, `close(): void`, and
`[Symbol.dispose](): void`) and `readonly atomicCloseOnExec: boolean`.
Each end closes idempotently through its native owner. A close attempt consumes
ownership even if it throws; do not retry with a raw close or use the fd again.
The pair itself does not have a `close` or disposal method.

Linux and FreeBSD create both ends atomically with close-on-exec set.
Darwin sets the flag on both ends immediately after creation and reports
`atomicCloseOnExec: false`: a concurrent native fork/exec can inherit an end
in that short window. No JavaScript async work intervenes, but this is not an
atomic inheritance guarantee. Partial setup failure closes both ends.

Importing the subpath is lazy and does not load the addon or the secret-file
modules. Calling `createPipe()` requires a compatible native helper; disabled
or missing helpers throw `FsSafeError` with `helper-unavailable`. Windows and
other unsupported platforms throw `unsupported-platform`. Native creation
failures throw `helper-failed` with the original error as `cause`.

## Handing the writer to a Node stream

A native-created fd must close through its owner, including in Workers.
Provide the stream's custom close hook; do not let Node close it directly.

```ts
import { createWriteStream, write, writev } from "node:fs";
import { createPipe } from "@openclaw/fs-safe/pipe";

const pipe = createPipe();
const stream = createWriteStream("", {
  fd: pipe.writer.fd,
  fs: {
    write,
    writev,
    close(_fd, callback) {
      try {
        pipe.writer.close();
        callback(null);
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
  },
});
// After spawning with pipe.reader.fd in the child's stdio:
pipe.reader.close();
stream.end("one-shot input");
```

Once the stream is created, its lifetime owns use of the writer: keep an error
listener, destroy it on cancellation, and wait for `close` before considering
the fd released. If stream construction fails, close both owners. Closing the
last writer delivers EOF; unread bytes remain available to the reader.
