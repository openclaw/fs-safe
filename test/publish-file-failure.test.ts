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

describe("exclusive publication failure fencing", () => {
  itPosix("rejects source directories and symlinks before creating a target", async () => {
    const root = await tempRoot("fs-safe-publish-source-refusal-");
    const source = path.join(root, "source");
    const link = path.join(root, "link");
    const target = path.join(root, "target");
    await fs.writeFile(source, "content");
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
    const root = await tempRoot("fs-safe-publish-receipt-");
    const source = path.join(root, "source");
    const other = path.join(root, "other");
    const target = path.join(root, "target");
    await fs.writeFile(source, "source");
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

  it("preserves an attacker replacement discovered after hardlink creation", async () => {
    configureFsSafeNative({ mode: "off" });
    const root = await tempRoot("fs-safe-publish-target-swap-");
    const source = path.join(root, "source");
    const target = path.join(root, "target");
    const created = path.join(root, "created");
    await fs.writeFile(source, "source");
    __setFsSafeTestHooksForTest({
      async afterPublishTargetCreated(method) {
        expect(method).toBe("hardlink");
        await fs.rename(target, created);
        await fs.writeFile(target, "replacement");
      },
    });

    await expect(
      publishFileExclusive({ sourcePath: source, targetPath: target, strategy: "link-required" }),
    ).rejects.toMatchObject({
      code: "path-mismatch",
      details: { phase: "hardlink-verify", cleanup: "preserved", targetCreated: true },
    });
    await expect(fs.readFile(target, "utf8")).resolves.toBe("replacement");
    await expect(fs.readFile(created, "utf8")).resolves.toBe("source");
  });

  it("rolls back a hardlink if the pinned source path changes after creation", async () => {
    configureFsSafeNative({ mode: "off" });
    const root = await tempRoot("fs-safe-publish-source-swap-");
    const source = path.join(root, "source");
    const oldSource = path.join(root, "old-source");
    const target = path.join(root, "target");
    await fs.writeFile(source, "source");
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

  it("preserves a replacement discovered during exclusive-copy verification", async () => {
    configureFsSafeNative({ mode: "off" });
    const root = await tempRoot("fs-safe-publish-copy-swap-");
    const source = path.join(root, "source");
    const target = path.join(root, "target");
    const created = path.join(root, "created");
    await fs.writeFile(source, "copy source");
    vi.spyOn(fs, "link").mockRejectedValueOnce(
      Object.assign(new Error("cross-device"), { code: "EXDEV" }),
    );
    __setFsSafeTestHooksForTest({
      async afterPublishTargetCreated(method) {
        expect(method).toBe("exclusive-copy");
        await fs.rename(target, created);
        await fs.writeFile(target, "replacement");
      },
    });

    await expect(
      publishFileExclusive({ sourcePath: source, targetPath: target, strategy: "link-or-copy" }),
    ).rejects.toMatchObject({
      code: "path-mismatch",
      details: { phase: "copy-verify", cleanup: "preserved", targetCreated: true },
    });
    await expect(fs.readFile(target, "utf8")).resolves.toBe("replacement");
    await expect(fs.readFile(created, "utf8")).resolves.toBe("copy source");
  });

  it("rolls back an exclusive-copy target when the post-create hook fails", async () => {
    configureFsSafeNative({ mode: "off" });
    const root = await tempRoot("fs-safe-publish-copy-hook-failure-");
    const source = path.join(root, "source");
    const target = path.join(root, "target");
    await fs.writeFile(source, "copy source");
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
    const root = await tempRoot("fs-safe-publish-rename-failure-");
    const source = path.join(root, "source");
    const target = path.join(root, "target");
    await fs.writeFile(source, "content");
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
    const root = await tempRoot("fs-safe-publish-rename-swap-");
    const source = path.join(root, "source");
    const target = path.join(root, "target");
    const renamed = path.join(root, "renamed");
    await fs.writeFile(source, "content");
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
    const root = await tempRoot("fs-safe-publish-rename-source-survives-");
    const source = path.join(root, "source");
    const target = path.join(root, "target");
    await fs.writeFile(source, "content");
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
    const root = await tempRoot("fs-safe-publish-native-fallbacks-");
    const source = path.join(root, "source");
    const target = path.join(root, "target");
    await fs.writeFile(source, "content");
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
    const root = await tempRoot("fs-safe-publish-native-failure-");
    const source = path.join(root, "source");
    const target = path.join(root, "target");
    await fs.writeFile(source, "content");
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

  it("rolls back when an exclusive copy cannot make write progress", async () => {
    configureFsSafeNative({ mode: "off" });
    const root = await tempRoot("fs-safe-publish-copy-no-progress-");
    const source = path.join(root, "source");
    const target = path.join(root, "target");
    await fs.writeFile(source, "content");
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
    const root = await tempRoot("fs-safe-publish-native-target-swap-");
    const source = path.join(root, "source");
    const target = path.join(root, "target");
    const created = path.join(root, "created");
    await fs.writeFile(source, "content");
    __setNativeLoaderForTest(() => ({
      ...native!,
      linkBeneath() {
        throw Object.assign(new Error("force clone"), { code: "EXDEV" });
      },
      cloneFileExclusive() {
        fsSync.copyFileSync(source, target, fsSync.constants.COPYFILE_EXCL);
        return fsSync.openSync(target, "r+");
      },
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
