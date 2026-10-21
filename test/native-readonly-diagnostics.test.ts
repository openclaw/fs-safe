import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createFileLockManager } from "../src/file-lock.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { useRealTempDirs } from "./helpers/vitest.js";
import { loadTestNative } from "./helpers/native-probe.js";
import { root } from "../src/root.js";
import { copyRootFileSync, createRootFileCopyBatchSync } from "../src/copy-root-file-sync.js";

const { tempRoot } = useRealTempDirs();
const native = loadTestNative("required-env");

afterEach(() => {
  __resetNativeLoaderForTest();
  __resetFsSafeNativeConfigForTest();
});

it("names a read-only native lock creation without retrying or acquiring ownership", async () => {
  const directory = await tempRoot("fs-safe-readonly-lock-");
  const target = path.join(directory, "state\nname\nlock");
  const lockPath = `${target}.lock`;
  const failure = Object.assign(new Error("openat2 beneath root: Read-only file system (os error 30)"), {
    code: "EROFS", errno: 30,
  });
  let attempts = 0;
  __setNativeLoaderForTest(() => ({
    closeOwnedFd: fs.closeSync,
    openBeneath(_fd, name, flags) {
      attempts++;
      expect(name).toBe(path.basename(lockPath));
      expect(flags & (fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL))
        .toBe(fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL);
      throw failure;
    },
  }));
  configureFsSafeNative({ mode: "require" });
  const manager = createFileLockManager(`readonly:${directory}`);
  const caught = await manager.acquire(target, {
    payload: () => ({ pid: process.pid }),
    retry: { retries: 3, minTimeout: 1, maxTimeout: 1 },
  }).catch((error: unknown) => error);
  expect(caught).toBe(failure);
  expect(caught).toMatchObject({
    code: "EROFS", errno: 30, path: lockPath, syscall: "open",
    message: `EROFS: read-only filesystem, open '${lockPath.replaceAll("\n", "\\u000a")}'`,
  });
  expect(attempts).toBe(1);
  expect(manager.heldEntries()).toEqual([]);
  expect(await fsp.readdir(directory)).toEqual([]);
});

it("preserves an immutable native read-only error", async () => {
  const directory = await tempRoot("fs-safe-readonly-frozen-");
  const failure = Object.freeze(Object.assign(new Error("read-only"), { code: "EROFS" }));
  __setNativeLoaderForTest(() => ({
    closeOwnedFd: fs.closeSync,
    openBeneath() { throw failure; },
  }));
  configureFsSafeNative({ mode: "require" });
  const manager = createFileLockManager(`readonly-frozen:${directory}`);
  await expect(manager.acquire(path.join(directory, "state"), { payload: () => ({}) })).rejects.toBe(failure);
  expect(manager.heldEntries()).toEqual([]);
});

it.runIf(native?.createStagedFile)("keeps the Root lock error contract and names its failed native stage", async () => {
  const directory = await fsp.realpath(await tempRoot("fs-safe-readonly-root-lock-"));
  const failure = Object.assign(new Error("create staged child: read-only"), { code: "EROFS" });
  let stagePath: string | undefined;
  __setNativeLoaderForTest(() => ({
    ...native!,
    createStagedFile(_fd, name) {
      stagePath = path.join(directory, name);
      throw failure;
    },
  }));
  configureFsSafeNative({ mode: "require" });
  const lockRoot = await root(directory);
  const manager = createFileLockManager(`readonly-root:${directory}`);
  const caught = await manager.acquire(path.join(directory, "state"), {
    lockRoot, payload: () => ({}),
  }).catch((error: unknown) => error);
  expect(caught).toMatchObject({
    code: "invalid-path", message: "read-only filesystem (EROFS)", cause: failure,
  });
  expect(stagePath).toBeDefined();
  expect(failure).toMatchObject({ path: stagePath, syscall: "open" });
  expect(manager.heldEntries()).toEqual([]);
  expect(await fsp.readdir(directory)).toEqual([]);
});

it.runIf(native?.copyFileExclusive)("names a read-only native copy stage before wrapping its error", async () => {
  const directory = await fsp.realpath(await tempRoot("fs-safe-readonly-copy-"));
  const source = path.join(directory, "source");
  await fsp.writeFile(source, "source bytes");
  const failure = Object.assign(new Error("create copy destination: read-only"), { code: "EROFS", errno: 30 });
  let stagePath: string | undefined;
  let attempts = 0;
  __setNativeLoaderForTest(() => ({
    ...native!,
    async copyFileExclusive(_sourceFd, _parentFd, name) {
      attempts++;
      stagePath = path.join(directory, name);
      throw failure;
    },
  }));
  configureFsSafeNative({ mode: "require" });
  const scoped = await root(directory);
  const caught = await scoped.copyIn("target", source).catch((error: unknown) => error);
  expect(caught).toMatchObject({ code: "helper-failed", message: "native file copy failed", cause: failure });
  expect(stagePath).toBeDefined();
  expect(failure).toMatchObject({ code: "EROFS", errno: 30, path: stagePath, syscall: "open" });
  expect(attempts).toBe(1);
  expect(await fsp.readdir(directory)).toEqual(["source"]);
  expect(await fsp.readFile(source, "utf8")).toBe("source bytes");
});

it.runIf(process.platform !== "win32" && native?.copyFileExclusiveSync && native?.removeStagedFile)
  .each(["single", "batch"] as const)("names a read-only synchronous native copy destination (%s)", async shape => {
    const directory = await fsp.realpath(await tempRoot("fs-safe-readonly-sync-copy-"));
    const source = path.join(directory, "source");
    const target = path.join(directory, "target");
    await fsp.writeFile(source, "source bytes");
    const failure = Object.assign(new Error("create copy destination: read-only"), { code: "EROFS", errno: 30 });
    let attempts = 0;
    __setNativeLoaderForTest(() => ({
      ...native!,
      copyFileExclusiveSync(_sourceFd, _parentFd, name) {
        attempts++;
        expect(name).toBe("target");
        throw failure;
      },
    }));
    configureFsSafeNative({ mode: "require" });
    using batch = createRootFileCopyBatchSync();
    const copy = shape === "single" ? copyRootFileSync : batch.copyFile;
    let caught: unknown;
    try {
      copy({
        source: { rootPath: directory, absolutePath: source },
        destination: { rootPath: directory, absolutePath: target },
      });
    } catch (error) { caught = error; }
    expect(caught).toMatchObject({ code: "helper-failed", message: "guarded synchronous file copy failed" });
    expect((caught as Error).cause).toBe(failure);
    expect(failure).toMatchObject({ code: "EROFS", errno: 30, path: target, syscall: "open" });
    expect(attempts).toBe(1);
    expect(await fsp.readdir(directory)).toEqual(["source"]);
    expect(await fsp.readFile(source, "utf8")).toBe("source bytes");
  });
