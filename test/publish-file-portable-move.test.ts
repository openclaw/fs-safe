import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { publishFileExclusive } from "../src/publish-file.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
afterEach(() => {
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
  __setFsSafeTestHooksForTest();
  vi.restoreAllMocks();
});

it.skipIf(process.platform === "win32" || process.geteuid?.() === 0)(
  "does not require source-parent read permission for a loaded addon without no-replace rename",
  async () => {
    configureFsSafeNative({ mode: "auto" });
    const closeOwnedFd = vi.fn();
    __setNativeLoaderForTest(() => ({ closeOwnedFd } as never));
    const dir = await tempRoot("fs-safe-publication-partial-addon-");
    const sourceParent = path.join(dir, "source-parent");
    const source = path.join(sourceParent, "source");
    const target = path.join(dir, "target");
    await fs.mkdir(sourceParent, { mode: 0o700 });
    await fs.writeFile(source, "original", { mode: 0o600 });
    await fs.chmod(sourceParent, 0o300);
    try {
      await expect(fs.open(sourceParent, "r")).rejects.toMatchObject({ code: "EACCES" });
      const result = await publishFileExclusive({ sourcePath: source, targetPath: target, strategy: "rename-noreplace" });
      expect(result).toMatchObject({ method: "hardlink", sourceConsumed: true });
      expect(await fs.readFile(target, "utf8")).toBe("original");
      await expect(fs.lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
      expect(closeOwnedFd).not.toHaveBeenCalled();
    } finally {
      await fs.chmod(sourceParent, 0o700);
    }
  },
);

for (const mode of ["off", "auto"] as const) {
  describe(`portable moving publication (${mode})`, () => {
    async function fixture() {
      configureFsSafeNative({ mode });
      __setNativeLoaderForTest(() => { throw new Error("optional package omitted"); });
      const dir = await tempRoot("fs-safe-portable-publication-");
      const source = path.join(dir, "source");
      const target = path.join(dir, "target");
      await fs.writeFile(source, "original", { mode: 0o600 });
      return { dir, source, target };
    }

    it("moves without native support and reports the actual method", async () => {
      const { source, target } = await fixture();
      const before = await fs.stat(source, { bigint: true });
      const result = await publishFileExclusive({ sourcePath: source, targetPath: target, strategy: "rename-noreplace" });
      expect(result).toMatchObject({ method: "hardlink", sourceConsumed: true });
      const after = await fs.stat(target, { bigint: true });
      expect({ dev: after.dev, ino: after.ino, nlink: after.nlink }).toEqual({ dev: before.dev, ino: before.ino, nlink: 1n });
      expect(await fs.readFile(target, "utf8")).toBe("original");
      await expect(fs.lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("preserves both files on a collision", async () => {
      const { source, target } = await fixture();
      await fs.writeFile(target, "competitor");
      await expect(publishFileExclusive({ sourcePath: source, targetPath: target, strategy: "rename-noreplace" }))
        .rejects.toMatchObject({ code: "EEXIST" });
      expect(await fs.readFile(source, "utf8")).toBe("original");
      expect(await fs.readFile(target, "utf8")).toBe("competitor");
    });

    it("preserves a read-only source's mode after moving publication", async () => {
      const { source, target } = await fixture();
      await fs.chmod(source, 0o400);
      const before = await fs.stat(source, { bigint: true });
      await publishFileExclusive({ sourcePath: source, targetPath: target, strategy: "rename-noreplace" });
      expect(await fs.stat(target, { bigint: true })).toMatchObject({ dev: before.dev, ino: before.ino, mode: before.mode });
      expect(await fs.readFile(target, "utf8")).toBe("original");
      await expect(fs.lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("retains the existing contract for a source with another hardlink", async () => {
      const { dir, source, target } = await fixture();
      const alias = path.join(dir, "existing-alias");
      await fs.link(source, alias);
      const before = await fs.stat(source, { bigint: true });
      const result = await publishFileExclusive({ sourcePath: source, targetPath: target, strategy: "rename-noreplace" });
      expect(result).toMatchObject({ method: "hardlink", sourceConsumed: true });
      expect(await fs.stat(target, { bigint: true })).toMatchObject({ dev: before.dev, ino: before.ino, nlink: 2n });
      expect(await fs.readFile(alias, "utf8")).toBe("original");
      expect(await fs.readFile(target, "utf8")).toBe("original");
      await expect(fs.lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("accepts a stable alias in the source parent's ancestry", async () => {
      const { dir, target } = await fixture();
      const physical = path.join(dir, "physical");
      const sourceParent = path.join(physical, "source-parent");
      const ancestorAlias = path.join(dir, "ancestor-alias");
      await fs.mkdir(sourceParent, { recursive: true });
      await fs.symlink(physical, ancestorAlias, process.platform === "win32" ? "junction" : "dir");
      const source = path.join(ancestorAlias, "source-parent", "nested-source");
      await fs.writeFile(source, "aliased original", { mode: 0o600 });
      const result = await publishFileExclusive({ sourcePath: source, targetPath: target, strategy: "rename-noreplace" });
      expect(result).toMatchObject({ method: "hardlink", sourceConsumed: true });
      expect(await fs.readFile(target, "utf8")).toBe("aliased original");
      expect(await fs.readdir(sourceParent)).toEqual([]);
    });

    it("preserves a source replacement after target publication", async () => {
      const { dir, source, target } = await fixture();
      __setFsSafeTestHooksForTest({
        async afterPublishTargetCreated(method) {
          expect(method).toBe("hardlink");
          await fs.rename(source, path.join(dir, "retired"));
          await fs.writeFile(source, "replacement");
        },
      });
      await expect(publishFileExclusive({ sourcePath: source, targetPath: target, strategy: "rename-noreplace" }))
        .rejects.toMatchObject({ code: "path-mismatch", details: { cleanup: "preserved", sourceConsumed: false } });
      expect(await fs.readFile(source, "utf8")).toBe("replacement");
      expect(await fs.readFile(target, "utf8")).toBe("original");
    });

    it("preserves a destination replacement without removing the source", async () => {
      const { dir, source, target } = await fixture();
      __setFsSafeTestHooksForTest({
        async afterPublishTargetCreated() {
          await fs.rename(target, path.join(dir, "published"));
          await fs.writeFile(target, "replacement");
        },
      });
      await expect(publishFileExclusive({ sourcePath: source, targetPath: target, strategy: "rename-noreplace" }))
        .rejects.toMatchObject({ code: "path-mismatch", details: { cleanup: "preserved", sourceConsumed: false } });
      expect(await fs.readFile(source, "utf8")).toBe("original");
      expect(await fs.readFile(target, "utf8")).toBe("replacement");
    });

    it.skipIf(process.platform === "win32")("retains both names when capturing the source fails", async () => {
      const { source, target } = await fixture();
      const canonicalSource = await fs.realpath(source);
      const rename = fsSync.renameSync.bind(fsSync);
      let intercepted = false;
      vi.spyOn(fsSync, "renameSync").mockImplementation((file, destination) => {
        if (file === canonicalSource) {
          intercepted = true;
          throw Object.assign(new Error("source removal denied"), { code: "EACCES" });
        }
        return rename(file, destination);
      });
      const error = await publishFileExclusive({ sourcePath: source, targetPath: target, strategy: "rename-noreplace" }).catch((value) => value);
      expect(intercepted).toBe(true);
      expect(error).toMatchObject({
        code: "helper-failed", cause: { cause: { code: "EACCES" } },
        details: { phase: "source-remove", cleanup: "preserved", sourceRecovery: { status: "indeterminate" } },
      });
      expect(error.details).not.toHaveProperty("sourceConsumed");
      expect(await fs.readFile(source, "utf8")).toBe("original");
      expect(await fs.readFile(target, "utf8")).toBe("original");
    });

    it("reports a destination replacement during final synchronization", async () => {
      const { dir, source, target } = await fixture();
      __setFsSafeTestHooksForTest({
        async beforePublishDirectorySync() {
          await fs.rename(target, path.join(dir, "published"));
          await fs.writeFile(target, "replacement");
        },
      });
      await expect(publishFileExclusive({ sourcePath: source, targetPath: target, strategy: "rename-noreplace" }))
        .rejects.toMatchObject({ code: "path-mismatch", details: { phase: "rename-verify", cleanup: "preserved", sourceConsumed: true } });
      expect(await fs.readFile(target, "utf8")).toBe("replacement");
      expect(await fs.readFile(path.join(dir, "published"), "utf8")).toBe("original");
      await expect(fs.lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
}
