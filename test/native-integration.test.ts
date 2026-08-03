import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { expectFsSafeError } from "./helpers/security.js";
import { itWin32, useTempDirs } from "./helpers/vitest.js";
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

const { tempRoot } = useTempDirs();

afterEach(() => {
  configureFsSafeNative({ mode: "auto" });
  __resetNativeLoaderForTest();
});

async function pinnedWriteRoot(
  mode: "off" | "require",
  suffix: string,
): Promise<string> {
  if (mode === "require") __setNativeLoaderForTest(() => native!);
  configureFsSafeNative({ mode });
  return await tempRoot(`fs-safe-${mode}-${suffix}-`);
}

describe.runIf(native)("native filesystem primitives", () => {
  it("opens beneath a directory descriptor and reports containment and fd identity", async () => {
    const root = await tempRoot("fs-safe-native-open-");
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
    const root = await tempRoot("fs-safe-native-rename-");
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

  it("replaces an existing target by descriptor-relative native rename", async () => {
    const root = await tempRoot("fs-safe-native-rename-replace-");
    await fs.writeFile(path.join(root, "source"), "source");
    await fs.writeFile(path.join(root, "target"), "target");
    const rootFd = fsSync.openSync(root, fsSync.constants.O_RDONLY);
    try {
      native!.renameReplace(rootFd, "source", rootFd, "target");
    } finally {
      fsSync.closeSync(rootFd);
    }
    await expect(fs.lstat(path.join(root, "source"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(root, "target"), "utf8")).resolves.toBe("source");
  });

  itWin32("rejects reparse-point directory components", async () => {
    const root = await tempRoot("fs-safe-native-reparse-");
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
    const directory = await tempRoot("fs-safe-native-write-");
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
    await expect(
      runPinnedWriteHelper({
        rootPath: directory,
        relativeParentPath: "nested",
        basename: "value",
        mkdir: true,
        mode: 0o600,
        overwrite: false,
        input: { kind: "buffer", data: "second" },
      }),
    ).rejects.toMatchObject({ code: "EEXIST" });
  });

  it.each(["off", "require"] as const)(
    "rejects a create-only collision before consuming the input stream in %s mode",
    async (mode) => {
      const directory = await pinnedWriteRoot(mode, "collision-stream");
      await fs.writeFile(path.join(directory, "value"), "original");
      let consumed = false;
      const stream = Readable.from((async function* () {
        consumed = true;
        yield "replacement";
      })());

      await expect(
        runPinnedWriteHelper({
          rootPath: directory,
          relativeParentPath: "",
          basename: "value",
          mkdir: false,
          mode: 0o600,
          overwrite: false,
          input: { kind: "stream", stream },
        }),
      ).rejects.toMatchObject({ code: "EEXIST" });
      expect(consumed).toBe(false);
      await expect(fs.readFile(path.join(directory, "value"), "utf8")).resolves.toBe(
        "original",
      );
    },
  );

  it.runIf(process.platform !== "win32").each(["off", "require"] as const)(
    "preserves an explicit zero file mode in %s mode",
    async (mode) => {
      const directory = await pinnedWriteRoot(mode, "zero-mode");

      await runPinnedWriteHelper({
        rootPath: directory,
        relativeParentPath: "",
        basename: "value",
        mkdir: false,
        mode: 0o000,
        overwrite: false,
        input: { kind: "buffer", data: "private" },
      });

      expect((await fs.stat(path.join(directory, "value"))).mode & 0o777).toBe(0o000);
    },
  );

  it.each(["off", "require"] as const)(
    "removes partial output when a streamed write exceeds its limit in %s mode",
    async (mode) => {
      const directory = await pinnedWriteRoot(mode, "stream-limit");
      const stream = Readable.from([Buffer.from("12"), Buffer.from("34")]);

      await expect(
        runPinnedWriteHelper({
          rootPath: directory,
          relativeParentPath: "",
          basename: "value",
          mkdir: false,
          mode: 0o600,
          maxBytes: 3,
          overwrite: false,
          input: { kind: "stream", stream },
        }),
      ).rejects.toMatchObject({ code: "too-large" });
      await expect(fs.readdir(directory)).resolves.toEqual([]);
    },
  );

  it.each(["off", "require"] as const)(
    "allows exactly one of many concurrent create-only writes in %s mode",
    async (mode) => {
      const directory = await pinnedWriteRoot(mode, "write-race");
      const attempts = Array.from({ length: 32 }, (_, index) =>
        runPinnedWriteHelper({
          rootPath: directory,
          relativeParentPath: "",
          basename: "winner",
          mkdir: false,
          mode: 0o600,
          overwrite: false,
          input: { kind: "buffer", data: String(index) },
        }),
      );

      const results = await Promise.allSettled(attempts);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(31);
      expect(Number(await fs.readFile(path.join(directory, "winner"), "utf8"))).toSatisfy(
        (value: number) => Number.isInteger(value) && value >= 0 && value < attempts.length,
      );
    },
  );

  it("uses the native transaction for root-level pinned writes", async () => {
    __setNativeLoaderForTest(() => native!);
    configureFsSafeNative({ mode: "require" });
    const directory = await tempRoot("fs-safe-native-root-write-");
    await runPinnedWriteHelper({
      rootPath: directory,
      relativeParentPath: "",
      basename: "value",
      mkdir: true,
      mode: 0o600,
      overwrite: false,
      input: { kind: "buffer", data: "native-root" },
    });
    await expect(fs.readFile(path.join(directory, "value"), "utf8")).resolves.toBe(
      "native-root",
    );
  });

  it("uses native replace commits for overwrite pinned writes", async () => {
    let replaceCalls = 0;
    __setNativeLoaderForTest(() => ({
      ...native!,
      renameReplace(...args) {
        replaceCalls += 1;
        return native!.renameReplace(...args);
      },
    }));
    configureFsSafeNative({ mode: "require" });
    const directory = await tempRoot("fs-safe-native-overwrite-");
    await fs.mkdir(path.join(directory, "nested"));
    await fs.writeFile(path.join(directory, "nested/value"), "old");
    await runPinnedWriteHelper({
      rootPath: directory,
      relativeParentPath: "nested",
      basename: "value",
      mkdir: true,
      mode: 0o600,
      overwrite: true,
      input: { kind: "buffer", data: "new" },
    });
    expect(replaceCalls).toBe(1);
    await expect(fs.readFile(path.join(directory, "nested/value"), "utf8")).resolves.toBe("new");
  });

  it("rejects native writes when the expected root identity does not match", async () => {
    __setNativeLoaderForTest(() => native!);
    configureFsSafeNative({ mode: "require" });
    const directory = await tempRoot("fs-safe-native-identity-");
    const identity = await fs.lstat(directory);
    await expectFsSafeError(runPinnedWriteHelper({
      rootPath: directory,
      relativeParentPath: "",
      basename: "value",
      mkdir: false,
      mode: 0o600,
      overwrite: false,
      input: { kind: "buffer", data: "value" },
      rootIdentity: { dev: identity.dev + 1, ino: identity.ino },
    }), "path-mismatch");
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
    const directory = await tempRoot("fs-safe-native-lock-");
    const targetPath = path.join(directory, "state.json");
    const lock = await acquireFileLock(targetPath, { payload: () => ({ pid: process.pid }) });
    try {
      expect(exclusiveOpenCalls).toBe(1);
      await expect(lock.verifyStillHeld()).resolves.toBe(true);
    } finally {
      await lock.release();
    }
  });

  itWin32("retries a path-tagged native exclusive-open denial", async () => {
    let exclusiveOpenCalls = 0;
    __setNativeLoaderForTest(() => ({
      ...native!,
      openBeneath(rootFd, relPath, flags) {
        if (flags & fsSync.constants.O_EXCL) {
          exclusiveOpenCalls += 1;
          if (exclusiveOpenCalls === 1) {
            // Match the binding's bare error: the TypeScript operation
            // boundary is responsible for attaching the full lock path.
            throw Object.assign(new Error("open relative path failed with Windows error 5"), {
              code: "EPERM",
            });
          }
        }
        return native!.openBeneath(rootFd, relPath, flags);
      },
    }));
    configureFsSafeNative({ mode: "require" });
    const directory = await fs.realpath(await tempRoot("fs-safe-native-lock-denial-"));
    const targetPath = path.join(directory, "state.json");
    const lock = await acquireFileLock(targetPath, {
      retry: { minTimeout: 1, maxTimeout: 2 },
      payload: () => ({ pid: process.pid }),
    });
    try {
      expect(exclusiveOpenCalls).toBe(2);
      await expect(lock.verifyStillHeld()).resolves.toBe(true);
    } finally {
      await lock.release();
    }
  });

  itWin32("preserves a native exclusive-open denial after the bounded retry budget", async () => {
    let exclusiveOpenCalls = 0;
    __setNativeLoaderForTest(() => ({
      ...native!,
      openBeneath(rootFd, relPath, flags) {
        if (flags & fsSync.constants.O_EXCL) {
          exclusiveOpenCalls += 1;
          throw Object.assign(new Error("open relative path failed with Windows error 5"), {
            code: "EPERM",
          });
        }
        return native!.openBeneath(rootFd, relPath, flags);
      },
    }));
    configureFsSafeNative({ mode: "require" });
    const directory = await fs.realpath(await tempRoot("fs-safe-native-lock-permission-"));
    const targetPath = path.join(directory, "state.json");
    const lockPath = `${targetPath}.lock`;

    await expect(
      acquireFileLock(targetPath, {
        timeoutMs: 1_000,
        retry: { retries: 20, minTimeout: 1, maxTimeout: 1 },
        payload: () => ({ pid: process.pid }),
      }),
    ).rejects.toMatchObject({ code: "EPERM", path: lockPath });
    expect(exclusiveOpenCalls).toBe(9);
  });

  it("publishes by native rename without replacing an existing target", async () => {
    __setNativeLoaderForTest(() => native!);
    configureFsSafeNative({ mode: "require" });
    const directory = await tempRoot("fs-safe-native-publish-");
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
