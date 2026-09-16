import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// Linux-only proof of copy_file_range false EOF before and after progress.
// strace alters only this script's child, never the package or another process.
assert.equal(process.platform, "linux", "this proof requires Linux and strace");
const rangeChunkBytes = 16 * 1024 * 1024;
const cases = [
  "regular",
  "empty",
  "proc",
  "proc-limit",
  "publication",
  "publication-empty",
  "offset",
  "progress",
  "progress-offset",
  "progress-eof",
];
const run = promisify(execFile);

if (process.argv[2] === "--child") {
  const kind = process.argv[3];
  assert(cases.includes(kind));
  const { configureFsSafeNative, root } = await import("../dist/index.js");
  const { publishFileExclusive } = await import("../dist/durability.js");
  configureFsSafeNative({ mode: "require" });
  const progress = kind.startsWith("progress");
  const sourceDirectory = await fs.mkdtemp("/dev/shm/fs-safe-offload-source-");
  const destinationDirectory = await fs.mkdtemp(
    path.join(progress ? "/dev/shm" : os.tmpdir(), "fs-safe-offload-target-"),
  );
  try {
    const sourceDevice = (await fs.stat(sourceDirectory)).dev;
    const destinationDevice = (await fs.stat(destinationDirectory)).dev;
    if (progress) {
      // tmpfs lacks FICLONE but supports same-filesystem copy_file_range. Keeping
      // each fixture below 17 MiB fits source and target in a 64 MiB /dev/shm.
      assert.equal(
        (await fs.statfs(sourceDirectory)).type,
        0x01021994,
        "progress proof requires tmpfs",
      );
      assert.equal(sourceDevice, destinationDevice);
    } else {
      // Cross-device copying prevents FICLONE or hard-link publication from
      // avoiding the first-call range-copy cases.
      assert.notEqual(sourceDevice, destinationDevice);
    }
    const sourcePath = kind.startsWith("proc")
      ? "/proc/version"
      : path.join(sourceDirectory, "source");
    const empty = kind.endsWith("empty");
    if (!kind.startsWith("proc")) {
      const length = progress
        ? rangeChunkBytes + (kind === "progress-eof" ? 0 : 262_181)
        : empty ? 0 : 262_181;
      const bytes = Buffer.allocUnsafe(length);
      for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
      await fs.writeFile(sourcePath, bytes);
    }
    const expected = await fs.readFile(sourcePath);
    const sourceStat = await fs.stat(sourcePath);
    const sourceIdentity = await fs.stat(sourcePath, { bigint: true });
    if (kind.startsWith("proc")) {
      assert.equal(sourceStat.size, 0);
      assert(expected.length > 0, "the zero-size source must have readable bytes");
    }
    const targetPath = path.join(destinationDirectory, "copy");
    let transferMethod;
    let cursorsPreserved;
    if (kind.startsWith("publication")) {
      const result = await publishFileExclusive({
        sourcePath,
        targetPath,
        strategy: "link-or-copy",
      });
      assert.equal(result.method, "exclusive-copy");
    } else if (kind.endsWith("offset") || kind === "progress-eof") {
      const { requireNativeBinding } = await import("../dist/native.js");
      const binding = requireNativeBinding();
      const source = await fs.open(sourcePath, "r");
      const parent = await fs.open(
        destinationDirectory,
        fsSync.constants.O_RDONLY | fsSync.constants.O_DIRECTORY,
      );
      try {
        await source.read(Buffer.alloc(7), 0, 7, null);
        const copied = await binding.copyFileExclusive(
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
          transferMethod = copied.method;
          const next = Buffer.alloc(1);
          await source.read(next, 0, 1, null);
          assert.equal(next[0], expected[7], "copy must preserve the caller's source cursor");
          assert.equal(fsSync.readSync(copied.fd, next, 0, 1, null), 1);
          assert.equal(next[0], expected[0], "copy must leave the created target cursor at zero");
          cursorsPreserved = true;
        } finally {
          binding.closeOwnedFd(copied.fd);
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
      if (progress) {
        const targetStat = await fs.stat(targetPath, { bigint: true });
        assert.equal(targetStat.mode & 0o7777n, 0o600n, "copied file must retain private mode");
        assert.equal(targetStat.nlink, 1n, "copied file must have an independent identity");
        assert.notEqual(targetStat.ino, sourceIdentity.ino, "same-device copy must use a new inode");
      }
      console.log(
        JSON.stringify({
          kind,
          sourceStatBytes: sourceStat.size,
          expectedBytes: expected.length,
          actualBytes: actual.length,
          sha256: createHash("sha256").update(actual).digest("hex"),
          transferMethod,
          cursorsPreserved,
        }),
      );
      assert(actual.equals(expected), "copied bytes must match the readable source");
      await fs.writeFile(targetPath, "independent destination");
      assert(
        (await fs.readFile(sourcePath)).equals(expected),
        "destination edits must preserve the source",
      );
      const currentSourceIdentity = await fs.stat(sourcePath, { bigint: true });
      assert.equal(currentSourceIdentity.dev, sourceIdentity.dev);
      assert.equal(currentSourceIdentity.ino, sourceIdentity.ino);
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
        const progress = kind.startsWith("progress");
        if (injected) args.push("-e", `inject=copy_file_range:retval=0:when=${progress ? 2 : 1}`);
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
        if (progress) {
          const calls = trace.split("\n").filter((line) => line.includes("copy_file_range("));
          assert(calls.length >= 2, "progress proof requires a later range call");
          assert.match(
            calls[0],
            new RegExp(`= ${rangeChunkBytes}$`),
            "the first range call must copy a real full chunk",
          );
          if (injected) {
            assert.match(
              calls[1],
              /= 0 \(INJECTED\)/,
              "the second range result must be injected after progress",
            );
          }
        } else if (injected) {
          assert.match(trace, /= 0 \(INJECTED\)/, "the first range result must be injected");
        }
        const outcome = JSON.parse(result.stdout);
        if (kind === "progress-offset") {
          assert.equal(outcome.transferMethod, injected ? "copy" : "copy-file-range");
        } else if (kind === "progress-eof") {
          assert.equal(outcome.transferMethod, "copy-file-range", "real EOF must complete the offload path");
        }
        console.log(JSON.stringify({ injected, ...outcome }));
      }
    }
  } finally {
    await fs.rm(traceDirectory, { recursive: true, force: true });
  }
}
