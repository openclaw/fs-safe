import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// Linux-only proof of the documented first-call copy_file_range false EOF.
// strace alters only this script's child, never the package or another process.
assert.equal(process.platform, "linux", "this proof requires Linux and strace");
const cases = [
  "regular",
  "empty",
  "proc",
  "proc-limit",
  "publication",
  "publication-empty",
  "offset",
];
const run = promisify(execFile);

if (process.argv[2] === "--child") {
  const kind = process.argv[3];
  assert(cases.includes(kind));
  const { configureFsSafeNative, root } = await import("../dist/index.js");
  const { publishFileExclusive } = await import("../dist/durability.js");
  configureFsSafeNative({ mode: "require" });
  const sourceDirectory = await fs.mkdtemp("/dev/shm/fs-safe-offload-source-");
  const destinationDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-offload-target-"));
  try {
    // A real cross-device copy prevents either FICLONE or hard-link publication
    // from avoiding the range-copy call that this proof exercises.
    assert.notEqual(
      (await fs.stat(sourceDirectory)).dev,
      (await fs.stat(destinationDirectory)).dev,
    );
    const sourcePath = kind.startsWith("proc")
      ? "/proc/version"
      : path.join(sourceDirectory, "source");
    const empty = kind.endsWith("empty");
    if (!kind.startsWith("proc")) {
      const bytes = Buffer.from(
        Array.from({ length: empty ? 0 : 262_181 }, (_, index) => index % 251),
      );
      await fs.writeFile(sourcePath, bytes);
    }
    const expected = await fs.readFile(sourcePath);
    const sourceStat = await fs.stat(sourcePath);
    if (kind.startsWith("proc")) {
      assert.equal(sourceStat.size, 0);
      assert(expected.length > 0, "the zero-size source must have readable bytes");
    }
    const targetPath = path.join(destinationDirectory, "copy");
    if (kind.startsWith("publication")) {
      const result = await publishFileExclusive({
        sourcePath,
        targetPath,
        strategy: "link-or-copy",
      });
      assert.equal(result.method, "exclusive-copy");
    } else if (kind === "offset") {
      const { requireNativeBinding } = await import("../dist/native.js");
      const source = await fs.open(sourcePath, "r");
      const parent = await fs.open(
        destinationDirectory,
        fsSync.constants.O_RDONLY | fsSync.constants.O_DIRECTORY,
      );
      try {
        await source.read(Buffer.alloc(7), 0, 7, null);
        const copied = await requireNativeBinding().copyFileExclusive(
          source.fd,
          parent.fd,
          "copy",
          "auto",
          expected.length,
          undefined,
          false,
        );
        try {
          assert.equal(copied.errorCode, undefined);
          const next = Buffer.alloc(1);
          await source.read(next, 0, 1, null);
          assert.equal(next[0], expected[7], "copy must preserve the caller's source cursor");
        } finally {
          fsSync.closeSync(copied.fd);
        }
      } finally {
        await source.close();
        await parent.close();
      }
    } else {
      const destination = await root(destinationDirectory);
      const pending = destination.copyIn("copy", sourcePath, {
        clone: "auto",
        overwrite: false,
        maxBytes: kind === "proc-limit" ? 0 : expected.length,
      });
      if (kind === "proc-limit") {
        await assert.rejects(pending, { code: "too-large" });
        assert.deepEqual(await fs.readdir(destinationDirectory), []);
        console.log(JSON.stringify({ kind, result: "too-large", destinationAbsent: true }));
      } else {
        await pending;
      }
    }
    if (kind !== "proc-limit") {
      const actual = await fs.readFile(targetPath);
      console.log(
        JSON.stringify({
          kind,
          sourceStatBytes: sourceStat.size,
          expectedBytes: expected.length,
          actualBytes: actual.length,
          sha256: createHash("sha256").update(actual).digest("hex"),
        }),
      );
      assert(actual.equals(expected), "copied bytes must match the readable source");
      await fs.writeFile(targetPath, "independent destination");
      assert(
        (await fs.readFile(sourcePath)).equals(expected),
        "destination edits must preserve the source",
      );
      assert.deepEqual(await fs.readdir(destinationDirectory), ["copy"]);
    }
  } finally {
    // Both paths were created by this child; all copy work has settled.
    await fs.rm(destinationDirectory, { recursive: true, force: true });
    await fs.rm(sourceDirectory, { recursive: true, force: true });
  }
} else {
  const traceDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-offload-trace-"));
  try {
    for (const injected of [false, true]) {
      for (const kind of cases) {
        const tracePath = path.join(traceDirectory, `${kind}-${injected}.trace`);
        const args = ["-f", "-qq", "-e", "trace=copy_file_range"];
        if (injected) args.push("-e", "inject=copy_file_range:retval=0:when=1");
        args.push(
          "-o",
          tracePath,
          process.execPath,
          fileURLToPath(import.meta.url),
          "--child",
          kind,
        );
        const result = await run("strace", args, { maxBuffer: 1024 * 1024 }).catch((error) => {
          process.stderr.write(error.stdout ?? "");
          process.stderr.write(error.stderr ?? "");
          throw error;
        });
        const trace = await fs.readFile(tracePath, "utf8");
        assert(trace.includes("copy_file_range("), "the real native range-copy path must run");
        if (injected)
          assert.match(trace, /= 0 \(INJECTED\)/, "the first range result must be injected");
        console.log(JSON.stringify({ injected, ...JSON.parse(result.stdout) }));
      }
    }
  } finally {
    await fs.rm(traceDirectory, { recursive: true, force: true });
  }
}
