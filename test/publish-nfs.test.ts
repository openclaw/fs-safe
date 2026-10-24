import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { root } from "../src/root.js";
import { publishFileExclusive } from "../src/publish-file.js";
import { configureFsSafeNative } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
  __resetNativeLoaderForTest();
  configureFsSafeNative({ mode: "auto" });
});

function deferOpenUnlinks(removeOnClose = true) {
  const open = fs.open.bind(fs);
  const unlink = fsSync.unlinkSync.bind(fsSync);
  const openPaths = new Set<string>();
  const deferred = new Map<string, string>();
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    const filename = String(args[0]);
    openPaths.add(filename);
    const close = handle.close.bind(handle);
    handle.close = async () => {
      openPaths.delete(filename);
      await close();
      const hidden = deferred.get(filename);
      if (hidden && removeOnClose) { unlink(hidden); deferred.delete(filename); }
    };
    return handle;
  });
  vi.spyOn(fsSync, "unlinkSync").mockImplementation(filename => {
    const name = String(filename);
    if (openPaths.has(name)) {
      const hidden = `${name}.nfs-test`;
      fsSync.renameSync(name, hidden);
      deferred.set(name, hidden);
    } else unlink(filename);
  });
}

describe.skipIf(process.platform === "win32")("NFS publication descriptor lifetime", () => {
  it.each(["create", "copy"])("settles the staged %s descriptor before unlink", async operation => {
    const directory = await tempRoot("fs-safe-nfs-stage-");
    configureFsSafeNative({ mode: "off" });
    const workspace = await root(directory);
    await fs.writeFile(path.join(directory, "source"), "complete payload");
    deferOpenUnlinks();
    if (operation === "create") await workspace.create("target", "complete payload", { atomic: true });
    else await workspace.copyIn("target", path.join(directory, "source"), { overwrite: false });
    expect(await fs.readFile(path.join(directory, "target"), "utf8")).toBe("complete payload");
    expect((await fs.lstat(path.join(directory, "target"))).nlink).toBe(1);
    expect((await fs.readdir(directory)).sort()).toEqual(["source", "target"]);
  });

  it.each([0, 0o200])("retains restrictive mode %i during descriptor handoff", async mode => {
    const directory = await tempRoot("fs-safe-nfs-mode-");
    configureFsSafeNative({ mode: "off" });
    const workspace = await root(directory);
    if (process.platform === "linux") deferOpenUnlinks();
    await workspace.create("target", "complete payload", { atomic: true, mode });
    const target = path.join(directory, "target");
    const stat = await fs.stat(target);
    expect(stat.mode & 0o777).toBe(mode);
    expect(stat.nlink).toBe(1);
    await fs.chmod(target, 0o600);
    expect(await fs.readFile(target, "utf8")).toBe("complete payload");
    expect(await fs.readdir(directory)).toEqual(["target"]);
  });

  it.each(["deferred", "unlink-stale-after", "replaced", "third-link", "collision", "link-unsupported", "unlink-failure"])("verifies %s native fallback publication after settling the source", async fault => {
    const directory = await tempRoot("fs-safe-nfs-publish-");
    const sourcePath = path.join(directory, "source");
    const targetPath = path.join(directory, "target");
    await fs.writeFile(sourcePath, "complete payload");
    if (fault === "collision") await fs.writeFile(targetPath, "winner");
    const expected = await fs.stat(sourcePath, { bigint: true });
    // NFS cleanup need not finish when close returns: avoid creating the hidden link.
    deferOpenUnlinks(false);
    Object.defineProperty(process, "platform", { value: "linux" });
    const publishLink = () => {
      fsSync.linkSync(sourcePath, targetPath);
      if (fault === "replaced") {
        fsSync.unlinkSync(targetPath);
        fsSync.writeFileSync(targetPath, "replacement");
      }
      if (fault === "third-link") fsSync.linkSync(targetPath, path.join(directory, "third"));
    };
    __setNativeLoaderForTest(() => ({
      closeOwnedFd: fsSync.closeSync,
      renameNoReplace() { throw Object.assign(new Error("unsupported"), { code: "EINVAL" }); },
      linkBeneath() {
        if (fault === "link-unsupported") throw Object.assign(new Error("link denied"), { code: "EPERM" });
        publishLink();
      },
      removeStagedFile() {
        if (fault === "unlink-failure") throw Object.assign(new Error("unlink denied"), { code: "EACCES" });
        fsSync.unlinkSync(sourcePath);
        if (fault === "unlink-stale-after") throw Object.assign(new Error("stale after unlink"), { code: "ESTALE" });
        return "removed";
      },
      moveNoReplaceFallback() {
        publishLink();
        fsSync.unlinkSync(sourcePath);
        throw Object.assign(new Error("target link count changed after unlink"), { code: "FS_SAFE_INTERNAL_MOVE_PUBLISHED" });
      },
    }));
    const result = publishFileExclusive({ sourcePath, targetPath, strategy: "rename-noreplace", expectedSourceIdentity: expected });
    if (fault === "link-unsupported") {
      await expect(result).rejects.toMatchObject({ code: "helper-unavailable", message: expect.stringMatching(/RENAME_NOREPLACE.*linkat/), details: { fallbackCapability: "linkat" } });
      expect(await fs.readFile(sourcePath, "utf8")).toBe("complete payload");
      await expect(fs.lstat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
      return;
    }
    if (fault === "collision") {
      await expect(result).rejects.toMatchObject({ code: "already-exists" });
    } else if (fault === "unlink-failure") {
      await expect(result).rejects.toMatchObject({ code: "helper-failed", message: expect.stringContaining("source still linked"), details: { publication: "published", cleanup: "preserved", sourceRemoval: "still-linked" } });
    } else if (fault !== "deferred" && fault !== "unlink-stale-after") {
      await expect(result).rejects.toMatchObject({ details: { publication: "published", cleanup: "preserved" } });
    } else {
      await expect(result).resolves.toMatchObject({ method: "rename-noreplace", fallback: "link-unlink", exactIdentity: { dev: expected.dev, ino: expected.ino } });
      expect((await fs.stat(targetPath)).nlink).toBe(1);
      expect(await fs.readdir(directory)).toEqual(["target"]);
    }
    expect(await fs.readFile(targetPath, "utf8")).toBe(fault === "collision" ? "winner" : fault === "replaced" ? "replacement" : "complete payload");
  });
});
