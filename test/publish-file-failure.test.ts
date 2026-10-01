import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { itPosix, useTempDirs } from "./helpers/vitest.js";
import {
  configureFsSafeNative,
  __resetFsSafeNativeConfigForTest,
} from "../src/native-config.js";
import {
  __loadBundledNativeForTest,
  __resetNativeLoaderForTest,
  __setNativeLoaderForTest,
  type NativeBinding,
} from "../src/native.js";
import { publishFileExclusive } from "../src/publish-file.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";

const { tempRoot } = useTempDirs();
let native: NativeBinding | undefined;
try {
  native = __loadBundledNativeForTest();
} catch {
  // JS-only checks do not stage the binding; native-built coverage does.
}

afterEach(() => {
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
  __setFsSafeTestHooksForTest();
  vi.restoreAllMocks();
});

async function fixture(prefix: string, bytes: string) {
  const root = await tempRoot(prefix);
  const source = path.join(root, "source");
  const target = path.join(root, "target");
  await fs.writeFile(source, bytes);
  return { root, source, target };
}

describe("exclusive publication failure fencing", () => {
  itPosix("rejects source directories and symlinks before creating a target", async () => {
    const { root, source, target } = await fixture("fs-safe-publish-source-refusal-", "content");
    const link = path.join(root, "link");
    await fs.symlink(source, link);

    await expect(
      publishFileExclusive({ sourcePath: root, targetPath: target, strategy: "link-required" }),
    ).rejects.toMatchObject({ code: "not-file" });
    await expect(
      publishFileExclusive({ sourcePath: link, targetPath: target, strategy: "link-required" }),
    ).rejects.toMatchObject({ code: "not-file" });
    await expect(fs.access(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a mismatched parent receipt and expected source identity", async () => {
    const { root, source, target } = await fixture("fs-safe-publish-receipt-", "source");
    const other = path.join(root, "other");
    await fs.writeFile(other, "other");

    await expect(
      publishFileExclusive({
        sourcePath: source,
        targetPath: target,
        strategy: "link-required",
        parentReceipt: { path: path.join(root, "wrong") } as never,
      }),
    ).rejects.toMatchObject({ code: "path-mismatch" });
    await expect(
      publishFileExclusive({
        sourcePath: source,
        targetPath: target,
        strategy: "link-required",
        expectedSourceIdentity: await fs.stat(other),
      }),
    ).rejects.toMatchObject({ code: "path-mismatch" });
    await expect(fs.access(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    { strategy: "link-required", method: "hardlink", phase: "hardlink-verify", bytes: "source", prefix: "fs-safe-publish-target-swap-" },
    { strategy: "link-or-copy", method: "exclusive-copy", phase: "copy-verify", bytes: "copy source", prefix: "fs-safe-publish-copy-swap-" },
  ] as const)("preserves a replacement discovered after $method creation", async ({ strategy, method, phase, bytes, prefix }) => {
    configureFsSafeNative({ mode: "off" });
    const { root, source, target } = await fixture(prefix, bytes);
    const created = path.join(root, "created");
    if (method === "exclusive-copy") {
      vi.spyOn(fs, "link").mockRejectedValueOnce(
        Object.assign(new Error("cross-device"), { code: "EXDEV" }),
      );
    }
    __setFsSafeTestHooksForTest({
      async afterPublishTargetCreated(actual) {
        expect(actual).toBe(method);
        await fs.rename(target, created);
        await fs.writeFile(target, "replacement");
      },
    });

    await expect(
      publishFileExclusive({ sourcePath: source, targetPath: target, strategy }),
    ).rejects.toMatchObject({
      code: "path-mismatch",
      details: { phase, cleanup: "preserved", targetCreated: true },
    });
    await expect(fs.readFile(target, "utf8")).resolves.toBe("replacement");
    await expect(fs.readFile(created, "utf8")).resolves.toBe(bytes);
  });

  it("rolls back a hardlink if the pinned source path changes after creation", async () => {
    configureFsSafeNative({ mode: "off" });
    const { root, source, target } = await fixture("fs-safe-publish-source-swap-", "source");
    const oldSource = path.join(root, "old-source");
    __setFsSafeTestHooksForTest({
      async afterPublishTargetCreated() {
        await fs.rename(source, oldSource);
        await fs.writeFile(source, "replacement");
      },
    });

    await expect(
      publishFileExclusive({ sourcePath: source, targetPath: target, strategy: "link-required" }),
    ).rejects.toMatchObject({
      code: "path-mismatch",
      details: { phase: "hardlink-verify", cleanup: "removed", targetCreated: true },
    });
    await expect(fs.access(target)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(source, "utf8")).resolves.toBe("replacement");
    await expect(fs.readFile(oldSource, "utf8")).resolves.toBe("source");
  });

  it("rolls back an exclusive-copy target when the post-create hook fails", async () => {
    configureFsSafeNative({ mode: "off" });
    const { source, target } = await fixture("fs-safe-publish-copy-hook-failure-", "copy source");

    vi.spyOn(fs, "link").mockRejectedValueOnce(
      Object.assign(new Error("cross-device"), { code: "EXDEV" }),
    );
    __setFsSafeTestHooksForTest({
      afterPublishTargetCreated(method) {
        expect(method).toBe("exclusive-copy");
        throw new Error("verification unavailable");
      },
    });

    await expect(
      publishFileExclusive({ sourcePath: source, targetPath: target, strategy: "link-or-copy" }),
    ).rejects.toMatchObject({
      code: "helper-failed",
      details: { phase: "copy-verify", cleanup: "removed", targetCreated: true },
    });
    await expect(fs.access(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.runIf(Boolean(native))("preserves the only remaining name after a post-rename verification failure", async () => {
    const { source, target } = await fixture("fs-safe-publish-rename-failure-", "content");

    __setFsSafeTestHooksForTest({
      afterPublishTargetCreated(method) {
        expect(method).toBe("rename-noreplace");
        throw new Error("post-rename verification unavailable");
      },
    });

    await expect(
      publishFileExclusive({ sourcePath: source, targetPath: target, strategy: "rename-noreplace" }),
    ).rejects.toMatchObject({
      code: "helper-failed",
      details: { phase: "rename-verify", cleanup: "preserved", targetCreated: true },
    });
    await expect(fs.access(source)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(target, "utf8")).resolves.toBe("content");
  });

  it.runIf(Boolean(native))("preserves a replacement target detected after native rename", async () => {
    const { root, source, target } = await fixture("fs-safe-publish-rename-swap-", "content");
    const renamed = path.join(root, "renamed");
    __setFsSafeTestHooksForTest({
      async afterPublishTargetCreated() {
        await fs.rename(target, renamed);
        await fs.writeFile(target, "replacement");
      },
    });
    await expect(
      publishFileExclusive({ sourcePath: source, targetPath: target, strategy: "rename-noreplace" }),
    ).rejects.toMatchObject({
      code: "path-mismatch",
      details: { phase: "rename-verify", cleanup: "preserved" },
    });
    await expect(fs.readFile(target, "utf8")).resolves.toBe("replacement");
    await expect(fs.readFile(renamed, "utf8")).resolves.toBe("content");
  });

  it.runIf(Boolean(native))("fails if the source name unexpectedly survives native rename", async () => {
    const { source, target } = await fixture("fs-safe-publish-rename-source-survives-", "content");

    __setFsSafeTestHooksForTest({
      async afterPublishTargetCreated() {
        await fs.writeFile(source, "replacement");
      },
    });
    await expect(
      publishFileExclusive({ sourcePath: source, targetPath: target, strategy: "rename-noreplace" }),
    ).rejects.toMatchObject({
      code: "path-mismatch",
      details: { phase: "rename-verify", cleanup: "preserved" },
    });
    await expect(fs.readFile(source, "utf8")).resolves.toBe("replacement");
    await expect(fs.readFile(target, "utf8")).resolves.toBe("content");
  });

  it.runIf(Boolean(native))("falls through both classified native-copy failures to the fenced JS copy", async () => {
    const { source, target } = await fixture("fs-safe-publish-native-fallbacks-", "content");

    __setNativeLoaderForTest(() => ({
      ...native!,
      linkBeneath() {
        throw Object.assign(new Error("force copy"), { code: "EXDEV" });
      },
      cloneFileExclusive() {
        throw Object.assign(new Error("clone unsupported"), { code: "ENOTSUP" });
      },
      async copyFileRangeExclusive() {
        return { fd: -1, bytes: 0, errorCode: "EOPNOTSUPP", errorMessage: "range unsupported" };
      },
    }));
    configureFsSafeNative({ mode: "require" });
    await expect(
      publishFileExclusive({ sourcePath: source, targetPath: target, strategy: "link-or-copy" }),
    ).resolves.toMatchObject({ method: "exclusive-copy" });
    await expect(fs.readFile(target, "utf8")).resolves.toBe("content");
  });

  it.runIf(Boolean(native))("propagates an unclassified native clone failure without leaving a target", async () => {
    const { source, target } = await fixture("fs-safe-publish-native-failure-", "content");

    __setNativeLoaderForTest(() => ({
      ...native!,
      linkBeneath() {
        throw Object.assign(new Error("force copy"), { code: "EXDEV" });
      },
      cloneFileExclusive() {
        throw Object.assign(new Error("clone I/O failure"), { code: "EIO" });
      },
    }));
    configureFsSafeNative({ mode: "require" });
    await expect(
      publishFileExclusive({ sourcePath: source, targetPath: target, strategy: "link-or-copy" }),
    ).rejects.toMatchObject({ code: "EIO" });
    await expect(fs.access(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rolls back when JavaScript copy mode normalization fails", async () => {
    configureFsSafeNative({ mode: "off" });
    const { source, target } = await fixture("fs-safe-publish-copy-mode-failure-", "content");

    vi.spyOn(fs, "link").mockRejectedValueOnce(
      Object.assign(new Error("force copy"), { code: "EXDEV" }),
    );
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      if (String(args[0]) === target && args[1] === "wx+") {
        vi.spyOn(handle, "chmod").mockRejectedValueOnce(
          Object.assign(new Error("mode denied"), { code: "EACCES" }),
        );
      }
      return handle;
    });

    await expect(
      publishFileExclusive({ sourcePath: source, targetPath: target, strategy: "link-or-copy" }),
    ).rejects.toMatchObject({
      code: "helper-failed",
      details: { phase: "copy-verify", cleanup: "removed" },
    });
    await expect(fs.access(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.runIf(Boolean(native))("rolls back when native copy mode normalization fails", async () => {
    const { source, target } = await fixture("fs-safe-publish-native-mode-failure-", "content");

    let targetFd: number | undefined;
    __setNativeLoaderForTest(() => ({
      ...native!,
      linkBeneath() {
        throw Object.assign(new Error("force clone"), { code: "EXDEV" });
      },
      cloneFileExclusive() {
        fsSync.copyFileSync(source, target, fsSync.constants.COPYFILE_EXCL);
        targetFd = fsSync.openSync(target, "r+");
        return targetFd;
      },
      closeOwnedFd: fsSync.closeSync,
    }));
    configureFsSafeNative({ mode: "require" });
    const realFchmod = fsSync.fchmodSync.bind(fsSync);
    vi.spyOn(fsSync, "fchmodSync").mockImplementation((fd, mode) => {
      if (fd === targetFd) {
        throw Object.assign(new Error("mode denied"), { code: "EACCES" });
      }
      return realFchmod(fd, mode);
    });

    await expect(
      publishFileExclusive({ sourcePath: source, targetPath: target, strategy: "link-or-copy" }),
    ).rejects.toMatchObject({
      code: "helper-failed",
      details: { phase: "copy-verify", cleanup: "removed" },
    });
    await expect(fs.access(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(() => fsSync.fstatSync(targetFd!)).toThrow(
      expect.objectContaining({ code: "EBADF" }),
    );
  });

  it("rolls back when an exclusive copy cannot make write progress", async () => {
    configureFsSafeNative({ mode: "off" });
    const { source, target } = await fixture("fs-safe-publish-copy-no-progress-", "content");

    vi.spyOn(fs, "link").mockRejectedValueOnce(Object.assign(new Error("force copy"), { code: "EXDEV" }));
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      if (String(args[0]) === target && args[1] === "wx+") {
        vi.spyOn(handle, "write").mockResolvedValueOnce({ bytesWritten: 0, buffer: Buffer.alloc(0) });
      }
      return handle;
    });
    await expect(
      publishFileExclusive({ sourcePath: source, targetPath: target, strategy: "link-or-copy" }),
    ).rejects.toMatchObject({ code: "helper-failed", details: { cleanup: "removed" } });
    await expect(fs.access(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.runIf(Boolean(native))("closes a native clone descriptor when target identity verification fails", async () => {
    const { root, source, target } = await fixture("fs-safe-publish-native-target-swap-", "content");
    const created = path.join(root, "created");
    __setNativeLoaderForTest(() => ({
      ...native!,
      linkBeneath() {
        throw Object.assign(new Error("force clone"), { code: "EXDEV" });
      },
      cloneFileExclusive() {
        fsSync.copyFileSync(source, target, fsSync.constants.COPYFILE_EXCL);
        return fsSync.openSync(target, "r+");
      },
      closeOwnedFd: fsSync.closeSync,
    }));
    configureFsSafeNative({ mode: "require" });
    __setFsSafeTestHooksForTest({
      async afterPublishTargetCreated() {
        await fs.rename(target, created);
        await fs.writeFile(target, "replacement");
      },
    });
    await expect(
      publishFileExclusive({ sourcePath: source, targetPath: target, strategy: "link-or-copy" }),
    ).rejects.toMatchObject({ code: "path-mismatch", details: { cleanup: "preserved" } });
    await expect(fs.readFile(target, "utf8")).resolves.toBe("replacement");
  });
});
