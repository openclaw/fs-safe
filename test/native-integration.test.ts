import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configureFsSafeNative } from "../src/native-config.js";
import { acquireFileLock } from "../src/file-lock.js";
import {
  __loadBundledNativeForTest,
  __resetNativeLoaderForTest,
  __setNativeLoaderForTest,
  type NativeBinding,
} from "../src/native.js";
import { publishFileExclusive } from "../src/publish-file.js";
import { runPinnedWriteHelper } from "../src/pinned-write.js";

let native: NativeBinding | undefined;
try {
  native = __loadBundledNativeForTest();
} catch {
  // Native artifacts are built by dedicated platform jobs. The ordinary JS
  // matrix deliberately proves that installation without them still works.
}

const roots: string[] = [];

afterEach(async () => {
  configureFsSafeNative({ mode: "auto" });
  __resetNativeLoaderForTest();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe.runIf(native)("native filesystem primitives", () => {
  it("opens beneath a directory descriptor and reports containment and fd identity", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-native-open-"));
    roots.push(root);
    await fs.mkdir(path.join(root, "nested"));
    await fs.writeFile(path.join(root, "nested", "value"), "ok");
    const rootFd = fsSync.openSync(root, fsSync.constants.O_RDONLY);
    try {
      const opened = native!.openBeneath(rootFd, "nested/value", fsSync.constants.O_RDONLY);
      expect(opened.containment).toBe(
        process.platform === "linux" ? "kernel-atomic" : "best-effort",
      );
      try {
        expect(native!.fstatIdentity(opened.fd)).toMatchObject({ isFile: true, size: 2 });
      } finally {
        fsSync.closeSync(opened.fd);
      }
      expect(() => native!.openBeneath(rootFd, "../outside", fsSync.constants.O_RDONLY)).toThrow();
    } finally {
      fsSync.closeSync(rootFd);
    }
  });

  it("maps no-replace collisions to EEXIST without changing either file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-native-rename-"));
    roots.push(root);
    await fs.writeFile(path.join(root, "source"), "source");
    await fs.writeFile(path.join(root, "target"), "target");
    const rootFd = fsSync.openSync(root, fsSync.constants.O_RDONLY);
    try {
      expect(() => native!.renameNoReplace(rootFd, "source", rootFd, "target")).toThrowError(
        expect.objectContaining({ code: "EEXIST" }),
      );
    } finally {
      fsSync.closeSync(rootFd);
    }
    await expect(fs.readFile(path.join(root, "source"), "utf8")).resolves.toBe("source");
    await expect(fs.readFile(path.join(root, "target"), "utf8")).resolves.toBe("target");
  });

  it.runIf(process.platform === "win32")("rejects reparse-point directory components", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-native-reparse-"));
    roots.push(root);
    const real = path.join(root, "real");
    await fs.mkdir(real);
    await fs.writeFile(path.join(real, "value"), "ok");
    await fs.symlink(real, path.join(root, "alias"), "junction");
    const rootFd = fsSync.openSync(root, fsSync.constants.O_RDONLY);
    try {
      expect(() => native!.openBeneath(rootFd, "alias/value", fsSync.constants.O_RDONLY))
        .toThrow();
    } finally {
      fsSync.closeSync(rootFd);
    }
  });

  it("uses native no-replace commits for create-only pinned writes", async () => {
    let renameCalls = 0;
    __setNativeLoaderForTest(() => ({
      ...native!,
      renameNoReplace(...args) {
        renameCalls += 1;
        return native!.renameNoReplace(...args);
      },
    }));
    configureFsSafeNative({ mode: "require" });
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-native-write-"));
    roots.push(directory);
    await runPinnedWriteHelper({
      rootPath: directory,
      relativeParentPath: "nested",
      basename: "value",
      mkdir: true,
      mode: 0o600,
      overwrite: false,
      input: { kind: "buffer", data: "native" },
    });
    expect(renameCalls).toBe(1);
    await expect(fs.readFile(path.join(directory, "nested/value"), "utf8")).resolves.toBe("native");
  });

  it("rejects native writes when the expected root identity does not match", async () => {
    __setNativeLoaderForTest(() => native!);
    configureFsSafeNative({ mode: "require" });
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-native-identity-"));
    roots.push(directory);
    const identity = await fs.lstat(directory);
    await expect(runPinnedWriteHelper({
      rootPath: directory,
      relativeParentPath: "",
      basename: "value",
      mkdir: false,
      mode: 0o600,
      overwrite: false,
      input: { kind: "buffer", data: "value" },
      rootIdentity: { dev: identity.dev + 1, ino: identity.ino },
    })).rejects.toMatchObject({ code: "path-mismatch" });
  });

  it("creates sidecar locks through native exclusive open", async () => {
    let exclusiveOpenCalls = 0;
    __setNativeLoaderForTest(() => ({
      ...native!,
      openBeneath(rootFd, relPath, flags) {
        if (flags & fsSync.constants.O_EXCL) {
          exclusiveOpenCalls += 1;
        }
        return native!.openBeneath(rootFd, relPath, flags);
      },
    }));
    configureFsSafeNative({ mode: "require" });
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-native-lock-"));
    roots.push(directory);
    const targetPath = path.join(directory, "state.json");
    const lock = await acquireFileLock(targetPath, { payload: () => ({ pid: process.pid }) });
    try {
      expect(exclusiveOpenCalls).toBe(1);
      await expect(lock.verifyStillHeld()).resolves.toBe(true);
    } finally {
      await lock.release();
    }
  });

  it("publishes by native rename without replacing an existing target", async () => {
    __setNativeLoaderForTest(() => native!);
    configureFsSafeNative({ mode: "require" });
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-native-publish-"));
    roots.push(directory);
    const sourcePath = path.join(directory, "source");
    const targetPath = path.join(directory, "target");
    await fs.writeFile(sourcePath, "content");
    const result = await publishFileExclusive({
      sourcePath,
      targetPath,
      strategy: "rename-noreplace",
    });
    expect(result.method).toBe("rename-noreplace");
    await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("content");
    await expect(fs.lstat(sourcePath)).rejects.toMatchObject({ code: "ENOENT" });

    await fs.writeFile(sourcePath, "second");
    await expect(
      publishFileExclusive({ sourcePath, targetPath, strategy: "rename-noreplace" }),
    ).rejects.toMatchObject({ code: "EEXIST" });
    await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe("second");
    await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("content");
  });
});
