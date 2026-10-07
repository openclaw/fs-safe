import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { publishFileExclusive } from "../src/durability.js";
import { configureFsSafeNative } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { loadTestNative } from "./helpers/native-probe.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const native = loadTestNative("optional");
const { tempRoot } = useRealTempDirs();
afterEach(() => {
  vi.restoreAllMocks();
  __setFsSafeTestHooksForTest(undefined);
  __resetNativeLoaderForTest();
  configureFsSafeNative({ mode: "auto" });
});

async function fixture() {
  const directory = await tempRoot("fs-safe-publish-fallback-");
  const sourcePath = path.join(directory, "source");
  await fs.mkdir(path.join(directory, "payload"));
  const targetPath = path.join(directory, "payload", "0");
  await fs.writeFile(sourcePath, "complete bytes");
  return { directory, sourcePath, targetPath };
}

describe.skipIf(!native)("native rename publication", () => {
  it("omits the fallback marker and preserves atomic rename collision errors", async () => {
    configureFsSafeNative({ mode: "require" });
    const f = await fixture();
    await fs.writeFile(f.targetPath, "competitor");
    await expect(publishFileExclusive({ ...f, strategy: "rename-noreplace" }))
      .rejects.toMatchObject({ code: "EEXIST" });
    expect(await fs.readFile(f.targetPath, "utf8")).toBe("competitor");
    await fs.unlink(f.targetPath);
    const result = await publishFileExclusive({ ...f, strategy: "rename-noreplace" });
    expect(result).not.toHaveProperty("fallback");
    expect(result.method).toBe("rename-noreplace");
  });
});

describe.skipIf(!native || process.platform !== "linux")("native publication fallback receipts", () => {
  function unsupported() {
    configureFsSafeNative({ mode: "auto" });
    __setNativeLoaderForTest(() => ({ ...native!, renameNoReplace() {
      throw Object.assign(new Error("renameat2 RENAME_NOREPLACE: EINVAL"), { code: "EINVAL" });
    } }));
  }

  it("syncs the source parent after unlink and then the pinned target parent", async () => {
    unsupported();
    const f = await fixture();
    const sourceParent = await fs.lstat(f.directory, { bigint: true });
    const sync = fsSync.fsyncSync;
    let sourceSynced = false;
    vi.spyOn(fsSync, "fsyncSync").mockImplementation(fd => {
      const identity = fsSync.fstatSync(fd, { bigint: true });
      if (identity.ino === sourceParent.ino && identity.dev === sourceParent.dev) {
        expect(fsSync.existsSync(f.sourcePath)).toBe(false);
        expect(fsSync.lstatSync(f.targetPath).nlink).toBe(1);
        sourceSynced = true;
      }
      sync(fd);
    });
    __setFsSafeTestHooksForTest({ beforePublishDirectorySync() { expect(sourceSynced).toBe(true); } });
    const result = await publishFileExclusive({ ...f, strategy: "rename-noreplace" });
    expect(sourceSynced).toBe(true);
    expect(result).toMatchObject({ method: "rename-noreplace", fallback: "link-unlink", directorySync: { status: "synced" } });
  });

  it.each(["rollback", "preserve"] as const)("preserves completed publication on %s sync failure", async onSyncFailure => {
    unsupported();
    const f = await fixture();
    __setFsSafeTestHooksForTest({ beforePublishDirectorySync() { throw Object.assign(new Error("sync failed"), { code: "EIO" }); } });
    await expect(publishFileExclusive({ ...f, strategy: "rename-noreplace", onSyncFailure })).rejects.toMatchObject({
      code: "helper-failed", details: { phase: "directory-sync", fallback: "link-unlink", publication: "published",
        sourceRemoval: "removed", targetCreated: true, cleanup: "preserved", directorySync: { status: "failed", code: "EIO" } },
    });
    expect(await fs.readFile(f.targetPath, "utf8")).toBe("complete bytes");
    await expect(fs.lstat(f.sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not retry an ambiguous rename failure", async () => {
    const f = await fixture();
    const fallback = vi.fn(native!.moveNoReplaceFallback);
    __setNativeLoaderForTest(() => ({ ...native!, moveNoReplaceFallback: fallback, renameNoReplace() {
      throw Object.assign(new Error("uncertain rename"), { code: "EIO" });
    } }));
    await expect(publishFileExclusive({ ...f, strategy: "rename-noreplace" })).rejects.toMatchObject({ code: "EIO" });
    expect(fallback).not.toHaveBeenCalled();
    expect(await fs.readFile(f.sourcePath, "utf8")).toBe("complete bytes");
    await expect(fs.lstat(f.targetPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
